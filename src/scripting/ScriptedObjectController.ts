/**
 * ScriptedObjectController — Per-zone manager for scripted objects.
 *
 * Follows the FloraManager pattern: one instance per zone, with an
 * `update(deltaTime, now)` method called from the main tick loop.
 *
 * Responsibilities:
 *   - Compile/destroy LuaVM instances per object
 *   - Fire event callbacks (onTouch, onNearby, onHeartbeat, onTimer)
 *   - Support per-verb scripts (ObjectVerbScript) alongside legacy scriptSource
 *   - Track error counts and auto-deactivate broken scripts
 *   - Flush dirty state to the database periodically
 */

import { LuaVM } from './LuaVM';
import { installSandboxAPI, type SandboxRateLimits } from './SandboxAPI';
import { ScriptedObjectService } from './ScriptedObjectService';
import { ObjectVerbScriptService } from './ObjectVerbScriptService';
import { logger } from '@/utils/logger';

// ── Constants ───────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_ERRORS_BEFORE_DEACTIVATE = 5;
const STATE_FLUSH_INTERVAL_MS = 60_000;
const TOUCH_RANGE_M = 1.524; // 5 feet
const NEARBY_RANGE_M = 6.096; // 20 feet (say range)

// ── Types ───────────────────────────────────────────────────────────────────

interface ScriptedObjectInstance {
  id: string;
  name: string;
  description?: string;
  position: { x: number; y: number; z: number };
  ownerCharacterId: string;
  scriptSource: string; // Legacy single-script (still supported)

  // Per-verb scripts loaded from ObjectVerbScript table
  verbSources: Map<string, string>; // verb name → Lua source

  vm: LuaVM | null;
  rateLimits: SandboxRateLimits | null;
  isActive: boolean;
  errorCount: number;

  // Persistent key/value state (flushed to DB periodically)
  stateData: Record<string, string | number | boolean>;
  stateDirty: boolean;
  lastStateFlushAt: number;

  // Timer (one active timer per object)
  timerSeconds: number | null;
  timerLastFiredAt: number;

  // Proximity tracking (previous tick entity id sets)
  previousTouchIds: Set<string>;
  previousNearbyIds: Set<string>;
}

/** Callbacks wired by DistributedWorldManager when creating the controller. */
export interface ScriptedObjectControllerCallbacks {
  onSay: (objectId: string, objectName: string, message: string, position: { x: number; y: number; z: number }) => void;
  onEmote: (objectId: string, objectName: string, message: string, position: { x: number; y: number; z: number }) => void;
  onNotifyOwner: (characterId: string, message: string) => void;
  getNearbyEntities: (position: { x: number; y: number; z: number }, rangeMeters: number) => Array<{ id: string; name: string; type: string; distance: number }>;
  getTimeOfDay: () => number;
  getWeather: () => string;
  getZoneInfo: () => { id: string; name: string; contentRating: string };
}

export class ScriptedObjectController {
  private instances = new Map<string, ScriptedObjectInstance>();
  private zoneId: string;
  private cb: ScriptedObjectControllerCallbacks;
  private lastHeartbeatAt = 0;

  constructor(zoneId: string, callbacks: ScriptedObjectControllerCallbacks) {
    this.zoneId = zoneId;
    this.cb = callbacks;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /** Load all scripted objects for this zone from the database, including verb scripts. */
  async loadFromDatabase(): Promise<void> {
    const objects = await ScriptedObjectService.findByZone(this.zoneId);
    for (const obj of objects) {
      // Load per-verb scripts for this object
      const verbScripts = await ObjectVerbScriptService.findByObject(obj.id);
      const verbSources = new Map<string, string>();
      for (const vs of verbScripts) {
        if (vs.source.trim().length > 0) {
          verbSources.set(vs.verb, vs.source);
        }
      }

      this.registerObject({
        id: obj.id,
        name: obj.name,
        description: obj.description ?? undefined,
        position: { x: obj.positionX, y: obj.positionY, z: obj.positionZ },
        ownerCharacterId: obj.ownerCharacterId,
        scriptSource: obj.scriptSource,
        verbSources,
        stateData: (typeof obj.stateData === 'object' && obj.stateData !== null)
          ? obj.stateData as Record<string, string | number | boolean>
          : {},
        isActive: obj.isActive,
        errorCount: obj.errorCount,
      });
    }
    if (objects.length > 0) {
      logger.info({ zoneId: this.zoneId, count: objects.length }, 'Loaded scripted objects');
    }
  }

  /** Register a single scripted object and compile its VM. */
  registerObject(data: {
    id: string;
    name: string;
    description?: string;
    position: { x: number; y: number; z: number };
    ownerCharacterId: string;
    scriptSource: string;
    verbSources?: Map<string, string>;
    stateData: Record<string, string | number | boolean>;
    isActive: boolean;
    errorCount: number;
  }): void {
    const now = Date.now();
    const instance: ScriptedObjectInstance = {
      id: data.id,
      name: data.name,
      description: data.description,
      position: data.position,
      ownerCharacterId: data.ownerCharacterId,
      scriptSource: data.scriptSource,
      verbSources: data.verbSources ?? new Map(),
      vm: null,
      rateLimits: null,
      isActive: data.isActive,
      errorCount: data.errorCount,
      stateData: { ...data.stateData },
      stateDirty: false,
      lastStateFlushAt: now,
      timerSeconds: null,
      timerLastFiredAt: now,
      previousTouchIds: new Set(),
      previousNearbyIds: new Set(),
    };

    const hasScript = data.scriptSource.trim().length > 0 || instance.verbSources.size > 0;
    if (instance.isActive && hasScript) {
      this.compileVM(instance);
    }

    this.instances.set(data.id, instance);
  }

  // ── VM compilation ──────────────────────────────────────────────────────

  /**
   * Build the combined Lua source from legacy scriptSource + all verb scripts.
   * Each verb script defines a function named after the verb.
   */
  private buildCombinedSource(instance: ScriptedObjectInstance): string {
    const parts: string[] = [];

    // Legacy script source (may define onHeartbeat, onTouch, etc.)
    if (instance.scriptSource.trim().length > 0) {
      parts.push(instance.scriptSource);
    }

    // Per-verb scripts — each is an independent chunk that defines its function
    for (const [_verb, source] of instance.verbSources) {
      if (source.trim().length > 0) {
        parts.push(source);
      }
    }

    return parts.join('\n\n');
  }

  private compileVM(instance: ScriptedObjectInstance): void {
    try {
      instance.vm?.destroy();
      instance.vm = null;
      instance.rateLimits = null;

      const combinedSource = this.buildCombinedSource(instance);
      if (combinedSource.trim().length === 0) return;

      const vm = new LuaVM({ objectId: instance.id, scriptSource: combinedSource });

      const rateLimits = installSandboxAPI(vm, {
        objectId: instance.id,
        objectName: instance.name,
        position: instance.position,
        getNearbyEntities: (rangeFt) => {
          const rangeM = rangeFt * 0.3048;
          return this.cb.getNearbyEntities(instance.position, rangeM);
        },
        getTimeOfDay: () => this.cb.getTimeOfDay(),
        getWeather: () => this.cb.getWeather(),
        getZoneInfo: () => this.cb.getZoneInfo(),
        getState: (key) => instance.stateData[key],
        setState: (key, value) => {
          instance.stateData[key] = value;
          instance.stateDirty = true;
        },
        getStateKeyCount: () => Object.keys(instance.stateData).length,
      }, {
        onSay: (msg) => this.cb.onSay(instance.id, instance.name, msg, instance.position),
        onEmote: (msg) => this.cb.onEmote(instance.id, instance.name, msg, instance.position),
        onSetTimer: (seconds) => {
          instance.timerSeconds = seconds;
          instance.timerLastFiredAt = Date.now();
        },
      });

      instance.vm = vm;
      instance.rateLimits = rateLimits;
    } catch (err: any) {
      logger.warn({ objectId: instance.id, error: err.message }, 'Failed to compile scripted object');
      this.handleError(instance, err);
    }
  }

  // ── Tick loop ─────────────────────────────────────────────────────────

  /** Called every tick from DistributedWorldManager.update(). */
  update(_deltaTime: number, now: number): void {
    const isHeartbeat = (now - this.lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS;
    if (isHeartbeat) {
      this.lastHeartbeatAt = now;
    }

    for (const instance of this.instances.values()) {
      if (!instance.isActive || !instance.vm) continue;

      try {
        // ── onHeartbeat (every 5s) ──
        if (isHeartbeat) {
          // Reset rate limits
          if (instance.rateLimits) {
            instance.rateLimits.sayCount = 0;
            instance.rateLimits.emoteCount = 0;
          }
          this.safeCall(instance, 'onHeartbeat');
        }

        // ── onTouch / onNearby (delta-based) ──
        this.processProximityEvents(instance);

        // ── onTimer ──
        if (instance.timerSeconds !== null) {
          const timerMs = instance.timerSeconds * 1000;
          if ((now - instance.timerLastFiredAt) >= timerMs) {
            instance.timerLastFiredAt = now;
            this.safeCall(instance, 'onTimer');
          }
        }
      } catch (err: any) {
        this.handleError(instance, err);
      }
    }

    // ── Periodic state flush ──
    this.flushDirtyState(now);
  }

  // ── Proximity event detection ─────────────────────────────────────────

  private processProximityEvents(instance: ScriptedObjectInstance): void {
    // Get entities in touch range and nearby (say) range
    const touchEntities = this.cb.getNearbyEntities(instance.position, TOUCH_RANGE_M);
    const nearbyEntities = this.cb.getNearbyEntities(instance.position, NEARBY_RANGE_M);

    // Build current ID sets
    const currentTouchIds = new Set(touchEntities.map(e => e.id));
    const currentNearbyIds = new Set(nearbyEntities.map(e => e.id));

    // Fire onTouch for entities that just entered touch range
    for (const entity of touchEntities) {
      if (!instance.previousTouchIds.has(entity.id)) {
        this.safeCall(instance, 'onTouch', {
          id: entity.id,
          name: entity.name,
          type: entity.type,
        });
      }
    }

    // Fire onNearby when the nearby roster changes (enter or leave)
    const nearbyChanged = currentNearbyIds.size !== instance.previousNearbyIds.size
      || [...currentNearbyIds].some(id => !instance.previousNearbyIds.has(id))
      || [...instance.previousNearbyIds].some(id => !currentNearbyIds.has(id));

    if (nearbyChanged) {
      const entitiesArg = nearbyEntities.map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        distance: e.distance,
      }));
      this.safeCallWithArray(instance, 'onNearby', entitiesArg);
    }

    instance.previousTouchIds = currentTouchIds;
    instance.previousNearbyIds = currentNearbyIds;
  }

  // ── Safe Lua calls ────────────────────────────────────────────────────

  private safeCall(instance: ScriptedObjectInstance, funcName: string, args?: Record<string, unknown>): void {
    try {
      instance.vm!.callFunction(funcName, args);
    } catch (err: any) {
      this.handleError(instance, err);
    }
  }

  private safeCallWithArray(instance: ScriptedObjectInstance, funcName: string, items: Record<string, unknown>[]): void {
    try {
      instance.vm!.callFunctionWithArray(funcName, items);
    } catch (err: any) {
      this.handleError(instance, err);
    }
  }

  // ── Error handling ────────────────────────────────────────────────────

  private handleError(instance: ScriptedObjectInstance, err: Error): void {
    instance.errorCount++;
    logger.warn(
      { objectId: instance.id, objectName: instance.name, error: err.message, errorCount: instance.errorCount },
      'Scripted object error',
    );
    void ScriptedObjectService.recordError(instance.id, err.message);

    if (instance.errorCount >= MAX_ERRORS_BEFORE_DEACTIVATE) {
      instance.isActive = false;
      instance.vm?.destroy();
      instance.vm = null;
      instance.rateLimits = null;
      void ScriptedObjectService.deactivate(instance.id);
      logger.warn({ objectId: instance.id }, 'Scripted object auto-deactivated (too many errors)');
      this.cb.onNotifyOwner(
        instance.ownerCharacterId,
        `Your scripted object "${instance.name}" has been deactivated after ${MAX_ERRORS_BEFORE_DEACTIVATE} errors. Last error: ${err.message}. Use /object activate to re-enable after fixing the script.`,
      );
    }
  }

  // ── State persistence ─────────────────────────────────────────────────

  private flushDirtyState(now: number): void {
    for (const instance of this.instances.values()) {
      if (instance.stateDirty && (now - instance.lastStateFlushAt) >= STATE_FLUSH_INTERVAL_MS) {
        void ScriptedObjectService.updateState(instance.id, instance.stateData);
        instance.stateDirty = false;
        instance.lastStateFlushAt = now;
      }
    }
  }

  /** Flush all dirty state immediately (call on shutdown). */
  async flushAllState(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const instance of this.instances.values()) {
      if (instance.stateDirty) {
        promises.push(ScriptedObjectService.updateState(instance.id, instance.stateData));
        instance.stateDirty = false;
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  // ── Public API for command handlers ───────────────────────────────────

  /** Remove a scripted object (when picked up). */
  removeObject(objectId: string): void {
    const instance = this.instances.get(objectId);
    if (instance) {
      instance.vm?.destroy();
      this.instances.delete(objectId);
    }
  }

  /** Recompile all scripts for an object (legacy single-source). */
  recompileObject(objectId: string, newSource: string): { success: boolean; error?: string } {
    const instance = this.instances.get(objectId);
    if (!instance) return { success: false, error: 'Object not found in this zone.' };

    instance.scriptSource = newSource;
    instance.errorCount = 0;
    instance.isActive = true;

    const hasScript = newSource.trim().length > 0 || instance.verbSources.size > 0;
    if (!hasScript) {
      instance.vm?.destroy();
      instance.vm = null;
      instance.rateLimits = null;
      return { success: true };
    }

    try {
      this.compileVM(instance);
      if (!instance.vm) {
        return { success: false, error: 'Compilation failed.' };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Update a single verb's source and recompile the entire VM.
   * Used by the editor save flow.
   */
  recompileVerb(objectId: string, verb: string, newSource: string): { success: boolean; error?: string } {
    const instance = this.instances.get(objectId);
    if (!instance) return { success: false, error: 'Object not found in this zone.' };

    // Update verb source in memory
    if (newSource.trim().length === 0) {
      instance.verbSources.delete(verb);
    } else {
      instance.verbSources.set(verb, newSource);
    }

    instance.errorCount = 0;
    instance.isActive = true;

    const hasScript = instance.scriptSource.trim().length > 0 || instance.verbSources.size > 0;
    if (!hasScript) {
      instance.vm?.destroy();
      instance.vm = null;
      instance.rateLimits = null;
      return { success: true };
    }

    try {
      this.compileVM(instance);
      if (!instance.vm) {
        return { success: false, error: 'Compilation failed.' };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Compile-check a verb source without persisting or hot-swapping.
   * Used by the editor "Compile" button.
   * Returns parsed error info.
   */
  checkCompileVerb(objectId: string, verb: string, source: string): {
    success: boolean;
    errors: Array<{ line?: number; col?: number; message: string }>;
    warnings: Array<{ line?: number; message: string }>;
  } {
    const instance = this.instances.get(objectId);

    // Build a temporary combined source with the new verb source
    const tempVerbSources = new Map(instance?.verbSources ?? new Map());
    if (source.trim().length > 0) {
      tempVerbSources.set(verb, source);
    } else {
      tempVerbSources.delete(verb);
    }

    const parts: string[] = [];
    if (instance?.scriptSource && instance.scriptSource.trim().length > 0) {
      parts.push(instance.scriptSource);
    }
    for (const [, src] of tempVerbSources) {
      if (src.trim().length > 0) parts.push(src);
    }
    const combined = parts.join('\n\n');

    if (combined.trim().length === 0) {
      return { success: true, errors: [], warnings: [] };
    }

    const warnings: Array<{ line?: number; message: string }> = [];

    // Check for schedule() usage warnings
    const scheduleMatches = source.matchAll(/schedule\s*\(/g);
    for (const match of scheduleMatches) {
      const lineNum = source.substring(0, match.index).split('\n').length;
      warnings.push({ line: lineNum, message: 'schedule() — max 3 pending callbacks per object' });
    }

    try {
      // Try to compile in a temporary VM
      const tempVm = new LuaVM({ objectId: objectId || 'compile-check', scriptSource: combined });
      tempVm.destroy();
      return { success: true, errors: [], warnings };
    } catch (err: any) {
      const errors = this.parseCompileErrors(err.message);
      return { success: false, errors, warnings };
    }
  }

  /**
   * Invoke a custom verb on an object (player-triggered).
   * E.g. player does "/use torch light" → callVerb("torch-id", "light", actorContext)
   */
  callVerb(objectId: string, verb: string, actorContext?: Record<string, unknown>): {
    success: boolean;
    error?: string;
  } {
    const instance = this.instances.get(objectId);
    if (!instance) return { success: false, error: 'Object not found.' };
    if (!instance.isActive || !instance.vm) return { success: false, error: 'Object is not active.' };

    // Check if this verb function exists
    try {
      const existed = instance.vm.callFunction(verb, actorContext);
      if (!existed) {
        return { success: false, error: `Verb "${verb}" is not defined on this object.` };
      }
      return { success: true };
    } catch (err: any) {
      this.handleError(instance, err);
      return { success: false, error: `Runtime error in ${verb}: ${err.message}` };
    }
  }

  /** Get the list of registered verb names for an object. */
  getVerbList(objectId: string): string[] {
    const instance = this.instances.get(objectId);
    if (!instance) return [];
    return Array.from(instance.verbSources.keys());
  }

  /** Deactivate without removing. */
  deactivateObject(objectId: string): void {
    const instance = this.instances.get(objectId);
    if (instance) {
      instance.isActive = false;
      instance.vm?.destroy();
      instance.vm = null;
      instance.rateLimits = null;
    }
  }

  /** Re-activate a deactivated object. */
  activateObject(objectId: string): { success: boolean; error?: string } {
    const instance = this.instances.get(objectId);
    if (!instance) return { success: false, error: 'Object not found in this zone.' };

    instance.isActive = true;
    instance.errorCount = 0;

    const hasScript = instance.scriptSource.trim().length > 0 || instance.verbSources.size > 0;
    if (hasScript) {
      this.compileVM(instance);
      if (!instance.vm) {
        return { success: false, error: 'Script failed to compile on activation.' };
      }
    }
    return { success: true };
  }

  /** Get an instance for inspection. */
  getInstance(objectId: string): ScriptedObjectInstance | undefined {
    return this.instances.get(objectId);
  }

  /** Get count of active instances in this zone. */
  getActiveCount(): number {
    let count = 0;
    for (const inst of this.instances.values()) {
      if (inst.isActive) count++;
    }
    return count;
  }

  /** Destroy all VMs (zone shutdown). */
  async destroy(): Promise<void> {
    await this.flushAllState();
    for (const instance of this.instances.values()) {
      instance.vm?.destroy();
    }
    this.instances.clear();
  }

  // ── Error parsing ─────────────────────────────────────────────────────

  /** Parse fengari compile error messages into structured error objects. */
  private parseCompileErrors(errorMsg: string): Array<{ line?: number; col?: number; message: string }> {
    // Fengari errors look like: "Lua compile error: [string "..."]:4: unexpected symbol near 'end'"
    // or: "Lua init error: [string "..."]:7: attempt to index nil value"
    const errors: Array<{ line?: number; col?: number; message: string }> = [];

    // Strip the "Lua compile error: " or "Lua init error: " prefix
    const cleaned = errorMsg
      .replace(/^Lua (compile|init|runtime) error(?: in \w+)?: /, '');

    // Try to parse line numbers from fengari format: [string "..."]:LINE: MESSAGE
    const lineMatch = cleaned.match(/\[string ".*?"\]:(\d+):\s*(.+)/);
    if (lineMatch) {
      errors.push({
        line: parseInt(lineMatch[1], 10),
        message: lineMatch[2],
      });
    } else {
      errors.push({ message: cleaned });
    }

    return errors;
  }
}
