// Prerequisite checks and the plain-words plan shown before a sweep. Read-only.
import { mkdirSync, accessSync, constants } from 'node:fs';

const MIN_NODE = 22;

// doctor({ exec, platform, nodeVersion, out, local }) -> [{ name, status: 'ok'|'warn'|'fail', detail, fix? }]
export async function doctor({ exec, platform = process.platform, nodeVersion = process.versions.node, out = '.', local = [], localOnly = false }) {
  const res = [];
  const add = (name, status, detail, fix) => res.push({ name, status, detail, ...(fix ? { fix } : {}) });

  const major = Number(String(nodeVersion).split('.')[0]);
  if (major >= MIN_NODE) add('Node.js', 'ok', `version ${nodeVersion}`);
  else add('Node.js', 'fail', `version ${nodeVersion}; hubsweep needs ${MIN_NODE} or newer`, 'Install the current LTS from https://nodejs.org');

  if (!localOnly) {
    const v = await exec('gh', ['--version']);
    if (v.code !== 0) add('GitHub CLI (gh)', 'fail', 'not installed', 'Run hubsweep without --doctor and it will offer to install it, or see https://cli.github.com');
    else {
      add('GitHub CLI (gh)', 'ok', v.stdout.split('\n')[0].trim());
      const who = await exec('gh', ['api', '-i', 'user']);
      if (who.code !== 0) add('Signed in to GitHub', 'fail', (who.stderr.trim().split('\n')[0] || 'not signed in'), 'Run: gh auth login');
      else {
        const login = (who.stdout.match(/"login"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
        add('Signed in to GitHub', 'ok', `as ${login}`);
        const scopesLine = (who.stdout.match(/^x-oauth-scopes:[ \t]*(.*)$/im) || [])[1];
        if (scopesLine === undefined) add('Token access', 'warn', 'a fine-grained or app token: hubsweep sees only the repos it grants, and anything else is listed as "couldn\'t check"');
        else {
          const scopes = scopesLine.split(',').map(s => s.trim()).filter(Boolean);
          const missing = ['repo', 'read:org'].filter(s => !scopes.includes(s) && !(s === 'read:org' && scopes.includes('admin:org')));
          if (missing.length) add('Token access', 'warn', `scopes: ${scopes.join(', ') || 'none'}; missing ${missing.join(' and ')}, so ${missing.includes('repo') ? 'private repos' : 'some organisation repos'} may be skipped`, `Run: gh auth refresh -s ${missing.join(',')}`);
          else add('Token access', 'ok', `scopes include repo and read:org (hubsweep still only reads)`);
        }
        const rl = await exec('gh', ['api', 'rate_limit']);
        try {
          const core = JSON.parse(rl.stdout).resources.core;
          const reset = new Date(core.reset * 1000).toISOString().slice(11, 16);
          add('GitHub API budget', core.remaining < 500 ? 'warn' : 'ok', `${core.remaining} of ${core.limit} requests left this hour (resets ${reset} UTC); a sweep uses about 3 per quiet repo and 10 to 30 per busy one`, core.remaining < 500 ? 'It will wait for the reset by itself, or run it later' : undefined);
        } catch { add('GitHub API budget', 'warn', 'could not read the rate limit'); }
      }
    }
  }

  const needGit = local.length > 0;
  const g = await exec('git', ['--version']);
  if (g.code === 0) add('git', 'ok', g.stdout.trim());
  else add('git', needGit ? 'fail' : 'warn', 'not installed', needGit ? 'Install git (https://git-scm.com); --local needs it to read your checkouts' : 'Only needed for --local');

  if (local.length || localOnly) {
    if (platform === 'win32') {
      const s = await exec('schtasks', ['/query', '/fo', 'LIST']);
      add('Scheduled tasks', s.code === 0 ? 'ok' : 'warn', s.code === 0 ? 'readable' : 'could not be listed; that check will show under "couldn\'t check"');
    } else {
      const c = await exec('crontab', ['-l']);
      const ok = c.code === 0 || /no crontab/i.test(c.stderr);
      add('crontab', ok ? 'ok' : 'warn', ok ? 'readable' : `${c.stderr.trim() || 'not available'}; that check will show under "couldn't check"`);
    }
  }

  try { mkdirSync(out, { recursive: true }); accessSync(out, constants.W_OK); add('Report folder', 'ok', `${out} is writable`); }
  catch (e) { add('Report folder', 'fail', `${out} is not writable (${e.code || e.message})`, 'Pass --out with a folder you can write to'); }
  return res;
}

export const doctorFailed = res => res.some(r => r.status === 'fail');

export function renderDoctor(res) {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  return res.map(r => `  ${mark[r.status]} ${r.name}: ${r.detail}${r.fix ? `\n      → ${r.fix}` : ''}`).join('\n');
}

// The plan, in plain words, shown before anything is read
export function planText({ login, owners = [], repos = [], since, packs = [], local = [], localOnly = false, out = '.' }) {
  const scope = repos.length ? `these repos: ${repos.join(', ')}` : owners.length ? `every repo owned by ${owners.join(', ')} that ${login ? `${login} can` : 'you can'} read` : `every repo ${login ? `${login} can` : 'your login can'} reach: your own, ones you collaborate on, and your organisations'`;
  const steps = [];
  if (!localOnly) {
    steps.push(`List ${scope}.`);
    steps.push('For each repo, read its recent pull requests, its branches and the file list on its default branch.');
    steps.push(`For repos pushed to since ${since.toISOString().slice(0, 10)}, also read what each push changed, the repo's activity log and its Actions run numbers, to spot payloads that were reverted, branches deleted since, and deleted runs.`);
    steps.push('Read your account\'s own recent events.');
  }
  if (local.length || localOnly) steps.push(`On this computer, read scheduled jobs (cron, launch agents, systemd user units or Windows scheduled tasks) and look inside the git checkouts under ${local.join(', ') || '(no folders given)'}.`);
  steps.push(`Match everything against the rule packs: ${packs.map(p => p.name).join('; ') || 'none'}.`);
  steps.push(`Write hubsweep-report.md and hubsweep-report.json to ${out}.`);
  return [
    'What hubsweep will do:',
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'What it will not do: it makes no changes anywhere. It only reads (GitHub GET requests through gh, and files on this',
    'computer), never prints or saves a secret\'s value, and sends nothing anywhere except your own requests to GitHub.',
    'Findings are clues for you to check, not verdicts.',
  ].join('\n');
}
