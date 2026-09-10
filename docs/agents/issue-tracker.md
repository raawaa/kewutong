# Issue tracker: Gitee

Issues and specs for this repo live as Gitee issues at https://gitee.com/raawaa/kewutong. Use the `gitee` CLI for all operations.

## Conventions

- **Create an issue**: `gitee issue create -t "<title>" -b "<body>" --labels <csv>`. The CLI infers the repo from `git remote` when run inside a clone; pass `-R owner/repo` to override. **Multi-line bodies**: write to a temp file and pass `-b "$(cat /path/to/body.md)"` — there is no `--body-file` flag.
- **Read an issue**: `gitee issue view <number>`. Output includes title, body, labels, assignee, state, milestone, comments. For machine-readable output add `-j`.
- **List issues**: `gitee issue list --state open -j | jq '...'`. Filter with `-j` and post-process — there are no per-field flags like on `gh`.
- **Comment**: `gitee issue comment <number> -b "<body>"`. Same multi-line caveat as create.
- **Edit**: `gitee issue edit <number> -t "<title>" -b "<body>" --labels <csv> -a <user> --milestone <n>`. At least one editing flag is required in non-interactive mode.
- **Close / reopen**: `gitee issue close <number>` / `gitee issue reopen <number>`.
- **Labels**: per-repo. There is no `gitee label` subcommand. Create labels with `gitee api repos/<owner>/<repo>/labels -X POST -f "name=<name>" -f "color=<6-hex>" -f "description=<text>"`. Allowed name characters: letters, digits, `.`, `_`, `-`, `/`, `\`, full-width; length 2–20.
- **Issue identifiers**: Gitee uses alphanumeric identifiers (e.g. `ICX4FO`) in API calls, but `#<number>` references in body text render as issue links. Use `#<n>` in body text and the alphanumeric id when scripting.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gitee pr` equivalents.

## When a skill says "publish to the issue tracker"

Create a Gitee issue.

## When a skill says "fetch the relevant ticket"

Run `gitee issue view <number>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder-map`, holding the Notes / Decisions-so-far / Not-yet-specified / Out-of-scope body. `gitee issue create -t "..." -b "$(cat map-body.md)" --labels wayfinder-map`.
- **Child ticket**: Gitee has **no native sub-issues**. The convention is two body-line markers at the top of every child ticket:
  - `Part of: #<map-number>` — links the ticket to the map (rendered as a Gitee issue reference).
  - `Blocked by: #<n>, #<n>` — when the ticket has open blockers; the live gate is "every line item is in `closed` state". To mark a ticket as blocked, edit the ticket's body to include the line; to unblock, edit it again to remove the line.
  Labels: `wayfinder-<type>` — `wayfinder-research` / `wayfinder-prototype` / `wayfinder-grilling` / `wayfinder-task`. Once claimed, the ticket is assigned to the driving dev via `gitee issue edit <n> -a <username>`.
- **Blocking**: Gitee has **no native issue dependencies**. The body-line `Blocked by:` convention is the source of truth.
- **Frontier query**: list the map's tickets by filtering issues whose body contains `Part of: #<map-number>`, are open, are unassigned, and have no open `Blocked by:` references. The exact pipeline is gnarly in pure `jq`; keep a small helper script at `scripts/wayfinder-frontier.sh <map-number>` that:
  1. `gitee issue list --state open -j` to get every open issue
  2. `.[] | select(.body | test("^Part of: #<map-number>"))` to keep only map children
  3. `.[] | select(.assignee == null)` to drop claimed tickets
  4. For each candidate, walk the `Blocked by:` line, look up each referenced issue's state, and drop the candidate if any blocker is still open
  5. Return the first issue-number-order survivor
- **Claim**: `gitee issue edit <n> -a <username>`, the session's first write.
- **Resolve**: `gitee issue comment <n> -b "<answer>"`, then `gitee issue close <n>`, then append a context pointer (one-line gist + `#<n>` link) to the map's **Decisions so far** by editing the map's body (`gitee issue edit <map-n> -b "$(cat updated-map-body.md)"`).
