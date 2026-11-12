# Rule pack format

One JSON file per campaign, in `rules/` (shipped) or any folder you pass with `--rules <dir>`. A pack in a later
folder replaces a shipped one with the same `id`; `{ "id": "...", "disabled": true }` turns one off.

```json
{
  "id": "acme-campaign-2026-12",
  "name": "Short human name",
  "source": "https://link-to-the-write-up",
  "credits": "Who found it",
  "active": { "from": "2026-12-01T00:00:00Z", "until": null },
  "severity": "high",
  "checkOnly": ["workflowFiles"],
  "advice": "One or two sentences on what to do if it matches.",
  "github": { "prTitles": [], "branches": [], "commitSubjects": [], "workflowFiles": [], "files": [], "content": [], "npmScripts": [] },
  "host": { "cron": [], "launchAgents": [], "userUnits": [], "scheduledTasks": [], "repoFiles": [], "repoStrings": [], "repoCommits": [], "npmScripts": [] }
}
```

| Field | Meaning |
| --- | --- |
| `id` | lowercase letters, digits and dashes; unique |
| `name`, `source`, `credits` | shown in the report; `source` must be a public link |
| `active.from` | the default start of the sweep window (`--since` overrides; never more than 90 days back) |
| `severity` | `high` (default) or `check` for the whole pack |
| `checkOnly` | marker keys whose hits are only `CHECK`, for markers that also match normal repos (for example common workflow names) |
| `advice` | printed under "What to do now" when the pack has a high finding |

Every marker list holds JavaScript regular expressions, matched against one thing at a time:

| Key | Matched against |
| --- | --- |
| `github.prTitles` | titles of PRs opened in the window |
| `github.branches` | branch names: existing branches, branches created, deleted or pushed in the window, branches that ran workflows, PR head branches |
| `github.commitSubjects` | the first line of every commit pushed in the window, on any branch, including branches deleted since |
| `github.workflowFiles` | file names under `.github/workflows/`, added or changed in the window or on the default branch now |
| `github.files` | any path added or changed in the window, or on the default branch now |
| `github.content` | each line a push in the window added, in any file |
| `github.npmScripts` | added `preinstall`, `install` or `postinstall` lines in a `package.json` |
| `host.cron` | each line of `crontab -l` (macOS, Linux) and files in `/etc/cron.d` (Linux) |
| `host.launchAgents` | name and contents of each file in `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` (macOS) |
| `host.userUnits` | name and contents of each file in `~/.config/systemd/user` and `~/.config/autostart` (Linux) |
| `host.scheduledTasks` | `schtasks /query /fo LIST /v` lines and the Startup folder's files (Windows) |
| `host.repoFiles` | paths tracked by git in each checkout under `--local` folders (a `.woff2` that starts with a real font header is left alone) |
| `host.repoStrings` | text in tracked files, found with `git grep -E`, so keep these POSIX ERE-compatible (no `\d`, no lookahead) |
| `host.repoCommits` | subjects of commits on every local branch and fetched ref inside the window |
| `host.npmScripts` | `preinstall`, `install` and `postinstall` values in tracked `package.json` files |

Some checks need no pack and always run: missing Actions run numbers (deleted runs), workflow edits that dump
`toJSON(secrets)` or `toJSON(vars)`, add `id-token: write`, call a raw IP or use `pull_request_target`, `success`
statuses posted by a person instead of an app, and VS Code tasks that run when a folder opens.

A checkout can opt paths out of `host.repoFiles` and `host.repoStrings` with a tracked `.hubsweep-ignore` (see the
README). The other keys still apply there, and the report lists every skipped file.

Before opening a PR with a new pack: add a planted example and a near miss for it to `test/checks.test.mjs`, and
run `npm test`. Write regular expressions tightly (anchor with `^` and `$`); a pack that floods people with
false alarms gets ignored.
