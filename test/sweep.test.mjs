import test from 'node:test';
import assert from 'node:assert/strict';
import { packs as load, fakeGh } from './helpers.mjs';
import { sweepRepo, listRepos, accountActivity, pool } from '../src/sweep.mjs';

const packs = load();
const since = new Date('2026-11-10T00:00:00Z');
const repo = { full_name: 'octo-org/app', html_url: 'https://github.com/octo-org/app', default_branch: 'main', pushed_at: '2026-11-10T13:00:00Z', size: 10, archived: false, owner: { login: 'octo-org' } };

test('a hit repo: probe PR, deleted throwaway branch, injected workflow, deleted run', async () => {
  const gh = fakeGh({
    'repos/octo-org/app/pulls': [{ number: 7, title: 'docs: dependency audit notes', head: { ref: 'wfx-docs' }, user: { login: 'victim' }, state: 'open', html_url: 'u', created_at: '2026-11-10T12:50:00Z' }, { number: 1, title: 'old', head: { ref: 'x' }, created_at: '2026-01-01T00:00:00Z' }],
    'repos/octo-org/app/branches': [{ name: 'main' }, { name: 'wfx-docs' }],
    'repos/octo-org/app/git/trees': { tree: [{ type: 'blob', path: 'README.md' }] },
    'repos/octo-org/app/activity': [
      { activity_type: 'branch_creation', ref: 'refs/heads/chore/k3j4h5g6', actor: { login: 'victim' }, timestamp: '2026-11-10T12:55:00Z', before: '0000000000', after: 'b'.repeat(40) },
      { activity_type: 'branch_deletion', ref: 'refs/heads/chore/k3j4h5g6', actor: { login: 'victim' }, timestamp: '2026-11-10T12:56:00Z', before: 'b'.repeat(40), after: '0'.repeat(40) },
      { activity_type: 'push', ref: 'refs/heads/main', actor: { login: 'victim' }, timestamp: '2026-11-10T12:57:00Z', before: 'c'.repeat(40), after: 'd'.repeat(40) }],
    'repos/octo-org/app/compare/main...bbbb': { commits: [{ sha: 'b'.repeat(40), commit: { message: 'chore: add dependency audit workflow' }, author: { login: 'victim' } }], files: [{ filename: '.github/workflows/build-audit-a1b2c3.yml', status: 'added', patch: '+x' }] },
    'repos/octo-org/app/compare/cccc': { commits: [{ sha: 'd'.repeat(40), commit: { message: 'ci: refresh build cache' }, author: { login: 'victim' } }], files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '+  WF_SECRETS: "${{ toJSON(secrets) }}"\n+  WF_CALLBACK: "http://194.150.166.244:8080/exfil"' }] },
    'repos/octo-org/app/actions/runs': [{ workflow_id: 1, name: 'CI', run_number: 41, head_branch: 'main' }, { workflow_id: 1, name: 'CI', run_number: 43, head_branch: 'main' }],
    'repos/octo-org/app/commits/dddd': [{ state: 'success', context: 'build', creator: { login: 'victim', type: 'User' } }],
  });
  const r = await sweepRepo(gh, repo, { packs, since });
  const ev = r.findings.map(f => `${f.severity} ${f.evidence}`).join('\n');
  for (const want of [/HIGH PR #7/, /HIGH branch wfx-docs exists now/, /HIGH branch chore\/k3j4h5g6 branch creation/, /HIGH commit bbbbbbbbbb "chore: add dependency audit workflow"/, /HIGH commit bbbbbbbbbb adds or changes \.github\/workflows\/build-audit-a1b2c3\.yml/, /HIGH commit dddddddddd "ci: refresh build cache"/, /HIGH .*adds "194\.150\.166\.244" in/, /CHECK .*toJSON\(secrets\)/, /CHECK workflow "CI" is missing run number 42/, /CHECK .*"build" marked success by user victim/])
    assert.match(ev, want);
  assert.ok(!/PR #1/.test(ev), 'PRs older than the window are skipped');
  assert.deepEqual(r.gaps, []);
  assert.match(r.notes.join('\n'), /1 branch deletion by victim \(chore\/k3j4h5g6\)/);
  assert.ok(r.findings.every(f => f.repo === 'octo-org/app'));
});

test('a quiet repo gets only the cheap checks; a 403 is a gap, never a clean', async () => {
  const gh = fakeGh({ 'repos/octo-org/app/pulls': { error: 'HTTP 403: Resource not accessible', status: 403 }, 'repos/octo-org/app/branches': [], 'repos/octo-org/app/git/trees': { tree: [] } });
  const r = await sweepRepo(gh, { ...repo, pushed_at: '2026-10-01T00:00:00Z' }, { packs, since });
  assert.equal(r.deep, false);
  assert.match(r.gaps[0], /pull requests: HTTP 403/);
  assert.ok(!gh.calls.some(c => c.includes('/activity')));
});

test('when activity is unreadable it says so and falls back to the default branch', async () => {
  const gh = fakeGh({ 'repos/octo-org/app/pulls': [], 'repos/octo-org/app/branches': [], 'repos/octo-org/app/git/trees': { tree: [] }, 'repos/octo-org/app/activity': { error: 'HTTP 403', status: 403 }, 'repos/octo-org/app/commits?sha=main': [{ sha: 'e'.repeat(40), parents: [{ sha: 'f'.repeat(40) }] }], 'repos/octo-org/app/compare/': { commits: [], files: [] }, 'repos/octo-org/app/actions/runs': [], 'repos/octo-org/app/commits/': [] });
  const r = await sweepRepo(gh, repo, { packs, since });
  assert.match(r.gaps.join('\n'), /activity: HTTP 403/);
  assert.ok(gh.calls.some(c => c.startsWith('repos/octo-org/app/compare/ffff')));
});

test('listRepos: --owner filters, --repo reads exactly those, forks and archived can be skipped', async () => {
  const mk = (full, extra = {}) => ({ full_name: full, owner: { login: full.split('/')[0] }, ...extra });
  const gh = fakeGh({ 'user/repos': [mk('me/a'), mk('org/b', { fork: true }), mk('org/c', { archived: true })], 'users/org/repos': [mk('org/d')], 'repos/x/y': mk('x/y') });
  assert.deepEqual((await listRepos(gh, {})).repos.map(r => r.full_name), ['me/a', 'org/b', 'org/c']);
  assert.deepEqual((await listRepos(gh, { owners: ['org'], forks: false, archived: false })).repos.map(r => r.full_name), ['org/d']);
  assert.deepEqual((await listRepos(gh, { repos: ['x/y', 'no/pe'] })).repos.map(r => r.full_name), ['x/y']);
});

test('accountActivity counts events in the window and flags campaign refs', async () => {
  const gh = fakeGh({ 'users/me/events': [{ type: 'CreateEvent', repo: { name: 'me/a' }, created_at: '2026-11-10T13:00:00Z', payload: { ref: 'wfx-docs' } }, { type: 'PushEvent', repo: { name: 'me/a' }, created_at: '2026-11-01T00:00:00Z', payload: {} }] });
  const a = await accountActivity(gh, 'me', { packs, since });
  assert.deepEqual(a.summary, { 'CreateEvent in me/a': 1 });
  assert.equal(a.findings.length, 1);
});

test('pool keeps order and limits concurrency', async () => {
  let live = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async x => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
