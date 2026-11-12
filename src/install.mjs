// Finding gh, and offering (never forcing) to install it.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

const inherit = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit' }); return { code: r.status ?? 1, stderr: r.error ? r.error.message : '' }; };

export function installCommand(platform, has) {
  if (platform === 'darwin') return has.brew ? ['brew', ['install', 'gh']] : null;
  if (platform === 'win32') return has.winget ? ['winget', ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget']] : null;
  if (platform === 'linux') {
    if (has['apt-get']) return ['sudo', ['apt-get', 'install', '-y', 'gh']];
    if (has.dnf) return ['sudo', ['dnf', 'install', '-y', 'gh']];
    if (has.zypper) return ['sudo', ['zypper', 'install', '-y', 'gh']];
    if (has.pacman) return ['sudo', ['pacman', '-S', '--noconfirm', 'github-cli']];
  }
  return null;
}

const which = async (exec, platform, cmd) => (await exec(platform === 'win32' ? 'where' : 'which', [cmd])).code === 0;

// ensureGh({ exec, platform, ask, log, yes }) -> true when gh is ready to use
export async function ensureGh({ exec, platform, log, ask = defaultAsk, yes = false, run = inherit }) {
  if ((await exec('gh', ['--version'])).code === 0) return true;
  const has = {};
  for (const c of ['brew', 'winget', 'apt-get', 'dnf', 'zypper', 'pacman']) has[c] = await which(exec, platform, c);
  const cmd = installCommand(platform, has);
  log('The GitHub CLI (gh) is not installed. hubsweep reads GitHub through it.');
  if (!cmd) { log('Install it from https://cli.github.com, run `gh auth login`, then run hubsweep again.'); return false; }
  const line = [cmd[0], ...cmd[1]].join(' ');
  const ok = yes || /^y(es)?$/i.test((await ask(`Install it now with \`${line}\`? [y/N] `)).trim());
  if (!ok) { log(`Not installed. To install it yourself: ${line}  (or see https://cli.github.com)`); return false; }
  const r = await run(cmd[0], cmd[1]);
  if (r.code !== 0) { log(`Install failed${r.stderr ? `: ${r.stderr}` : ''}. See https://cli.github.com`); return false; }
  log('gh installed.');
  return (await exec('gh', ['--version'])).code === 0;
}

async function defaultAsk(q) {
  if (!process.stdin.isTTY) return 'n';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(q); } finally { rl.close(); }
}
