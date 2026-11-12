// Markdown and JSON reports. Never holds a secret value: only names, paths, messages and links.
import { sortFindings } from './checks.mjs';

const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export const ACCOUNT_CHECKLIST = [
  'Security log (github.com/settings/security-log): new tokens, OAuth or app authorisations, SSH keys, 2FA changes, sign-ins you don\'t recognise since the window began.',
  'Sessions (github.com/settings/sessions): sign out any you don\'t recognise.',
  'Personal access tokens, classic and fine-grained: last-used dates you can\'t explain.',
  'SSH and signing keys (github.com/settings/keys), and authorised OAuth and GitHub Apps (github.com/settings/applications).',
  'For organisations you own: the audit log, filtered on action:workflows.delete_workflow_run. A run you didn\'t delete is the strongest single sign.',
];

export function summarise(result) {
  const all = sortFindings(result.findings);
  const high = all.filter(f => f.severity === 'HIGH').length;
  const check = all.filter(f => f.severity === 'CHECK').length;
  const repos = new Set(all.map(f => f.repo));
  return { high, check, flaggedRepos: repos.size, verdict: high ? 'HIGH' : check ? 'CHECK' : result.gaps.length ? 'CLEAN_WITH_GAPS' : 'CLEAN' };
}

export function renderMarkdown(r) {
  const s = summarise(r);
  const all = sortFindings(r.findings);
  const hitPacks = r.packs.filter(p => all.some(f => f.pack === p.id && f.severity === 'HIGH'));
  const L = [];
  L.push(`# hubsweep report`, '');
  L.push(`Run ${r.generated} as \`${r.login ?? 'unknown'}\` on ${r.platform}, read-only. Window: from ${r.since}. Rule packs: ${r.packs.map(p => `${p.id}`).join(', ') || 'none'}.`, '');
  const verdict = { HIGH: `**${s.high} high finding${s.high === 1 ? '' : 's'}** in ${s.flaggedRepos} place${s.flaggedRepos === 1 ? '' : 's'}. Treat them as real until you've shown otherwise.`, CHECK: `No high findings. **${s.check} thing${s.check === 1 ? '' : 's'} to check** by eye.`, CLEAN_WITH_GAPS: 'Nothing found in what could be read, but some things couldn\'t be checked (see the end). That is not the same as clean.', CLEAN: 'Nothing found.' }[s.verdict];
  L.push(`**Result:** ${verdict}`, '');
  L.push(`Repos checked: ${r.repoCount}${r.repoCount ? ` (${r.deepCount} pushed to inside the window and read in depth)` : ''}. Local checkouts scanned: ${r.local ? r.local.scanned : 'not run'}. API calls: ${r.calls}.`, '');
  L.push('## Findings', '');
  if (all.length) {
    L.push('| Severity | Where | What | Rule pack |', '| --- | --- | --- | --- |');
    for (const f of all) L.push(`| ${f.severity} | ${esc(f.repo)} | ${esc(f.evidence)}${f.url ? ` ([link](${f.url}))` : ''} | ${esc(f.pack ?? 'generic')} |`);
  } else L.push('None.');
  L.push('');
  if (hitPacks.length) {
    L.push('## What to do now', '');
    for (const p of hitPacks) L.push(`- **${p.name}**: ${p.advice || 'treat every secret its workflows could reach as stolen.'} Source: ${p.source}`);
    L.push('- Lock the account first (sessions, tokens, keys, apps), then rotate secrets, then clean up branches and PRs. Keep a copy of what you found before deleting anything.', '');
  }
  L.push('## To look at', '');
  L.push(r.notes.length ? r.notes.map(n => `- ${esc(n)}`).join('\n') : 'Nothing.', '');
  L.push('## Your account', '');
  L.push('Activity by your account inside the window (from GitHub\'s events API):', '');
  const ev = Object.entries(r.account?.summary || {});
  L.push(ev.length ? ev.map(([k, v]) => `- ${esc(k)}: ${v}`).join('\n') : '- none', '');
  L.push('GitHub doesn\'t let tools read these, so check them yourself:', '');
  for (const c of ACCOUNT_CHECKLIST) L.push(`- [ ] ${c}`);
  L.push('');
  if (r.local) {
    L.push('## This machine', '');
    L.push(`Checked: ${r.local.coverage.join(', ') || 'nothing'}; ${r.local.scanned} git checkout${r.local.scanned === 1 ? '' : 's'} under ${r.local.roots.join(', ') || 'no folders'}.`, '');
  }
  L.push("## Couldn't check", '');
  L.push(r.gaps.length ? r.gaps.map(g => `- ${esc(g)}`).join('\n') : 'Nothing: every check could read what it needed.', '');
  L.push('## Repos checked', '');
  const flagged = new Set(all.map(f => f.repo));
  L.push(r.login ? (r.repoNames.map(n => `- ${n}${flagged.has(n) ? ' **(flagged)**' : ''}`).join('\n') || '- none') : 'GitHub was not checked in this run (--local-only).', '');
  return L.join('\n');
}

export function renderJson(r) {
  return JSON.stringify({ ...r, summary: summarise(r), packs: r.packs.map(p => ({ id: p.id, name: p.name, source: p.source })) }, null, 2);
}
