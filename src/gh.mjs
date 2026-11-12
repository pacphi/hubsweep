// A thin, read-only wrapper over `gh api`. Only GET requests are ever made.
import { execFile } from 'node:child_process';

// exec(cmd, args) -> Promise<{ code, stdout, stderr }>; never throws
export function execCmd(cmd, args, { input, timeout = 300000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { maxBuffer: 512 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.code === 'ENOENT' ? `${cmd}: not found` : err?.message || '')) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const statusOf = stderr => Number((stderr.match(/HTTP (\d{3})/) || [])[1]) || null;
export const isRateLimit = stderr => /rate limit/i.test(stderr) || /HTTP 429/.test(stderr);

export function createGh({ exec = execCmd, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, now = () => Date.now() } = {}) {
  let calls = 0;
  let pause = null; // a shared wait while the rate limit resets

  async function waitForReset(secondary) {
    if (pause) return pause;
    pause = (async () => {
      let ms = 60000;
      if (!secondary) {
        const r = await exec('gh', ['api', 'rate_limit']);
        try { const reset = JSON.parse(r.stdout).resources.core.reset * 1000; ms = Math.max(5000, reset - now() + 5000); } catch { /* keep 60 s */ }
      }
      log(`GitHub rate limit reached; waiting ${Math.ceil(ms / 1000)} s before going on`);
      await sleep(ms);
    })();
    try { await pause; } finally { pause = null; }
  }

  // api(path, { paginate, raw }) -> { ok, status, data, error }
  async function api(path, { paginate = false, raw = false } = {}) {
    const args = ['api', '-X', 'GET', '-H', raw ? 'Accept: application/vnd.github.raw' : 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (paginate) args.push('--paginate', '--slurp');
    args.push(path);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (pause) await pause;
      calls++;
      const r = await exec('gh', args);
      if (r.code === 0) {
        if (raw) return { ok: true, status: 200, data: r.stdout };
        try {
          const j = r.stdout.trim() ? JSON.parse(r.stdout) : null;
          if (!paginate) return { ok: true, status: 200, data: j };
          const items = (j || []).flatMap(page => (Array.isArray(page) ? page : page?.workflow_runs ?? page?.items ?? page?.repositories ?? [page]));
          return { ok: true, status: 200, data: items };
        } catch (e) { return { ok: false, status: null, error: `unreadable reply (${e.message})` }; }
      }
      if (isRateLimit(r.stderr)) { await waitForReset(/secondary/i.test(r.stderr)); continue; }
      const status = statusOf(r.stderr);
      if (status >= 500 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      return { ok: false, status, error: (r.stderr.split('\n').find(l => l.trim()) || `gh exited ${r.code}`).trim().slice(0, 200) };
    }
    return { ok: false, status: null, error: 'gave up after repeated rate limits' };
  }

  return { api, calls: () => calls };
}
