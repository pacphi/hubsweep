---
name: hubsweep
description: Check whether your GitHub repos (and optionally this computer) show signs of a supply-chain campaign such as wfx-loot or GhostAction, read-only, and explain the result. Use when someone asks "have I been hit by…", "check my repos for compromise", "scan for the GitHub Actions secret stealer", or pastes an advisory and asks if they're affected.
---

# hubsweep

hubsweep reads every GitHub repo the person's `gh` login can reach and looks for the traces a campaign leaves: probe
pull requests, throwaway branches, payload commits (even ones reverted or on branches deleted since), workflow files,
deleted Actions runs and forged status checks. With `--local` it also checks the computer: cron, launch agents,
systemd user units, Windows scheduled tasks, and git checkouts. Campaigns are described by rule packs (JSON).

**It is read-only.** It never closes, deletes, rotates, comments or installs anything, except installing the GitHub CLI
after the person says yes. Never take any of those actions yourself on the strength of a finding; describe them and
let the person decide.

## In Claude Code (or any agent with a shell)

People run this because they are worried. Keep them calm and in control: say what you are about to do before each
step, ask before anything that installs, and never surprise them.

1. **Say what's coming.** In two or three sentences: you'll check their computer has what hubsweep needs, show them
   exactly what the sweep will read, and only start when they say so. It only reads; nothing on GitHub or their
   computer changes.
2. **Find the tool.** If this skill came with the hubsweep plugin, the command is
   `node "${CLAUDE_PLUGIN_ROOT}/bin/hubsweep.mjs"`; otherwise `npx --yes github:pacphi/hubsweep`. Check
   `node --version` first: hubsweep needs Node 22 or newer. If Node is missing or older, stop and point them to
   https://nodejs.org (offer the command for their system, such as `brew install node`, `winget install OpenJS.NodeJS.LTS`
   or their Linux package manager, and run it only on a yes).
3. **Check the prerequisites** with `hubsweep --doctor` (add `--local <folder>` if they want the computer checked).
   It checks, without reading any repo:
   - Node.js version;
   - the GitHub CLI (`gh`) is installed;
   - `gh` is signed in, and as whom;
   - the token's access: `repo` (private repos) and `read:org` (organisation repos). hubsweep never writes, even
     though these scopes would allow it;
   - the GitHub API budget left this hour;
   - `git` (needed for `--local`), and crontab or Windows scheduled tasks;
   - that the report folder is writable.
   Explain each ✗ or ! in plain words and fix it with them:
   - `gh` missing: **ask** whether to install it, naming the command (`brew install gh` on macOS,
     `winget install --id GitHub.cli -e` on Windows, `sudo apt-get install gh`, `sudo dnf install gh`, `sudo zypper install gh`
     or `sudo pacman -S github-cli` on Linux); run it only on a yes. Or run hubsweep without `--doctor` and answer its own prompt.
   - not signed in: they run `gh auth login` themselves (it opens a browser and is interactive).
   - missing scopes: they run `gh auth refresh -s repo,read:org` themselves, or accept that some repos are skipped.
   - low API budget: hubsweep waits for the reset by itself; offer to run later.
   Re-run `--doctor` until there is no ✗.
4. **Agree the scope** in one question with a default: every repo their login can reach (default), or some owners
   (`--owner`, repeatable) or repos (`--repo owner/name`); and whether to check this computer too
   (`--local <folder with their git checkouts>`, repeatable).
5. **Show the plan** with the same options plus `--plan`. It prints, step by step, what will be read and what will
   not happen. Relay it in your own words, mention a large account can take 20 to 60 minutes, and **ask whether to start**.
6. **Run it** on a yes, in the background, with a report folder, for example
   `--local ~/code --out ./hubsweep-$(date +%F)`. Give a short progress note now and then. `--list-packs` shows the
   campaigns it knows; `--pack <id>` limits to some; `--rules <dir>` adds their own.
7. **Read `hubsweep-report.md` and explain it** in plain words:
   - exit 10 / HIGH: name each finding, the repo and the link. Tell them to treat it as real: lock the account first
     (sessions, tokens, SSH keys, authorised apps), then rotate every secret and cloud role the affected workflows
     could reach, then clean up. Quote the pack's advice. Offer to help, but take no action on GitHub or their
     machine without their explicit yes for that action.
   - exit 11 / CHECK: what each item means (a deleted run, a workflow that dumps secrets, a user-posted success
     status) and how to tell if it is theirs.
   - exit 12: nothing found, but list what couldn't be checked. Never call that clean.
   - exit 0: clean for the window and packs used. Still hand them the "Your account" checklist from the report:
     GitHub doesn't let tools read the security log, so they must look themselves.
8. **New campaign?** If they paste an advisory, draft a rule pack from its indicators following `rules/SCHEMA.md`
   (anchored regular expressions, `source` and `credits` set), show it, and on a yes save it to a folder of theirs and
   run with `--rules <that folder> --pack <id>`.

## In Claude chat (no shell on the person's computer)

Claude chat can't run `gh` or read their files, so:

1. If a **GitHub connector** is connected, use it read-only for the fast, high-value checks, using the indicators in
   this skill's `rules/` folder:
   - search their repos for pull requests whose title matches a pack's `prTitles` (for wfx-loot:
     `"docs: dependency audit notes"`), opened since the pack's `active.from`;
   - for the repos they care most about, list branches and match `branches`; list recent commits and match
     `commitSubjects`; list `.github/workflows` and match `workflowFiles`.
   Say plainly which repos you checked and that deleted runs, reverted commits and deleted branches need the full
   tool.
2. Otherwise, or as well, give them the exact commands to run hubsweep themselves (steps 1 to 4 above), and offer to
   read the report with them when they paste or upload `hubsweep-report.md`.
3. Always give the account checklist: security log, sessions, tokens, SSH keys, authorised apps, and (for org
   owners) the audit log filtered on `action:workflows.delete_workflow_run`.

## What it can't see

- GitHub's security log and org audit logs (no API for personal accounts): the report lists what to check by hand.
- Activity older than 90 days, and repos the login can't read.
- A thief acting with the person's own token shows up under the person's own name: say so when listing activity.
