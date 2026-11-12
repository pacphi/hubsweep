// Rule packs: one JSON file per campaign. See rules/SCHEMA.md.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
export const GITHUB_KEYS = ['prTitles', 'branches', 'commitSubjects', 'workflowFiles', 'files', 'content', 'npmScripts'];
export const HOST_KEYS = ['cron', 'launchAgents', 'userUnits', 'scheduledTasks', 'repoFiles', 'repoStrings', 'repoCommits', 'npmScripts'];
const SEVERITIES = ['high', 'check'];

// validatePack(raw) -> list of problems (empty when valid)
export function validatePack(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['not a JSON object'];
  for (const k of ['id', 'name', 'source']) if (typeof p[k] !== 'string' || !p[k]) errs.push(`missing "${k}"`);
  if (p.id && !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) errs.push('"id" must be lowercase letters, digits and dashes');
  if (p.severity && !SEVERITIES.includes(p.severity)) errs.push(`"severity" must be one of ${SEVERITIES.join(', ')}`);
  if (p.active?.from && Number.isNaN(Date.parse(p.active.from))) errs.push('"active.from" is not a date');
  if (p.active?.until && Number.isNaN(Date.parse(p.active.until))) errs.push('"active.until" is not a date');
  let markers = 0;
  for (const [section, keys] of [['github', GITHUB_KEYS], ['host', HOST_KEYS]]) {
    const s = p[section];
    if (s === undefined) continue;
    if (typeof s !== 'object') { errs.push(`"${section}" must be an object`); continue; }
    for (const [k, v] of Object.entries(s)) {
      if (!keys.includes(k)) { errs.push(`unknown key "${section}.${k}"`); continue; }
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) { errs.push(`"${section}.${k}" must be a list of strings`); continue; }
      for (const rx of v) { try { new RegExp(rx); markers++; } catch (e) { errs.push(`"${section}.${k}": bad pattern ${JSON.stringify(rx)} (${e.message})`); } }
    }
  }
  if (!markers && !errs.length) errs.push('no markers in "github" or "host"');
  return errs;
}

// compile(pack) -> the pack with every pattern list turned into RegExp lists
export function compile(p) {
  const rx = list => (list || []).map(s => new RegExp(s));
  const out = { ...p, severity: p.severity || 'high', checkOnly: p.checkOnly || [], github: {}, host: {} };
  for (const k of GITHUB_KEYS) out.github[k] = rx(p.github?.[k]);
  for (const k of HOST_KEYS) out.host[k] = rx(p.host?.[k]);
  return out;
}

// loadPacks({ dirs, only }) -> { packs, errors }. Later dirs replace earlier packs with the same id;
// "disabled": true turns one off. `only` limits to those ids.
export function loadPacks({ dirs = [BUILTIN_DIR], only = [] } = {}) {
  const byId = new Map();
  const errors = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) { errors.push(`rules folder not found: ${dir}`); continue; }
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      const file = join(dir, f);
      let raw;
      try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
      if (raw.disabled && raw.id) { byId.delete(raw.id); continue; }
      const errs = validatePack(raw);
      if (errs.length) { errors.push(`${file}: ${errs.join('; ')}`); continue; }
      byId.set(raw.id, { ...raw, _file: file });
    }
  }
  let packs = [...byId.values()];
  if (only.length) {
    for (const id of only) if (!byId.has(id)) errors.push(`no rule pack with id "${id}"`);
    packs = packs.filter(p => only.includes(p.id));
  }
  return { packs: packs.map(compile), errors };
}

// earliest active.from across packs, or null
export function earliestFrom(packs) {
  const ts = packs.map(p => p.active?.from).filter(Boolean).map(Date.parse);
  return ts.length ? new Date(Math.min(...ts)) : null;
}

// match(list, text) -> the first RegExp that matches, or null
export const firstMatch = (list, text) => (text == null ? null : (list || []).find(r => r.test(String(text))) || null);
