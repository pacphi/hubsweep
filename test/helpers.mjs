import { loadPacks } from '../src/rules.mjs';
export const packs = () => loadPacks().packs;
// fakeGh(routes): routes maps a path prefix (or RegExp) to data, or to { error, status }
export function fakeGh(routes) {
  const calls = [];
  return {
    calls, api: async (path) => {
      calls.push(path);
      for (const [k, v] of Object.entries(routes)) if (path.startsWith(k)) return v && v.error ? { ok: false, status: v.status ?? 404, error: v.error } : { ok: true, status: 200, data: typeof v === 'function' ? v(path) : v };
      return { ok: false, status: 404, error: 'HTTP 404: Not Found' };
    },
  };
}
