A Table of Dumb Objects: design and formula language in [docs/](docs/).
Project conventions and workflow in [CLAUDE.md](CLAUDE.md).

## Workflow

Scripts in [scripts/](scripts/) encode the loop in [CLAUDE.md](CLAUDE.md). They are plain bash
and need `git`, `bd`, `pnpm`, `codex`, and `jq` on `PATH`; each exits non-zero with a message if a tool
it uses is missing.

- `scripts/worktree.sh <bead-id> <slug>` creates branch `<bead-id>/<slug>` from `main` in
  `../vtt-worktrees/<bead-id>` (next to the main checkout), runs `pnpm install --frozen-lockfile`
  there, and checks that `bd show <bead-id>` works from inside the new worktree.
- `scripts/review-bead.sh <bead-id> [base]` runs from inside a bead's worktree. It sends Codex
  (`codex exec`, read-only sandbox) the bead text, review rules (findings are advisory and tagged
  IN-SCOPE or OUT-OF-SCOPE; every Done-when condition gets a verdict), and `git diff <base>...HEAD`
  without `pnpm-lock.yaml`. `base` defaults to `main`.
- `scripts/review-plan.sh <epic-id>` sends Codex the epic and every child bead and asks for
  missing dependencies, overlapping scope, oversized beads, gaps against the named doc sections,
  and bad decisions, each with bead id, severity (blocker / should-fix / nit), problem, and
  proposed change, plus an overall verdict.

Both review scripts print the review to stdout and save it to `.reviews/<id>-<timestamp>.md` in
the current worktree (gitignored). Codex progress goes to stderr. A review takes a few minutes.
