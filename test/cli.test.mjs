import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, parseSince, windowStart, main, EXIT } from '../src/cli.mjs';
import { loadPacks } from '../src/rules.mjs';
import { installCommand, ensureGh } from '../src/install.mjs';

const now = new Date('2026-11-20T00:00:00Z');

test('parseArgs: repeatable flags, validation, and helpful errors', () => {
  const o = parseArgs(['--owner', 'a', '--owner', 'b', '--repo', 'a/x', '--since', '7d', '--no-forks', '--concurrency', '8'], now);
  assert.deepEqual(o.owners, ['a', 'b']);
  assert.equal(o.since.toISOString(), '2026-11-13T00:00:00.000Z');
  assert.equal(o.forks, false);
  assert.throws(() => parseArgs(['--repo', 'nope']), /owner\/name/);
  assert.throws(() => parseArgs(['--owner']), /needs a value/);
  assert.throws(() => parseArgs(['--concurrency', '99']), /1 to 16/);
  assert.throws(() => parseArgs(['--wat']), /unknown option/);
  assert.throws(() => parseSince('soon'), /date or a number of days/);
});

test('the window: --since, else the packs\' earliest start, never past 90 days', () => {
  const { packs } = loadPacks();
  assert.equal(windowStart({ since: new Date('2026-11-15') }, packs, now).toISOString(), '2026-11-15T00:00:00.000Z');
  assert.equal(windowStart({}, packs, now).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(windowStart({ since: new Date('2020-01-01') }, packs, now).toISOString(), '2026-08-22T00:00:00.000Z');
});

const routes = map => async (cmd, args) => {
  const k = [cmd, ...args].join(' ');
  for (const [p, v] of Object.entries(map)) if (k.includes(p)) return typeof v === 'function' ? v(k) : v;
  return { code: 1, stdout: '', stderr: 'HTTP 404' };
};
const ok = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });

test('a full run against a fake gh writes both reports and exits 10 on a high finding', async () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'hubsweep-cli-')));
  const exec = routes({
    'gh --version': { code: 0, stdout: 'gh version 2', stderr: '' },
    'api user --jq': { code: 0, stdout: 'octo-user\n', stderr: '' },
    'user/repos': ok([[{ full_name: 'octo-user/app', owner: { login: 'octo-user' }, html_url: 'h', default_branch: 'main', pushed_at: '2026-01-01T00:00:00Z', size: 1 }]]),
    'pulls?': ok([{ number: 5, title: 'docs: dependency audit notes', head: { ref: 'wfx-docs' }, user: { login: 'octo-user' }, state: 'open', html_url: 'u', created_at: '2026-11-10T13:00:00Z' }]),
    '/branches': ok([[]]),
    'git/trees': ok({ tree: [] }),
    'users/octo-user/events': ok([[]]),
  });
  const logs = [];
  const code = await main(['--out', out], { exec, log: m => logs.push(m), out: m => logs.push(m), platform: 'linux', now });
  assert.equal(code, EXIT.HIGH);
  const md = readFileSync(join(out, 'hubsweep-report.md'), 'utf8');
  assert.match(md, /\*\*1 high finding\*\*/);
  assert.match(md, /What to do now/);
  assert.match(md, /octo-user\/app \*\*\(flagged\)\*\*/);
  const json = JSON.parse(readFileSync(join(out, 'hubsweep-report.json'), 'utf8'));
  assert.equal(json.summary.high, 1);
  assert.ok(!/BEGIN .*PRIVATE KEY|ghp_/.test(md));
});

test('gh not signed in → exit 3 with the fix; bad args → exit 2; --list-packs → 0', async () => {
  const logs = [];
  const exec = routes({ 'gh --version': { code: 0, stdout: 'gh', stderr: '' }, 'api user': { code: 1, stdout: '', stderr: 'not logged in' } });
  assert.equal(await main([], { exec, log: m => logs.push(m), out: () => {}, now }), EXIT.SETUP);
  assert.match(logs.join('\n'), /gh auth login/);
  assert.equal(await main(['--nope'], { log: () => {}, out: () => {} }), EXIT.USAGE);
  const lines = [];
  assert.equal(await main(['--list-packs'], { log: () => {}, out: m => lines.push(m) }), EXIT.CLEAN);
  assert.ok(lines.some(l => l.startsWith('wfx-loot-2026-11')));
});

test('installCommand per platform, and ensureGh asks before installing', async () => {
  assert.deepEqual(installCommand('darwin', { brew: true }), ['brew', ['install', 'gh']]);
  assert.equal(installCommand('win32', { winget: true })[0], 'winget');
  assert.deepEqual(installCommand('linux', { dnf: true }), ['sudo', ['dnf', 'install', '-y', 'gh']]);
  assert.equal(installCommand('linux', {}), null);
  let ghThere = false;
  const exec = async (cmd, args) => (cmd === 'gh' ? { code: ghThere ? 0 : 127, stdout: '', stderr: '' } : { code: args[0] === 'brew' ? 0 : 1, stdout: '', stderr: '' });
  const ran = [];
  const run = (c, a) => { ran.push([c, ...a].join(' ')); ghThere = true; return { code: 0, stderr: '' }; };
  assert.equal(await ensureGh({ exec, platform: 'darwin', log: () => {}, ask: async () => 'n', run }), false);
  assert.deepEqual(ran, []);
  assert.equal(await ensureGh({ exec, platform: 'darwin', log: () => {}, ask: async () => 'y', run }), true);
  assert.deepEqual(ran, ['brew install gh']);
});
