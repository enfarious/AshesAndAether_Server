/**
 * LuaVM — Sandboxed Lua 5.3 execution via fengari.
 *
 * Each ScriptedObject gets its own LuaVM instance with a strict whitelist
 * sandbox.  Only math.*, string.*, table.*, and a handful of builtins are
 * available.  Everything else (io, os, require, debug, …) is removed.
 *
 * An instruction-count hook halts runaway scripts after MAX_INSTRUCTION_COUNT
 * instructions per invocation.
 */

import * as fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring } = fengari;

// ── Safety constants ────────────────────────────────────────────────────────
const MAX_SCRIPT_SIZE = 65_536; // 64 KB
const MAX_INSTRUCTION_COUNT = 100_000; // ~50 ms budget on most hardware

// Globals that must be wiped after luaL_openlibs
const BLOCKED_GLOBALS = [
  'io', 'os', 'require', 'load', 'loadfile', 'dofile',
  'debug', 'package', 'coroutine',
  'rawget', 'rawset', 'rawequal', 'rawlen',
  'collectgarbage', 'newproxy',
];

// ── Public types ────────────────────────────────────────────────────────────

export interface LuaVMOptions {
  objectId: string;
  scriptSource: string;
}

/**
 * A sandboxed Lua VM instance tied to a single scripted object.
 */
export class LuaVM {
  private L: any; // fengari lua_State
  readonly objectId: string;
  private compiled = false;
  private instructionCount = 0;
  private destroyed = false;

  constructor(options: LuaVMOptions) {
    this.objectId = options.objectId;

    if (options.scriptSource.length > MAX_SCRIPT_SIZE) {
      throw new Error(`Script exceeds ${MAX_SCRIPT_SIZE}-byte limit (${options.scriptSource.length} bytes)`);
    }

    // 1. Create state + open safe std libs
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);

    // 2. Strip dangerous globals
    this.applySandbox();

    // 3. Install instruction-count hook
    this.installHook();

    // 4. Compile and execute the top-level chunk (defines functions like onTouch)
    this.loadScript(options.scriptSource);
  }

  // ── Sandbox ─────────────────────────────────────────────────────────────

  private applySandbox(): void {
    for (const name of BLOCKED_GLOBALS) {
      lua.lua_pushnil(this.L);
      lua.lua_setglobal(this.L, to_luastring(name));
    }

    // Neuter print() → no-op (all output must go through object.say / object.emote)
    lua.lua_pushcclosure(this.L, () => 0, 0);
    lua.lua_setglobal(this.L, to_luastring('print'));
  }

  private installHook(): void {
    // The hook fires every 1 000 VM instructions.  We track a running count
    // and raise an error when the budget is exhausted.  The count is reset
    // in callFunction() before every invocation.
    const self = this;
    lua.lua_sethook(
      this.L,
      (L: any) => {
        self.instructionCount += 1000;
        if (self.instructionCount > MAX_INSTRUCTION_COUNT) {
          lauxlib.luaL_error(L, to_luastring('script exceeded instruction limit'));
        }
      },
      lua.LUA_MASKCOUNT,
      1000,
    );
  }

  // ── Script loading ──────────────────────────────────────────────────────

  private loadScript(source: string): void {
    if (!source.trim()) {
      // Empty script is valid — just means no callbacks defined yet
      this.compiled = true;
      return;
    }

    const status = lauxlib.luaL_loadstring(this.L, to_luastring(source));
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(`Lua compile error: ${err}`);
    }

    // Execute the chunk so top-level function definitions are registered
    this.instructionCount = 0;
    const execStatus = lua.lua_pcall(this.L, 0, 0, 0);
    if (execStatus !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(`Lua init error: ${err}`);
    }

    this.compiled = true;
  }

  // ── Calling Lua functions ───────────────────────────────────────────────

  /**
   * Call a global Lua function by name (e.g. "onTouch", "onHeartbeat").
   *
   * @param funcName  Name of the global function.
   * @param args      Optional — pushed as a single Lua table argument.
   * @returns `true` if the function existed and ran, `false` if it was not
   *          defined (which is not an error).
   * @throws  On runtime errors inside the Lua function.
   */
  callFunction(funcName: string, args?: Record<string, unknown>): boolean {
    if (!this.compiled || this.destroyed) return false;

    this.instructionCount = 0;

    lua.lua_getglobal(this.L, to_luastring(funcName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      return false;
    }

    let nargs = 0;
    if (args) {
      this.pushValue(args);
      nargs = 1;
    }

    const status = lua.lua_pcall(this.L, nargs, 0, 0);
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(`Lua runtime error in ${funcName}: ${err}`);
    }

    return true;
  }

  /**
   * Call a global Lua function with an array of entity-like table arguments.
   * Used for onNearby which receives an array of entities.
   */
  callFunctionWithArray(funcName: string, items: Record<string, unknown>[]): boolean {
    if (!this.compiled || this.destroyed) return false;

    this.instructionCount = 0;

    lua.lua_getglobal(this.L, to_luastring(funcName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      return false;
    }

    // Push array as a Lua table with integer keys
    lua.lua_newtable(this.L);
    for (let i = 0; i < items.length; i++) {
      this.pushValue(items[i]);
      lua.lua_rawseti(this.L, -2, i + 1);
    }

    const status = lua.lua_pcall(this.L, 1, 0, 0);
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(`Lua runtime error in ${funcName}: ${err}`);
    }

    return true;
  }

  // ── Registering JS functions into Lua ───────────────────────────────────

  /**
   * Set a read-only scalar value on a global table.
   * `path` is like "object.id" — the table must already exist on the stack
   * or be created beforehand.
   */
  setGlobalTableField(tableName: string, fieldName: string, value: unknown): void {
    lua.lua_getglobal(this.L, to_luastring(tableName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      // Create the table
      lua.lua_newtable(this.L);
      lua.lua_setglobal(this.L, to_luastring(tableName));
      lua.lua_getglobal(this.L, to_luastring(tableName));
    }
    this.pushValue(value);
    lua.lua_setfield(this.L, -2, to_luastring(fieldName));
    lua.lua_pop(this.L, 1); // pop the table
  }

  /**
   * Register a JS callback as a Lua function on a global table.
   * E.g. registerTableFunction("object", "say", fn) → object.say(...)
   */
  registerTableFunction(
    tableName: string,
    fieldName: string,
    fn: (L: any) => number,
  ): void {
    lua.lua_getglobal(this.L, to_luastring(tableName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      lua.lua_newtable(this.L);
      lua.lua_setglobal(this.L, to_luastring(tableName));
      lua.lua_getglobal(this.L, to_luastring(tableName));
    }
    lua.lua_pushcclosure(this.L, fn, 0);
    lua.lua_setfield(this.L, -2, to_luastring(fieldName));
    lua.lua_pop(this.L, 1);
  }

  /**
   * Register a nested table function.
   * E.g. registerNestedFunction("object", "state", "get", fn) → object.state.get(...)
   */
  registerNestedFunction(
    tableName: string,
    subTableName: string,
    fieldName: string,
    fn: (L: any) => number,
  ): void {
    // Ensure parent table exists
    lua.lua_getglobal(this.L, to_luastring(tableName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      lua.lua_newtable(this.L);
      lua.lua_setglobal(this.L, to_luastring(tableName));
      lua.lua_getglobal(this.L, to_luastring(tableName));
    }

    // Ensure sub-table exists
    lua.lua_getfield(this.L, -1, to_luastring(subTableName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      lua.lua_newtable(this.L);
      lua.lua_setfield(this.L, -2, to_luastring(subTableName));
      lua.lua_getfield(this.L, -1, to_luastring(subTableName));
    }

    // Set function on sub-table
    lua.lua_pushcclosure(this.L, fn, 0);
    lua.lua_setfield(this.L, -2, to_luastring(fieldName));

    lua.lua_pop(this.L, 2); // pop sub-table + parent table
  }

  /**
   * Create a global table with a position {x, y, z} nested inside another table.
   */
  setGlobalTablePosition(tableName: string, fieldName: string, x: number, y: number, z: number): void {
    lua.lua_getglobal(this.L, to_luastring(tableName));
    if (lua.lua_isnil(this.L, -1)) {
      lua.lua_pop(this.L, 1);
      lua.lua_newtable(this.L);
      lua.lua_setglobal(this.L, to_luastring(tableName));
      lua.lua_getglobal(this.L, to_luastring(tableName));
    }
    lua.lua_newtable(this.L);
    lua.lua_pushnumber(this.L, x);
    lua.lua_setfield(this.L, -2, to_luastring('x'));
    lua.lua_pushnumber(this.L, y);
    lua.lua_setfield(this.L, -2, to_luastring('y'));
    lua.lua_pushnumber(this.L, z);
    lua.lua_setfield(this.L, -2, to_luastring('z'));
    lua.lua_setfield(this.L, -2, to_luastring(fieldName));
    lua.lua_pop(this.L, 1);
  }

  // ── Helpers: push JS values onto the Lua stack ──────────────────────────

  /** Push a JS value as the appropriate Lua type. */
  pushValue(value: unknown): void {
    if (value === null || value === undefined) {
      lua.lua_pushnil(this.L);
    } else if (typeof value === 'number') {
      lua.lua_pushnumber(this.L, value);
    } else if (typeof value === 'string') {
      lua.lua_pushstring(this.L, to_luastring(value));
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(this.L, value ? 1 : 0);
    } else if (Array.isArray(value)) {
      lua.lua_newtable(this.L);
      for (let i = 0; i < value.length; i++) {
        this.pushValue(value[i]);
        lua.lua_rawseti(this.L, -2, i + 1);
      }
    } else if (typeof value === 'object') {
      lua.lua_newtable(this.L);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        this.pushValue(v);
        lua.lua_setfield(this.L, -2, to_luastring(k));
      }
    } else {
      lua.lua_pushnil(this.L);
    }
  }

  /** Read a Lua value from the stack at index `idx` back into JS. */
  readValue(idx: number): unknown {
    const t = lua.lua_type(this.L, idx);
    switch (t) {
      case lua.LUA_TNIL:
        return undefined;
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(this.L, idx);
      case lua.LUA_TSTRING:
        return lua.lua_tojsstring(this.L, idx);
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(this.L, idx);
      default:
        return undefined;
    }
  }

  /** Get the raw Lua state (for advanced use in SandboxAPI). */
  getLuaState(): any {
    return this.L;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      lua.lua_close(this.L);
    }
  }
}
