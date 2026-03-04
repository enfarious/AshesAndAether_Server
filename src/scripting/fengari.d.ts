declare module 'fengari' {
  const lua: any;
  const lauxlib: any;
  const lualib: any;
  function to_luastring(str: string): Uint8Array;
}
