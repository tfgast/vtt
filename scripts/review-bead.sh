#!/usr/bin/env bash
# Ask Codex to review the current worktree's branch against one bead's scope.
# Prints the review and saves it to .reviews/<bead-id>-<timestamp>.md.
set -euo pipefail

usage() {
  echo "usage: scripts/review-bead.sh <bead-id> [base=main]" >&2
  exit 2
}

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

(($# == 1 || $# == 2)) || usage
bead_id=$1
base=${2:-main}

require_tools git bd codex

top=$(repo_toplevel)
cd "$top"
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "unknown base: $base"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bd show "$bead_id" >"$tmp/bead.txt" || die "bd show $bead_id failed"
git diff "$base...HEAD" -- . ':(exclude)pnpm-lock.yaml' >"$tmp/diff.txt"
[[ -s $tmp/diff.txt ]] || die "empty diff for $base...HEAD (excluding pnpm-lock.yaml); nothing to review"
fence=$(fence_for "$tmp/diff.txt")
branch=$(git rev-parse --abbrev-ref HEAD)

{
  cat <<PROMPT
You are reviewing one implementation branch for the project "A Table of Dumb Objects".

The branch $branch is checked out in the current directory. You may read any
file in it. Read CLAUDE.md first, then the doc sections the bead names under
"Implements:" (in docs/), then the diff below.

The branch implements exactly one beads issue, $bead_id. Its full text
follows. Review the branch against the bead's stated scope: does the change do
what the bead says, correctly, and nothing it says is out of scope?

Rules for your review:
- Findings are advisory input to the orchestrator, not a gate.
- Tag every finding IN-SCOPE (the bead's own text makes it this branch's job)
  or OUT-OF-SCOPE (real, but belongs to another bead or later work).
- For each finding give the file and line, the problem, and a proposed fix.
- State explicitly, condition by condition, whether every "Done when:"
  condition in the bead is met, not met, or cannot be verified from here.
- End with an overall verdict in one or two sentences.

===== BEAD $bead_id =====
PROMPT
  cat "$tmp/bead.txt"
  cat <<PROMPT

===== DIFF $base...HEAD (pnpm-lock.yaml excluded) =====
${fence}diff
PROMPT
  cat "$tmp/diff.txt"
  printf '%s\n' "$fence"
} >"$tmp/prompt.md"

run_codex "$tmp/prompt.md" "$top/.reviews/$bead_id-$(timestamp).md"
