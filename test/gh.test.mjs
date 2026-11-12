import test from 'node:test';
import assert from 'node:assert/strict';
import { createGh, execCmd, isRateLimit } from '../src/gh.mjs';

const seq = replies => { const calls = []; return { calls, exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return replies.shift() ?? { code: 0, stdout: '[]', stderr: '' }; } }; };

test('only GET requests are made, with pagination flattened', async () => {
  const s = seq([{ code: 0, stdout: JSON.stringify([[{ a: 1 }], [{ a: 2 }]]), stderr: '' }, { code: 0, stdout: JSON.stringify([{ workflow_runs: [{ r: 1 }] }]), stderr: '' }]);
  const gh = createGh({ exec: s.exec });
  assert.deepEqual((await gh.api('x', { paginate: true })).data, [{ a: 1 }, { a: 2 }]);
  assert.deepEqual((await gh.api('runs', { paginate: true })).data, [{ r: 1 }]);
  assert.ok(s.calls.every(c => c.startsWith('gh api -X GET ')));
  assert.equal(gh.calls(), 2);
});

test('a primary rate limit waits until the reset, then retries', async () => {
  const slept = [];
  const s = seq([
    { code: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user (HTTP 403)' },
    { code: 0, stdout: JSON.stringify({ resources: { core: { reset: 1100 } } }), stderr: '' },
    { code: 0, stdout: '{"ok":true}', stderr: '' }]);
  const gh = createGh({ exec: s.exec, sleep: async ms => slept.push(ms), now: () => 1000 * 1000 });
  const r = await gh.api('repos/a/b');
  assert.equal(r.ok, true);
  assert.equal(slept[0], 105000);
});

test('a secondary rate limit backs off 60 s; a 404 is an error, not an empty list; 5xx retries', async () => {
  const slept = [];
  const s = seq([
    { code: 1, stdout: '', stderr: 'You have exceeded a secondary rate limit (HTTP 403)' },
    { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' },
    { code: 1, stdout: '', stderr: 'gh: Bad Gateway (HTTP 502)' },
    { code: 0, stdout: '[]', stderr: '' }]);
  const gh = createGh({ exec: s.exec, sleep: async ms => slept.push(ms) });
  const r = await gh.api('a');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(slept[0], 60000);
  assert.equal((await gh.api('b')).ok, true);
  assert.equal(isRateLimit('HTTP 429'), true);
});

test('execCmd never throws for a missing command', async () => {
  const r = await execCmd('hubsweep-no-such-command', []);
  assert.notEqual(r.code, 0);
});
