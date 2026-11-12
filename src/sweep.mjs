// The GitHub side of the sweep: every repo the signed-in account can reach. Read-only.
import { matchPullRequest, matchBranch, matchCommit, workflowSmells, runGaps, gapFindings, forgedStatuses, matchTree } from './checks.mjs';

const ZERO = /^0+$/;
const day = d => d.toISOString().slice(0, 10);

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function listRepos(gh, { owners = [], repos = [], forks = true, archived = true } = {}) {
  const gaps = [];
  const map = new Map();
  if (repos.length) {
    for (const full of repos) {
      const r = await gh.api(`repos/${full}`);
      if (r.ok) map.set(r.data.full_name, r.data); else gaps.push(`${full}: ${r.error}`);
    }
  } else {
    const mine = await gh.api('user/repos?affiliation=owner,collaborator,organization_member&per_page=100', { paginate: true });
    if (mine.ok) for (const r of mine.data) map.set(r.full_name, r); else gaps.push(`your repo list: ${mine.error}`);
    for (const o of owners) {
      const r = await gh.api(`users/${o}/repos?type=all&per_page=100`, { paginate: true });
      if (r.ok) for (const x of r.data) if (!map.has(x.full_name)) map.set(x.full_name, x);
      else gaps.push(`${o}: ${r.error}`);
    }
  }
  const lower = owners.map(o => o.toLowerCase());
  const list = [...map.values()]
    .filter(r => !lower.length || repos.length || lower.includes(r.owner.login.toLowerCase()))
    .filter(r => (forks || !r.fork) && (archived || !r.archived))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  return { repos: list, gaps };
}

// sweepRepo(gh, repo, { packs, since, maxPushes }) -> { repo, findings, notes, gaps, deep }
export async function sweepRepo(gh, r, { packs, since, maxPushes = 150 }) {
  const full = r.full_name;
  const findings = [], notes = [], gaps = [];
  const add = fs => findings.push(...fs.map(f => ({ ...f, repo: full })));
  const sinceIso = since.toISOString();
  const deep = !!r.pushed_at && r.pushed_at >= sinceIso;

  // 1. Pull requests opened in the window (newest first)
  const prs = await gh.api(`repos/${full}/pulls?state=all&sort=created&direction=desc&per_page=100`);
  if (!prs.ok) gaps.push(`pull requests: ${prs.error}`);
  else for (const p of prs.data) {
    if (p.created_at < sinceIso) break;
    add(matchPullRequest({ number: p.number, title: p.title, head: p.head?.ref, author: p.user?.login, state: p.merged_at ? 'merged' : p.state, url: p.html_url, created: p.created_at }, packs));
  }

  // 2. Branches that exist now
  const br = await gh.api(`repos/${full}/branches?per_page=100`, { paginate: true });
  if (!br.ok) gaps.push(`branches: ${br.error}`);
  else for (const b of br.data) add(matchBranch(b.name, packs, { how: 'exists now', url: `${r.html_url}/tree/${encodeURIComponent(b.name)}` }));

  // 3. Files on the default branch (one call for the whole tree)
  if (r.default_branch && r.size !== 0) {
    const tree = await gh.api(`repos/${full}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`);
    if (!tree.ok) { if (tree.status !== 409) gaps.push(`file tree: ${tree.error}`); }
    else {
      if (tree.data.truncated) notes.push('the file tree is too large to read whole; files deep in it were not checked');
      add(matchTree((tree.data.tree || []).filter(t => t.type === 'blob').map(t => t.path), packs));
    }
  }

  if (!deep) return { repo: full, findings, notes, gaps, deep };

  // 4. Activity: every push, force push and branch create/delete in the window, even for branches deleted since
  const pushes = new Map();
  const tally = new Map();
  const act = await gh.api(`repos/${full}/activity?per_page=100&time_period=quarter`, { paginate: true });
  if (!act.ok) gaps.push(`activity: ${act.error}`);
  else for (const a of act.data) {
    if (!a.timestamp || a.timestamp < sinceIso) continue;
    const ref = String(a.ref || '').replace(/^refs\/heads\//, '');
    add(matchBranch(ref, packs, { how: `${a.activity_type.replace('_', ' ')} by ${a.actor?.login} at ${a.timestamp}`, at: a.timestamp }));
    if (a.activity_type === 'force_push' || a.activity_type === 'branch_deletion') {
      const k = `${a.activity_type === 'force_push' ? 'force push' : 'branch deletion'}|${a.actor?.login ?? 'unknown'}`;
      const t = tally.get(k) || { n: 0, last: a.timestamp, refs: new Set() };
      t.n++; t.refs.add(ref); if (a.timestamp > t.last) t.last = a.timestamp;
      tally.set(k, t);
    }
    if (a.after && !ZERO.test(a.after) && !pushes.has(a.after)) pushes.set(a.after, { ...a, ref });
  }
  for (const [k, t] of tally) {
    const refs = [...t.refs];
    const [what, who] = k.split('|');
    notes.push(`${t.n} ${what}${t.n > 1 ? 's' : ''} by ${who} (${refs.slice(0, 4).join(', ')}${refs.length > 4 ? `, +${refs.length - 4} more` : ''}), last ${t.last}`);
  }
  if (!act.ok) {
    // fall back to the default branch's commits
    const cs = await gh.api(`repos/${full}/commits?sha=${encodeURIComponent(r.default_branch)}&since=${sinceIso}&per_page=100`);
    if (cs.ok && cs.data.length) pushes.set(cs.data[0].sha, { after: cs.data[0].sha, before: cs.data[cs.data.length - 1].parents?.[0]?.sha, ref: r.default_branch, actor: {} });
  }

  // 5. What each push changed: commit messages and added lines
  const list = [...pushes.values()];
  if (list.length > maxPushes) notes.push(`${list.length} pushes in the window; only the newest ${maxPushes} were read`);
  for (const p of list.slice(0, maxPushes)) {
    const base = p.before && !ZERO.test(p.before) ? p.before : r.default_branch;
    const cmp = await gh.api(`repos/${full}/compare/${encodeURIComponent(base)}...${p.after}`);
    if (!cmp.ok) { gaps.push(`changes in push ${p.after.slice(0, 10)} to ${p.ref}: ${cmp.error}`); continue; }
    for (const c of cmp.data.commits || []) {
      add(matchCommit({ sha: c.sha, subject: (c.commit?.message || '').split('\n')[0].trim(), author: c.author?.login || c.commit?.author?.name, date: c.commit?.author?.date, url: c.html_url }, packs));
    }
    const pushCommit = { sha: p.after, subject: '', author: p.actor?.login || 'unknown', date: p.timestamp, url: `${r.html_url}/commit/${p.after}`, files: cmp.data.files || [] };
    add(matchCommit(pushCommit, packs));
    add(workflowSmells(pushCommit));
  }

  // 6. Actions runs: deleted runs leave gaps in run numbers
  if (!r.archived) {
    const runs = await gh.api(`repos/${full}/actions/runs?created=%3E%3D${day(since)}&per_page=100`, { paginate: true });
    if (!runs.ok) gaps.push(`Actions runs: ${runs.error}`);
    else {
      add(gapFindings(runGaps(runs.data)));
      for (const run of runs.data) add(matchBranch(run.head_branch || '', packs, { how: `ran workflow "${run.name}" #${run.run_number} at ${run.created_at}`, url: run.html_url }));
    }
  }

  // 7. Success statuses posted by a person on the default branch's newest pushes
  for (const p of list.filter(p => p.ref === r.default_branch).slice(0, 20)) {
    const st = await gh.api(`repos/${full}/commits/${p.after}/statuses?per_page=100`);
    if (!st.ok) { gaps.push(`statuses on ${p.after.slice(0, 10)}: ${st.error}`); break; }
    add(forgedStatuses(p.after, st.data));
  }

  return { repo: full, findings, notes, gaps, deep };
}

// The account's own recent activity (public and, for yourself, private events)
export async function accountActivity(gh, login, { packs, since }) {
  const r = await gh.api(`users/${login}/events?per_page=100`, { paginate: true });
  if (!r.ok) return { summary: {}, findings: [], gaps: [`your account activity: ${r.error}`] };
  const sinceIso = since.toISOString();
  const summary = {}, findings = [];
  for (const e of r.data) {
    if (e.created_at < sinceIso) continue;
    const key = `${e.type} in ${e.repo?.name}`;
    summary[key] = (summary[key] || 0) + 1;
    const ref = String(e.payload?.ref || '').replace(/^refs\/heads\//, '');
    findings.push(...matchBranch(ref, packs, { how: `${e.type} by your account at ${e.created_at}`, at: e.created_at }).map(f => ({ ...f, repo: e.repo?.name })));
    const pr = e.payload?.pull_request;
    if (pr) findings.push(...matchPullRequest({ number: pr.number, title: pr.title, head: pr.head?.ref, author: login, state: pr.state, url: pr.html_url, created: e.created_at }, packs).map(f => ({ ...f, repo: e.repo?.name, evidence: `${f.evidence}, opened by your account` })));
  }
  return { summary, findings, gaps: [] };
}
