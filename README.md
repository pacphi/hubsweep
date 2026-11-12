# hubsweep

**Have my GitHub repos been hit?** hubsweep answers that for every repo your GitHub login can reach, and, if you
like, for the computer you run it on. It looks for the traces supply-chain campaigns leave behind, using one rule
pack per campaign, so it keeps working when the next one comes along.

- **Read-only.** It only makes GET requests through the GitHub CLI and only reads files on your machine. It never
  closes, deletes, rotates or comments on anything.
- **Honest about gaps.** Anything it can't read is listed under "Couldn't check", never counted as clean.
- **No dependencies.** Node 22+ and the GitHub CLI (`gh`). Windows, macOS and Linux, tested on all three.
- **A Claude skill included**, for Claude Code and Claude chat.

Ships with packs for **wfx-loot** (November 2026) and **GhostAction** (October 2026).

## How this started

On the morning of 12 November 2026, a LinkedIn post by Mackenzie Jackson, Field CTO at
[Aikido Security](https://www.aikido.dev), turned up in my feed: *"We are currently tracking a massive GitHub Actions
supply chain attack where 4,800+ compromised accounts are pushing secret-stealing workflows to over 61,000
repositories."* It credited Oliver Smith's research and listed things to search for: a PR titled
`docs: dependency audit notes`, branches named `wfx-docs` or `chore/…`, commits like `ci: refresh build cache`, and
"skipped or missing run numbers" in Actions history.

That last one is the nasty part. Oliver Smith's write-up,
[wfx-loot campaign pushes CI secret stealer to tens of thousands of repositories](https://www.aikido.dev/blog/compromised-github-accounts-push-ci-secret-stealer-to-tens-of-thousands-of-repositories),
explains why: the attacker uses each stolen token to open a probe PR, pushes the payload, reverts it within a minute
and **deletes the workflow run and its logs**. A gap in the run numbers is often the only trace. The payload takes
every secret the workflow can see, swaps OIDC tokens for AWS, GCP and Azure sessions, and leaves back doors that
survive rotating secrets.

I look after a few hundred repos across my own account and several organisations. GitHub's search box can find the
probe PRs, but not a payload pushed to a branch that was deleted a minute later, or a run that no longer exists. So I
asked Claude to plan a survey, keep it strictly read-only, and then run it. The first version was a single script.
It swept 243 repos (including archived repos and forks) and 77 local checkouts in under an hour, and found nothing.
That was a relief, but the useful part was the script, so this is that script made general: rule packs instead of
hard-coded strings, flags instead of my account names, every operating system, tests, and a skill so anyone can ask
Claude to run it.

## Quick start

```sh
gh auth login                                   # once; hubsweep reads GitHub as you
npx --yes github:pacphi/hubsweep                # sweep every repo you can reach
npx --yes github:pacphi/hubsweep --local ~/code # ...and this computer, plus the git checkouts under ~/code
```

Or clone it and run `node bin/hubsweep.mjs`. If `gh` isn't installed, hubsweep offers to install it (Homebrew,
winget, apt, dnf, zypper or pacman) and only does so if you say yes.

It writes `hubsweep-report.md` and `hubsweep-report.json` and exits with:

| Exit | Meaning |
| --- | --- |
| 0 | nothing found |
| 10 | high findings: treat them as real |
| 11 | things to check by eye |
| 12 | nothing found, but some checks couldn't run (see "Couldn't check") |
| 2 / 3 | bad arguments / `gh` missing or not signed in |

### Options

```text
--owner <login>      only these users or orgs (repeatable); default: every repo your login can reach
--repo <owner/name>  only these repos (repeatable)
--since <when>       a date or a number of days (14d); default: the packs' earliest start, at most 90 days back
--pack <id>          only these rule packs;   --rules <dir>  add your own packs;   --list-packs  show them
--local <dir>        also check this computer and the git checkouts under <dir> (repeatable); --local-only skips GitHub
--no-forks, --no-archived, --concurrency <n>, --out <dir>, --yes
```

## What a report looks like

```markdown
**Result:** **3 high findings** in 1 place. Treat them as real until you've shown otherwise.

| Severity | Where | What | Rule pack |
| --- | --- | --- | --- |
| HIGH | octo-org/api | PR #212 "docs: dependency audit notes" by octo-user (open) | wfx-loot-2026-11 |
| HIGH | octo-org/api | commit 9f2c1e7a3b "ci: refresh build cache" by octo-user | wfx-loot-2026-11 |
| HIGH | octo-org/api | commit 9f2c1e7a3b adds "194.150.166.244" in .github/workflows/ci.yml | wfx-loot-2026-11 |
| CHECK | octo-org/api | workflow "CI" is missing run number 418 (deleted runs) | generic |
```

Then: what to do now (from the pack's advice), lower-signal things to look at (force pushes and branch deletions,
grouped by who did them), your account's own activity, a checklist of account pages GitHub won't let tools read,
what was checked on your machine, everything that couldn't be checked, and every repo covered.

## How it works

For each repo (four at a time, waiting out GitHub's rate limit when it gets close):

| Step | API | Catches |
| --- | --- | --- |
| Pull requests opened in the window | `pulls?state=all` | probe PRs, open or closed |
| Branches now | `branches` | leftover campaign branches |
| Default-branch file tree | `git/trees?recursive=1` | campaign files sitting on `main` (one call per repo) |
| Repo activity | `activity` | every push, force push, branch create and delete in the window, **including branches deleted since** |
| What each push changed | `compare/before...after` | payload commit messages, added files, and added lines, **even if reverted a minute later** |
| Actions runs | `actions/runs?created>=` | **gaps in run numbers** (deleted runs) and runs on campaign branches |
| Statuses on new default-branch commits | `commits/{sha}/statuses` | `success` statuses posted by a person instead of an app (forged required checks) |
| Your account's events | `users/{you}/events` | what your login did in the window |

Repos nobody pushed to inside the window get only the first three checks, so a big account stays affordable.

On the machine (`--local`): `crontab -l` and `/etc/cron.d`, launch agents and daemons on macOS, systemd user units
and autostart on Linux, scheduled tasks and the Startup folder on Windows; and in every git checkout under the
folders you name, tracked file names, text (`git grep`), commit messages on every local branch, npm install scripts,
and VS Code tasks that run when a folder is opened.

The code is small and split by job: `src/rules.mjs` (load and check packs), `src/checks.mjs` (pure matching, all
unit-tested), `src/sweep.mjs` (GitHub), `src/local.mjs` (machine), `src/gh.mjs` (the read-only `gh api` wrapper with
rate-limit handling), `src/report.mjs`, `src/install.mjs` and `src/cli.mjs`.

## Rule packs

A campaign is a JSON file: who found it, where it was published, when it started, and lists of regular expressions
for PR titles, branch names, commit subjects, workflow file names, file paths, added lines, npm install scripts, cron
lines, launch agents and more. [`rules/SCHEMA.md`](rules/SCHEMA.md) has the format; [`rules/`](rules) holds the
shipped packs. To check for something new, write a pack and run:

```sh
hubsweep --rules ./my-packs --pack my-campaign-2026-12
```

Pull requests with packs for new public campaigns are welcome: include the source, credits, and a test.

Some checks need no pack and always run: deleted runs, workflow edits that dump `toJSON(secrets)` or `toJSON(vars)`,
add `id-token: write`, call a raw IP address or use `pull_request_target`, person-posted `success` statuses, and
VS Code tasks that run on folder open.

## Use it with Claude

The `hubsweep` skill tells Claude how to run the sweep, read the report with you, and draft a rule pack from an
advisory you paste. It never takes action on a finding by itself.

**Claude Code**

```text
/plugin marketplace add pacphi/hubsweep
/plugin install hubsweep@hubsweep
```

Then ask: *"Have my GitHub repos been hit by wfx-loot?"* It checks for Node and `gh`, offers to install `gh` if it's
missing, agrees the scope with you, runs the sweep and explains the result. hubsweep is also listed in the
[portfolio-radar marketplace](https://github.com/agentic-incubator/portfolio-radar-plugin).

**Claude chat (claude.ai)**

Download `hubsweep-skill.zip` from the [latest release](https://github.com/pacphi/hubsweep/releases/latest), then
upload it under **Settings → Capabilities → Skills**. Chat can't run commands on your computer, so there the skill
uses the GitHub connector (if you've connected it) for the quick checks, gives you the commands for the full sweep,
and reads the report with you when you upload it.

## Limits

- GitHub doesn't let tools read your security log, and an organisation's audit log needs an owner. The report gives
  you a checklist for both. A deleted run you didn't delete (`action:workflows.delete_workflow_run`) is the
  strongest single sign.
- Repo activity goes back 90 days, so the window does too.
- A thief using your token acts as you: activity under your own name isn't proof of innocence.
- Rule packs only know what has been published. The generic checks help with the rest.

## Credits

- **Oliver Smith, [Aikido Security](https://www.aikido.dev)**, for the wfx-loot research and indicators:
  [the write-up](https://www.aikido.dev/blog/compromised-github-accounts-push-ci-secret-stealer-to-tens-of-thousands-of-repositories).
- **Mackenzie Jackson, Aikido Security**, whose post raised the alarm and is how this project started.
- The GhostAction indicators are as summarised in the same Aikido write-up.
- Built with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE). Built with ❤️ by Chris Phillipson, Principal, CP Ventures Group, LLC.
