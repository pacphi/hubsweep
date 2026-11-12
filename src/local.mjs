// The machine side: persistence spots and local git checkouts. Read-only on every platform.
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { firstMatch } from './rules.mjs';
import { isWoff2 } from './checks.mjs';
import { execCmd } from './gh.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache', 'Library', 'AppData']);

export function defaultCtx(over = {}) {
  return { platform: process.platform, home: homedir(), env: process.env, exec: execCmd, read: f => readFileSync(f, 'utf8'), ...over };
}

const filesIn = dir => { try { return readdirSync(dir).map(f => join(dir, f)).filter(f => { try { return statSync(f).isFile(); } catch { return false; } }); } catch { return null; } };
const safeRead = (ctx, f) => { try { return ctx.read(f); } catch { return null; } };

// persistence(ctx, packs) -> { findings, coverage, gaps }
export async function persistence(ctx, packs) {
  const findings = [], coverage = [], gaps = [];
  const hit = (pack, key, where, line) => findings.push({ severity: pack.severity === 'check' || pack.checkOnly.includes(key) ? 'CHECK' : 'HIGH', pack: pack.id, kind: key, repo: 'this machine', evidence: `${where}: ${String(line).trim().slice(0, 160)}` });
  const scanText = (key, where, text) => { for (const p of packs) for (const line of String(text).split('\n')) if (firstMatch(p.host[key], line)) { hit(p, key, where, line); break; } };

  if (ctx.platform === 'darwin' || ctx.platform === 'linux') {
    const r = await ctx.exec('crontab', ['-l']);
    if (r.code === 0) { scanText('cron', 'crontab', r.stdout); coverage.push('crontab'); }
    else if (/no crontab/i.test(r.stderr)) coverage.push('crontab (empty)');
    else gaps.push(`crontab: ${r.stderr.trim() || 'could not be read'}`);
  }
  const dirScan = (key, label, dirs) => {
    let seen = 0;
    const denied = [];
    for (const d of dirs) {
      if (!existsSync(d)) { seen++; continue; } // nothing there is nothing planted
      const files = filesIn(d);
      if (!files) { denied.push(d); continue; }
      seen++;
      for (const f of files) { const t = safeRead(ctx, f); if (t != null) scanText(key, f, `${f}\n${t}`); }
    }
    if (seen) coverage.push(label);
    for (const d of denied) gaps.push(`${label}: ${d} could not be read`);
  };
  if (ctx.platform === 'darwin') dirScan('launchAgents', 'launch agents', [join(ctx.home, 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']);
  if (ctx.platform === 'linux') {
    dirScan('userUnits', 'user services and autostart', [join(ctx.home, '.config/systemd/user'), join(ctx.home, '.config/autostart')]);
    dirScan('cron', 'cron.d', ['/etc/cron.d']);
  }
  if (ctx.platform === 'win32') {
    const r = await ctx.exec('schtasks', ['/query', '/fo', 'LIST', '/v']);
    if (r.code === 0) { scanText('scheduledTasks', 'scheduled task', r.stdout); coverage.push('scheduled tasks'); }
    else gaps.push(`scheduled tasks: ${r.stderr.trim() || 'could not be read'}`);
    dirScan('scheduledTasks', 'Startup folder', [join(ctx.env.APPDATA || join(ctx.home, 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Startup')]);
  }
  return { findings, coverage, gaps };
}

// findRepos(roots, maxDepth) -> git checkout folders under the roots
export function findRepos(roots, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === '.git')) { out.push(dir); }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

const head4 = f => { try { const fd = openSync(f, 'r'); const b = Buffer.alloc(4); readSync(fd, b, 0, 4, 0); closeSync(fd); return b; } catch { return null; } };

// .hubsweep-ignore: paths in a checkout that hold indicators on purpose (rule packs, tests, docs about an attack).
// One pattern per line; `#` starts a comment; `dir/` covers everything under it; `*` matches within one path part,
// `**` across parts. Only file-path and file-content matches are skipped: install hooks, commits and editor tasks
// are always checked, and every skip is listed in the report.
export function parseIgnore(text) {
  const toRe = pat => {
    let p = pat.replace(/^\/+/, '');
    const dir = p.endsWith('/');
    if (dir) p = p.slice(0, -1);
    const body = p.split('**').map(part => part.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${body}${dir ? '/' : '(/|$)'}`);
  };
  const pats = String(text || '').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  return { patterns: pats, test: f => pats.some(x => toRe(x).test(f)) };
}

// checkouts(ctx, packs, roots, since) -> { findings, scanned, gaps, ignored }
export async function checkouts(ctx, packs, roots, since) {
  const findings = [], gaps = [], ignored = [];
  const repos = findRepos(roots);
  const git = (repo, args) => ctx.exec('git', ['-c', 'safe.directory=*', '-C', repo, ...args]);
  const add = (repo, pack, key, evidence) => findings.push({ severity: pack.severity === 'check' || pack.checkOnly.includes(key) ? 'CHECK' : 'HIGH', pack: pack.id, kind: key, repo, evidence });
  const strings = packs.flatMap(p => p.host.repoStrings.map(r => r.source));
  for (const repo of repos) {
    const ls = await git(repo, ['ls-files', '-z']);
    if (ls.code !== 0) { gaps.push(`${repo}: ${ls.stderr.trim().split('\n')[0] || 'git ls-files failed'}`); continue; }
    const files = ls.stdout.split('\0').filter(f => f && !f.includes('node_modules/'));
    const ign = files.includes('.hubsweep-ignore') ? parseIgnore(safeRead(ctx, join(repo, '.hubsweep-ignore'))) : null;
    const skipped = new Set();
    const skip = f => { if (ign && ign.test(f)) { skipped.add(f); return true; } return false; };
    for (const p of packs) for (const f of files) {
      if (!firstMatch(p.host.repoFiles, f) || skip(f)) continue;
      if (/\.woff2$/.test(f)) {
        const b = head4(join(repo, f));
        if (b && isWoff2(b)) continue; // a real font
      }
      add(repo, p, 'repoFiles', `tracked file ${f}`);
    }
    // editor tasks that run when the folder opens (GhostAction's trick), whatever the pack
    for (const f of files.filter(f => /(^|\/)\.vscode\/tasks\.json$/.test(f))) {
      const t = safeRead(ctx, join(repo, f));
      if (t && /"runOn"\s*:\s*"folderOpen"/.test(t)) findings.push({ severity: 'CHECK', pack: null, kind: 'editor task', repo, evidence: `${f} runs a task when the folder is opened in VS Code` });
    }
    for (const f of files.filter(f => /(^|\/)package\.json$/.test(f))) {
      let scripts;
      try { scripts = JSON.parse(safeRead(ctx, join(repo, f)) || '{}').scripts || {}; } catch { continue; }
      for (const k of ['preinstall', 'install', 'postinstall']) for (const p of packs) if (scripts[k] && firstMatch(p.host.npmScripts, scripts[k])) add(repo, p, 'npmScripts', `${f} ${k}: ${scripts[k].slice(0, 120)}`);
    }
    if (strings.length) {
      const g = await git(repo, ['grep', '-lIE', strings.join('|'), '--', '.', ':!**/node_modules/**']);
      if (g.code === 0) for (const f of g.stdout.split('\n').filter(Boolean)) {
        if (skip(f)) continue;
        const t = safeRead(ctx, join(repo, f)) || '';
        for (const p of packs) { const m = p.host.repoStrings.find(r => r.test(t)); if (m) add(repo, p, 'repoStrings', `${f} contains ${m.source}`); }
      } else if (g.code > 1) gaps.push(`${repo}: git grep failed`);
    }
    if (packs.some(p => p.host.repoCommits.length)) {
      const log = await git(repo, ['log', '--all', `--since=${since.toISOString()}`, '--format=%H%x09%s']);
      if (log.code === 0) for (const line of log.stdout.split('\n').filter(Boolean)) {
        const [sha, subject] = line.split('\t');
        for (const p of packs) if (firstMatch(p.host.repoCommits, subject)) add(repo, p, 'repoCommits', `commit ${sha.slice(0, 10)} "${subject}" (in a local branch or fetched ref)`);
      }
    }
    if (ign) {
      const last = await git(repo, ['log', '-1', '--format=%h %ad %an', '--date=short', '--', '.hubsweep-ignore']);
      ignored.push({ repo, patterns: ign.patterns, files: [...skipped].sort(), lastChange: last.code === 0 ? last.stdout.trim() : '' });
    }
  }
  return { findings, scanned: repos.length, gaps, ignored };
}

export const rootsExist = roots => roots.filter(r => existsSync(r));
