/**
 * SandboxAPI — Installs the `object.*` and `world.*` API surfaces into a LuaVM.
 *
 * All Lua ↔ JS communication goes through these bindings.  Rate limits,
 * state-key caps, message truncation, and timer minimums are enforced here.
 */

import * as fengari from 'fengari';
import { LuaVM } from './LuaVM';

const { lua, to_luastring } = fengari;

// ── Constants ───────────────────────────────────────────────────────────────
const MAX_SAY_PER_HEARTBEAT = 2;
const MAX_EMOTE_PER_HEARTBEAT = 2;
const MIN_TIMER_INTERVAL_S = 5;
const MAX_STATE_KEYS = 64;
const MAX_MESSAGE_LENGTH = 256;
const MAX_NEARBY_RANGE_FT = 150;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SandboxCallbacks {
  onSay: (message: string) => void;
  onEmote: (message: string) => void;
  onSetTimer: (seconds: number) => void;
}

export interface SandboxContext {
  objectId: string;
  objectName: string;
  position: { x: number; y: number; z: number };
  // Data providers (called lazily from Lua)
  getNearbyEntities: (rangeFt: number) => Array<{ id: string; name: string; type: string; distance: number }>;
  getTimeOfDay: () => number;
  getWeather: () => string;
  getZoneInfo: () => { id: string; name: string; contentRating: string };
  // State access (backed by in-memory map on the controller instance)
  getState: (key: string) => string | number | boolean | undefined;
  setState: (key: string, value: string | number | boolean) => void;
  getStateKeyCount: () => number;
}

export interface SandboxRateLimits {
  sayCount: number;
  emoteCount: number;
}

/**
 * Install the full sandbox API onto a LuaVM.  Returns a handle to the
 * rate-limit counters so the controller can reset them each heartbeat.
 */
export function installSandboxAPI(
  vm: LuaVM,
  ctx: SandboxContext,
  callbacks: SandboxCallbacks,
): SandboxRateLimits {
  const limits: SandboxRateLimits = { sayCount: 0, emoteCount: 0 };

  // ── object.id / object.name / object.position (read-only) ─────────────
  vm.setGlobalTableField('object', 'id', ctx.objectId);
  vm.setGlobalTableField('object', 'name', ctx.objectName);
  vm.setGlobalTablePosition('object', 'position', ctx.position.x, ctx.position.y, ctx.position.z);

  // ── object.say(text) ──────────────────────────────────────────────────
  vm.registerTableFunction('object', 'say', (Lx: any) => {
    if (limits.sayCount >= MAX_SAY_PER_HEARTBEAT) return 0;
    const raw = lua.lua_tojsstring(Lx, 1) ?? '';
    const msg = raw.substring(0, MAX_MESSAGE_LENGTH);
    if (msg.length > 0) {
      limits.sayCount++;
      callbacks.onSay(msg);
    }
    return 0;
  });

  // ── object.emote(text) ────────────────────────────────────────────────
  vm.registerTableFunction('object', 'emote', (Lx: any) => {
    if (limits.emoteCount >= MAX_EMOTE_PER_HEARTBEAT) return 0;
    const raw = lua.lua_tojsstring(Lx, 1) ?? '';
    const msg = raw.substring(0, MAX_MESSAGE_LENGTH);
    if (msg.length > 0) {
      limits.emoteCount++;
      callbacks.onEmote(msg);
    }
    return 0;
  });

  // ── object.timer(seconds, callbackName) ───────────────────────────────
  vm.registerTableFunction('object', 'timer', (Lx: any) => {
    const seconds = lua.lua_tonumber(Lx, 1) ?? MIN_TIMER_INTERVAL_S;
    const clamped = Math.max(MIN_TIMER_INTERVAL_S, seconds);
    callbacks.onSetTimer(clamped);
    return 0;
  });

  // ── object.state.get(key) ─────────────────────────────────────────────
  vm.registerNestedFunction('object', 'state', 'get', (Lx: any) => {
    const key = lua.lua_tojsstring(Lx, 1);
    if (!key) { lua.lua_pushnil(Lx); return 1; }
    const val = ctx.getState(key);
    if (val === undefined) {
      lua.lua_pushnil(Lx);
    } else if (typeof val === 'number') {
      lua.lua_pushnumber(Lx, val);
    } else if (typeof val === 'string') {
      lua.lua_pushstring(Lx, to_luastring(val));
    } else if (typeof val === 'boolean') {
      lua.lua_pushboolean(Lx, val ? 1 : 0);
    } else {
      lua.lua_pushnil(Lx);
    }
    return 1;
  });

  // ── object.state.set(key, value) ──────────────────────────────────────
  vm.registerNestedFunction('object', 'state', 'set', (Lx: any) => {
    const key = lua.lua_tojsstring(Lx, 1);
    if (!key) return 0;

    const luaType = lua.lua_type(Lx, 2);
    let value: string | number | boolean;
    if (luaType === lua.LUA_TNUMBER) {
      value = lua.lua_tonumber(Lx, 2);
    } else if (luaType === lua.LUA_TSTRING) {
      value = lua.lua_tojsstring(Lx, 2);
    } else if (luaType === lua.LUA_TBOOLEAN) {
      value = lua.lua_toboolean(Lx, 2);
    } else {
      return 0; // only string/number/boolean allowed
    }

    // Enforce 64-key limit (allow overwriting existing keys)
    const existingVal = ctx.getState(key);
    if (existingVal === undefined && ctx.getStateKeyCount() >= MAX_STATE_KEYS) {
      return 0; // silently refuse new key
    }

    ctx.setState(key, value);
    return 0;
  });

  // ── world.nearby(radius) ──────────────────────────────────────────────
  vm.registerTableFunction('world', 'nearby', (Lx: any) => {
    const radiusFt = Math.min(lua.lua_tonumber(Lx, 1) ?? 20, MAX_NEARBY_RANGE_FT);
    const entities = ctx.getNearbyEntities(radiusFt);

    // Return as Lua array of tables
    lua.lua_newtable(Lx);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      lua.lua_newtable(Lx);
      lua.lua_pushstring(Lx, to_luastring(e.id));
      lua.lua_setfield(Lx, -2, to_luastring('id'));
      lua.lua_pushstring(Lx, to_luastring(e.name));
      lua.lua_setfield(Lx, -2, to_luastring('name'));
      lua.lua_pushstring(Lx, to_luastring(e.type));
      lua.lua_setfield(Lx, -2, to_luastring('type'));
      lua.lua_pushnumber(Lx, e.distance);
      lua.lua_setfield(Lx, -2, to_luastring('distance'));
      lua.lua_rawseti(Lx, -2, i + 1);
    }
    return 1;
  });

  // ── world.time() ──────────────────────────────────────────────────────
  vm.registerTableFunction('world', 'time', (Lx: any) => {
    lua.lua_pushnumber(Lx, ctx.getTimeOfDay());
    return 1;
  });

  // ── world.weather() ───────────────────────────────────────────────────
  vm.registerTableFunction('world', 'weather', (Lx: any) => {
    lua.lua_pushstring(Lx, to_luastring(ctx.getWeather()));
    return 1;
  });

  // ── world.zone() ─────────────────────────────────────────────────────
  vm.registerTableFunction('world', 'zone', (Lx: any) => {
    const info = ctx.getZoneInfo();
    lua.lua_newtable(Lx);
    lua.lua_pushstring(Lx, to_luastring(info.id));
    lua.lua_setfield(Lx, -2, to_luastring('id'));
    lua.lua_pushstring(Lx, to_luastring(info.name));
    lua.lua_setfield(Lx, -2, to_luastring('name'));
    lua.lua_pushstring(Lx, to_luastring(info.contentRating));
    lua.lua_setfield(Lx, -2, to_luastring('contentRating'));
    return 1;
  });

  return limits;
}
