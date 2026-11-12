// Argument parsing and the run itself.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadPacks, BUILTIN_DIR, earliestFrom } from './rules.mjs';
import { createGh, execCmd } from './gh.mjs';
import { listRepos, sweepRepo, accountActivity, pool } from './sweep.mjs';
import { persistence, checkouts, rootsExist, defaultCtx } from './local.mjs';
import { renderMarkdown, renderJson, summarise } from './report.mjs';
import { ensureGh } from './install.mjs';
import { doctor, doctorFailed, renderDoctor, planText } from './doctor.mjs';

export const VERSION = '0.1.0';
export const EXIT = { CLEAN: 0, HIGH: 10, CHECK: 11, GAPS: 12, USAGE: 2, SETUP: 3 };

export const HELP = `hubsweep ${VERSION}: a read-only sweep of your GitHub repos (and, optionally, this machine) for signs of
supply-chain campaigns, driven by rule packs.

Usage: hubsweep [options]

  --owner <login>     only these users or orgs (repeatable). Default: every repo your gh login can reach
  --repo <owner/name> only these repos (repeatable)
  --since <when>      start of the window: a date (2026-11-10) or a number of days (14d).
                      Default: the earliest start date of the selected rule packs, at most 90 days back
  --pack <id>         only these rule packs (repeatable). Default: all
  --rules <dir>       extra rule-pack folder (repeatable); a pack with the same id replaces a built-in one
  --list-packs        list the rule packs and exit
  --local <dir>       also scan this machine: persistence spots and git checkouts under <dir> (repeatable)
  --local-only        skip GitHub; only the machine checks (needs --local for checkouts)
  --no-forks          skip forks          --no-archived   skip archived repos
  --concurrency <n>   repos read at once (default 4)
  --out <dir>         where to write hubsweep-report.md and hubsweep-report.json (default: current folder)
  --doctor            check the prerequisites (Node, gh, sign-in, token access, API budget, git) and exit
  --plan              check the prerequisites, show what the sweep would do, and exit without reading any repo
  --yes               answer yes to the offer to install gh
  -h, --help          this text      --version   the version

Exit codes: 0 nothing found, 10 high findings, 11 things to check, 12 nothing found but some checks failed,
2 bad arguments, 3 gh missing or not signed in.`;

export function parseArgs(argv, now = new Date()) {
  const o = { owners: [], repos: [], packs: [], rules: [], local: [], forks: true, archived: true, concurrency: 4, out: '.', yes: false, localOnly: false, listPacks: false, doctor: false, plan: false, since: null, help: false, version: false };
  const need = (i, flag) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--owner': o.owners.push(need(i, a)); i++; break;
      case '--repo': { const v = need(i, a); if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(`--repo wants owner/name, got ${v}`); o.repos.push(v); i++; break; }
      case '--since': o.since = parseSince(need(i, a), now); i++; break;
      case '--pack': o.packs.push(need(i, a)); i++; break;
      case '--rules': o.rules.push(resolve(need(i, a))); i++; break;
      case '--local': o.local.push(resolve(expandHome(need(i, a)))); i++; break;
      case '--local-only': o.localOnly = true; break;
      case '--list-packs': o.listPacks = true; break;
      case '--no-forks': o.forks = false; break;
      case '--no-archived': o.archived = false; break;
      case '--concurrency': { const n = Number(need(i, a)); if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--concurrency must be 1 to 16'); o.concurrency = n; i++; break; }
      case '--out': o.out = need(i, a); i++; break;
      case '--yes': o.yes = true; break;
      case '--doctor': o.doctor = true; break;
      case '--plan': o.plan = true; break;
      case '-h': case '--help': o.help = true; break;
      case '--version': o.version = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

const expandHome = p => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p);

export function parseSince(v, now = new Date()) {
  const m = /^(\d+)d$/.exec(v);
  if (m) return new Date(now.getTime() - Number(m[1]) * 86400e3);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--since wants a date or a number of days like 14d, got ${v}`);
  return new Date(t);
}

// The window: --since, else the packs' earliest start, never more than 90 days back (GitHub keeps activity for 90)
export function windowStart(opt, packs, now = new Date()) {
  const floor = new Date(now.getTime() - 90 * 86400e3);
  const want = opt.since || earliestFrom(packs) || new Date(now.getTime() - 14 * 86400e3);
  return want < floor ? floor : want;
}

export async function main(argv, { exec = execCmd, log = m => process.stderr.write(`${m}\n`), out = m => process.stdout.write(`${m}\n`), platform = process.platform, now = new Date(), ask } = {}) {
  let opt;
  try { opt = parseArgs(argv, now); } catch (e) { log(`hubsweep: ${e.message}\n\n${HELP}`); return EXIT.USAGE; }
  if (opt.help) { out(HELP); return EXIT.CLEAN; }
  if (opt.version) { out(VERSION); return EXIT.CLEAN; }

  const { packs, errors } = loadPacks({ dirs: [BUILTIN_DIR, ...opt.rules], only: opt.packs });
  if (opt.listPacks) {
    for (const p of packs) out(`${p.id}\t${p.name}\tfrom ${p.active?.from ?? 'any time'}\t${p.source}`);
    for (const e of errors) log(`! ${e}`);
    return errors.length ? EXIT.USAGE : EXIT.CLEAN;
  }
  if (!packs.length) { log(`hubsweep: no usable rule packs.${errors.length ? `\n${errors.join('\n')}` : ''}`); return EXIT.USAGE; }

  const since = windowStart(opt, packs, now);
  const result = { tool: `hubsweep ${VERSION}`, generated: now.toISOString(), platform, since: since.toISOString(), login: null, packs, findings: [], notes: [], gaps: [...errors.map(e => `rule pack: ${e}`)], repoCount: 0, deepCount: 0, repoNames: [], calls: 0, account: null, local: null };

  // 1. Prerequisites: offer to install gh, then check everything else before reading anything
  if (!opt.localOnly && !opt.doctor && !(await ensureGh({ exec, platform, log, yes: opt.yes, ...(ask ? { ask } : {}) }))) return EXIT.SETUP;
  const checks = await doctor({ exec, platform, out: opt.out, local: opt.local, localOnly: opt.localOnly });
  log(`Checking what hubsweep needs:\n${renderDoctor(checks)}\n`);
  if (doctorFailed(checks)) { log('hubsweep: fix the items marked ✗ above, then run it again. Nothing was read.'); return EXIT.SETUP; }
  if (opt.doctor) return EXIT.CLEAN;
  const signedIn = checks.find(c => c.name === 'Signed in to GitHub');
  const login = signedIn ? signedIn.detail.replace(/^as /, '') : null;
  // 2. Say what will happen, in plain words, before doing it
  log(`${planText({ login, owners: opt.owners, repos: opt.repos, since, packs, local: opt.local, localOnly: opt.localOnly, out: opt.out })}\n`);
  if (opt.plan) return EXIT.CLEAN;

  if (!opt.localOnly) {
    result.login = login;
    const gh = createGh({ exec, log });
    log(`hubsweep: reading repos for ${result.login} (window from ${since.toISOString().slice(0, 10)}; packs: ${packs.map(p => p.id).join(', ')})`);
    const { repos, gaps } = await listRepos(gh, { owners: opt.owners, repos: opt.repos, forks: opt.forks, archived: opt.archived });
    result.gaps.push(...gaps);
    result.repoCount = repos.length;
    result.repoNames = repos.map(r => r.full_name);
    let done = 0;
    const per = await pool(repos, opt.concurrency, async r => {
      const x = await sweepRepo(gh, r, { packs, since });
      done++;
      if (done % 10 === 0 || done === repos.length) log(`  ${done}/${repos.length} repos`);
      return x;
    });
    for (const x of per) {
      result.findings.push(...x.findings);
      result.notes.push(...x.notes.map(n => `${x.repo}: ${n}`));
      result.gaps.push(...x.gaps.map(g => `${x.repo}: ${g}`));
      if (x.deep) result.deepCount++;
    }
    const acct = await accountActivity(gh, result.login, { packs, since });
    result.account = { summary: acct.summary };
    result.findings.push(...acct.findings);
    result.gaps.push(...acct.gaps);
    result.calls = gh.calls();
  }

  if (opt.local.length || opt.localOnly) {
    const ctx = defaultCtx({ platform, exec });
    const roots = rootsExist(opt.local);
    for (const r of opt.local) if (!roots.includes(r)) result.gaps.push(`local folder not found: ${r}`);
    log('hubsweep: checking this machine');
    const pers = await persistence(ctx, packs);
    const co = await checkouts(ctx, packs, roots, since);
    result.findings.push(...pers.findings, ...co.findings);
    result.gaps.push(...pers.gaps, ...co.gaps);
    for (const i of co.ignored) result.notes.push(`${i.repo}: its .hubsweep-ignore (${i.patterns.join(', ')}; last changed ${i.lastChange || 'not yet committed'}) skipped indicator matches in ${i.files.length} file${i.files.length === 1 ? '' : 's'}${i.files.length ? `: ${i.files.slice(0, 12).join(', ')}${i.files.length > 12 ? ', …' : ''}` : ''}. Make sure you or your team wrote that file.`);
    result.local = { coverage: pers.coverage, scanned: co.scanned, roots };
  }

  mkdirSync(opt.out, { recursive: true });
  const md = join(opt.out, 'hubsweep-report.md');
  writeFileSync(md, renderMarkdown(result));
  writeFileSync(join(opt.out, 'hubsweep-report.json'), renderJson(result));
  const s = summarise(result);
  out(`hubsweep: ${s.high} high, ${s.check} to check, ${result.gaps.length} couldn't check. Report: ${md}`);
  return { HIGH: EXIT.HIGH, CHECK: EXIT.CHECK, CLEAN_WITH_GAPS: EXIT.GAPS, CLEAN: EXIT.CLEAN }[s.verdict];
}
