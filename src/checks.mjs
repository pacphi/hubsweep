// Pure analysis: facts in, findings out. No I/O here, so every rule is unit-tested.
import { firstMatch } from './rules.mjs';

const sev = (pack, key) => (pack.severity === 'check' || pack.checkOnly.includes(key) ? 'CHECK' : 'HIGH');
const finding = (severity, kind, evidence, extra = {}) => ({ severity, kind, evidence, pack: null, ...extra });
const byPack = (pack, key, kind, evidence, extra) => finding(sev(pack, key), kind, evidence, { pack: pack.id, ...extra });

// Lines added by a unified-diff patch (not the +++ header)
export const addedLines = (patch = '') => String(patch).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));

export function matchPullRequest(pr, packs) {
  const out = [];
  for (const p of packs) {
    if (firstMatch(p.github.prTitles, pr.title)) out.push(byPack(p, 'prTitles', 'pull request', `PR #${pr.number} "${pr.title}" by ${pr.author} (${pr.state})`, { url: pr.url, at: pr.created }));
    else if (firstMatch(p.github.branches, pr.head)) out.push(byPack(p, 'branches', 'pull request', `PR #${pr.number} from branch ${pr.head} by ${pr.author} (${pr.state})`, { url: pr.url, at: pr.created }));
  }
  return out;
}

export function matchBranch(name, packs, extra = {}) {
  return packs.filter(p => firstMatch(p.github.branches, name)).map(p => byPack(p, 'branches', 'branch', `branch ${name}${extra.how ? ` ${extra.how}` : ''}`, extra));
}

// commit = { sha, subject, author, date, url, files: [{ filename, patch, status }] }
export function matchCommit(c, packs) {
  const out = [];
  const short = (c.sha || '').slice(0, 10);
  for (const p of packs) {
    if (firstMatch(p.github.commitSubjects, c.subject)) out.push(byPack(p, 'commitSubjects', 'commit', `commit ${short} "${c.subject}" by ${c.author}`, { url: c.url, at: c.date }));
    for (const f of c.files || []) {
      const base = f.filename.split('/').pop();
      if (f.status !== 'removed') {
        if (f.filename.startsWith('.github/workflows/') && firstMatch(p.github.workflowFiles, base)) out.push(byPack(p, 'workflowFiles', 'workflow file', `commit ${short} adds or changes ${f.filename}`, { url: c.url, at: c.date }));
        if (firstMatch(p.github.files, f.filename)) out.push(byPack(p, 'files', 'file', `commit ${short} adds or changes ${f.filename}`, { url: c.url, at: c.date }));
      }
      const added = addedLines(f.patch);
      const hit = added.map(l => { const r = firstMatch(p.github.content, l); return r && l.match(r)[0]; }).find(Boolean);
      if (hit) out.push(byPack(p, 'content', 'content', `commit ${short} adds "${hit}" in ${f.filename}`, { url: c.url, at: c.date }));
      if (/(^|\/)package\.json$/.test(f.filename)) {
        const script = added.find(l => /"(pre|post)?install"\s*:/.test(l) && firstMatch(p.github.npmScripts, l));
        if (script) out.push(byPack(p, 'npmScripts', 'install hook', `commit ${short} adds an install hook in ${f.filename}: ${script.trim().slice(0, 120)}`, { url: c.url, at: c.date }));
      }
    }
  }
  return out;
}

// Generic, pack-free checks on lines a commit adds to a workflow file
const SMELLS = [
  [/toJSON\(\s*secrets\s*\)/, 'dumps every secret with toJSON(secrets)'],
  [/toJSON\(\s*vars\s*\)/, 'dumps every variable with toJSON(vars)'],
  [/id-token:\s*write/, 'asks for an OIDC token (id-token: write)'],
  [/\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\bhttps?:\/\/\d{1,3}(\.\d{1,3}){3}/, 'calls a raw IP address'],
  [/\bpull_request_target\b/, 'runs on pull_request_target'],
];
export function workflowSmells(c) {
  const out = [];
  for (const f of c.files || []) {
    if (!f.filename.startsWith('.github/workflows/')) continue;
    const added = addedLines(f.patch);
    for (const [rx, what] of SMELLS) if (added.some(l => rx.test(l))) out.push(finding('CHECK', 'workflow change', `commit ${(c.sha || '').slice(0, 10)} by ${c.author} ${what} in ${f.filename}`, { url: c.url, at: c.date }));
  }
  return out;
}

// runs = [{ workflow_id, name, run_number }] -> gaps per workflow, inside the window read
export function runGaps(runs) {
  const by = new Map();
  for (const r of runs) {
    if (!by.has(r.workflow_id)) by.set(r.workflow_id, { name: r.name, n: new Set() });
    by.get(r.workflow_id).n.add(r.run_number);
  }
  const out = [];
  for (const [id, w] of by) {
    const n = [...w.n].sort((a, b) => a - b);
    const missing = [];
    for (let i = 1; i < n.length; i++) for (let k = n[i - 1] + 1; k < n[i] && missing.length < 50; k++) missing.push(k);
    if (missing.length) out.push({ workflowId: id, name: w.name, missing });
  }
  return out;
}
export const gapFindings = gaps => gaps.map(g => finding('CHECK', 'deleted runs', `workflow "${g.name}" is missing run number${g.missing.length > 1 ? 's' : ''} ${g.missing.slice(0, 10).join(', ')}${g.missing.length > 10 ? ', …' : ''} (deleted runs)`));

// statuses = [{ state, context, creator: { login, type }, created_at }] for one commit
export function forgedStatuses(sha, statuses) {
  return statuses.filter(s => s.state === 'success' && s.creator?.type === 'User')
    .map(s => finding('CHECK', 'status check', `commit ${sha.slice(0, 10)}: "${s.context}" marked success by user ${s.creator.login}, not an app`, { at: s.created_at }));
}

// paths in the default branch's tree
export function matchTree(paths, packs) {
  const out = [];
  for (const p of packs) for (const path of paths) {
    const base = path.split('/').pop();
    if (path.startsWith('.github/workflows/') && firstMatch(p.github.workflowFiles, base)) out.push(byPack(p, 'workflowFiles', 'workflow file', `${path} is on the default branch`));
    else if (firstMatch(p.github.files, path)) out.push(byPack(p, 'files', 'file', `${path} is on the default branch`));
  }
  return out;
}

// A real WOFF2 font starts with "wOF2"; GhostAction's fake one is JavaScript
export const isWoff2 = buf => Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'wOF2';

export const SEVERITY_ORDER = { HIGH: 0, CHECK: 1, INFO: 2 };
export const sortFindings = fs => [...fs].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || String(a.repo).localeCompare(String(b.repo)));
