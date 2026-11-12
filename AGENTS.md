# AGENTS.md: hubsweep

Rules for any agent or person working here. All rules live in this file; the sibling `CLAUDE.md` contains only `@AGENTS.md`.

- **Read-only, always.** hubsweep only makes GET requests through `gh api`, and only reads files and runs list commands on the machine. Never add a call that writes, comments, closes, deletes, rotates or installs, with one exception: installing `gh` itself, only after the person says yes.
- **No secret values, ever.** Reports hold names, paths, commit messages and links, never a secret's value. Never log a token.
- **Report gaps, never hide them.** Anything that can't be read goes under "Couldn't check". Never show an unreadable thing as clean.
- **Rules are data.** A new campaign is a new file in `rules/`, not a code change. Every shipped pack names its `source` and `credits`, and only uses public indicators.
- **No dependencies.** Node 22+ built-ins only. It must run on Windows, macOS and Linux; CI tests all three.
- **Tests.** `npm test` before pushing. Every new rule key or check gets a test with a planted example and a near miss. Tests never call the real GitHub.
- **Privacy.** Examples use `octo-user`, `octo-org` and `acme-client`. Never put a real person's repo names or results in this repo.
- **Docs are part of done.** If a flag, rule key or check changes, update `README.md` and `rules/SCHEMA.md` in the same PR.
- **Commits.** Conventional Commits; stage explicit paths only. No AI co-author trailer. Open a PR, get CI green, and stop; the owner merges.
