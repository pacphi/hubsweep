import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor, doctorFailed, renderDoctor } from '../src/doctor.mjs';

const fake = map => async (cmd, args) => { const k = [cmd, ...args].join(' '); for (const [p, v] of Object.entries(map)) if (k.startsWith(p)) return v; return { code: 127, stdout: '', stderr: `${cmd}: not found` }; };
const by = (res, name) => res.find(r => r.name === name);

test('all good: Node, gh, signed in with repo and read:org, budget, git, crontab', async () => {
  const res = await doctor({ nodeVersion: '24.1.0', platform: 'darwin', local: ['/x'], out: '.', exec: fake({
    'gh --version': { code: 0, stdout: 'gh version 2.80.0\n', stderr: '' },
    'gh api -i user': { code: 0, stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, read:org, repo\n\n{"login":"octo-user"}', stderr: '' },
    'gh api rate_limit': { code: 0, stdout: JSON.stringify({ resources: { core: { remaining: 4900, limit: 5000, reset: 0 } } }), stderr: '' },
    'git --version': { code: 0, stdout: 'git version 2.50\n', stderr: '' },
    'crontab -l': { code: 1, stdout: '', stderr: 'crontab: no crontab for octo-user' } }) });
  assert.equal(doctorFailed(res), false);
  assert.ok(res.every(r => r.status === 'ok'), renderDoctor(res));
});

test('old Node, missing gh and a git-less --local each fail with a fix', async () => {
  const res = await doctor({ nodeVersion: '18.20.0', platform: 'linux', local: ['/x'], out: '.', exec: fake({}) });
  assert.equal(by(res, 'Node.js').status, 'fail');
  assert.match(by(res, 'GitHub CLI (gh)').fix, /offer to install/);
  assert.equal(by(res, 'git').status, 'fail');
  assert.ok(doctorFailed(res));
});

test('signed out fails; missing scopes and a fine-grained token warn with the fix', async () => {
  const base = { 'gh --version': { code: 0, stdout: 'gh 2\n', stderr: '' }, 'git --version': { code: 0, stdout: 'git\n', stderr: '' }, 'gh api rate_limit': { code: 1, stdout: '', stderr: '' } };
  const out = await doctor({ nodeVersion: '22.0.0', exec: fake({ ...base, 'gh api -i user': { code: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login' } }) });
  assert.equal(by(out, 'Signed in to GitHub').status, 'fail');
  assert.equal(by(out, 'Signed in to GitHub').fix, 'Run: gh auth login');
  const narrow = await doctor({ nodeVersion: '22.0.0', exec: fake({ ...base, 'gh api -i user': { code: 0, stdout: 'X-Oauth-Scopes: gist\n\n{"login":"u"}', stderr: '' } }) });
  assert.equal(by(narrow, 'Token access').status, 'warn');
  assert.equal(by(narrow, 'Token access').fix, 'Run: gh auth refresh -s repo,read:org');
  const fine = await doctor({ nodeVersion: '22.0.0', exec: fake({ ...base, 'gh api -i user': { code: 0, stdout: 'HTTP/2.0 200 OK\n\n{"login":"u"}', stderr: '' } }) });
  assert.match(by(fine, 'Token access').detail, /fine-grained/);
  const empty = await doctor({ nodeVersion: '22.0.0', exec: fake({ ...base, 'gh api -i user': { code: 0, stdout: 'X-Oauth-Scopes: \nX-Ratelimit-Limit: 5000\n\n{"login":"u"}', stderr: '' } }) });
  assert.match(by(empty, 'Token access').detail, /^scopes: none;/);
});

test('Windows checks scheduled tasks instead of crontab', async () => {
  const res = await doctor({ nodeVersion: '22.0.0', platform: 'win32', localOnly: true, exec: fake({ 'git --version': { code: 0, stdout: 'git\n', stderr: '' }, 'schtasks /query': { code: 0, stdout: '', stderr: '' } }) });
  assert.equal(by(res, 'Scheduled tasks').status, 'ok');
  assert.equal(by(res, 'crontab'), undefined);
  assert.equal(by(res, 'GitHub CLI (gh)'), undefined, '--local-only needs no gh');
});
