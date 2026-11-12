import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPacks, validatePack, BUILTIN_DIR, earliestFrom, firstMatch } from '../src/rules.mjs';

test('every shipped pack is valid, has a source and credits, and compiles', () => {
  const { packs, errors } = loadPacks();
  assert.deepEqual(errors, []);
  assert.ok(packs.length >= 2);
  for (const p of packs) { assert.match(p.source, /^https:\/\//); assert.ok(p.credits, `${p.id} credits`); }
});

test('validatePack names each problem', () => {
  assert.deepEqual(validatePack({ id: 'x', name: 'x', source: 's', github: { prTitles: ['^ok$'] } }), []);
  const errs = validatePack({ id: 'Bad Id', name: 'n', source: 's', severity: 'loud', github: { nope: ['a'], branches: ['('] } });
  assert.ok(errs.some(e => /lowercase/.test(e)));
  assert.ok(errs.some(e => /severity/.test(e)));
  assert.ok(errs.some(e => /unknown key "github.nope"/.test(e)));
  assert.ok(errs.some(e => /bad pattern/.test(e)));
  assert.deepEqual(validatePack({ id: 'x', name: 'x', source: 's' }), ['no markers in "github" or "host"']);
});

test('a later folder replaces a pack by id, disables one, and reports a broken file without stopping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hubsweep-rules-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'wfx-loot-2026-11', name: 'mine', source: 'https://example.com', github: { prTitles: ['^mine$'] } }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ id: 'ghostaction-2026-10', disabled: true }));
  writeFileSync(join(dir, 'c.json'), '{ not json');
  const { packs, errors } = loadPacks({ dirs: [BUILTIN_DIR, dir] });
  assert.deepEqual(packs.map(p => p.name), ['mine']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /c\.json/);
});

test('--pack limits the packs and names an unknown id', () => {
  const { packs, errors } = loadPacks({ only: ['wfx-loot-2026-11', 'nope'] });
  assert.deepEqual(packs.map(p => p.id), ['wfx-loot-2026-11']);
  assert.match(errors[0], /nope/);
});

test('earliestFrom and firstMatch', () => {
  const { packs } = loadPacks();
  assert.equal(earliestFrom(packs).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(earliestFrom([{}]), null);
  assert.equal(firstMatch([/a/], null), null);
});
