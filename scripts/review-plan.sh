#!/usr/bin/env bash
# Ask Codex to review an epic's implementation beads as a plan.
# Prints the review and saves it to .reviews/<epic-id>-<timestamp>.md.
set -euo pipefail

usage() {
  echo "usage: scripts/review-plan.sh <epic-id>" >&2
  exit 2
}

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

(($# == 1)) || usage
epic_id=$1

require_tools git bd codex jq

top=$(repo_toplevel)
cd "$top"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

show_bead_full "$epic_id" >"$tmp/epic.txt" || die "bd show $epic_id failed"
# Children by parent relationship, not by id prefix: a bead reparented into
# the epic keeps its original id.
bd list --parent "$epic_id" --all --limit 0 --json >"$tmp/children.json" ||
  die "bd list --parent $epic_id failed"
children=()
while IFS= read -r id; do
  [[ -n $id ]] && children+=("$id")
done < <(jq -r '.[].id' "$tmp/children.json" | sort -V)
((${#children[@]} > 0)) || die "epic $epic_id has no children"

{
  cat <<PROMPT
You are reviewing the implementation plan for one milestone epic of the
project "A Table of Dumb Objects". The repository is checked out in the
current directory and you may read any file in it.

Read CLAUDE.md first: it defines the bead shape and the loop. Then read the
doc sections the beads name (docs/DESIGN.md, docs/FORMULAS.md, and any others
they cite).

Each implementation bead below goes to a separate agent that sees only that
bead's text plus the doc sections it names, working in its own worktree, with
two or three beads running concurrently. A bead whose scope that agent would
find ambiguous is defective.

Review the plan along these five dimensions:
1. Missing dependencies: beads that need another bead's output, or edit the
   same files, but can run concurrently as recorded.
2. Overlapping scope: two beads that own the same file, test, or decision.
3. Oversized beads: beads that should be split to be reviewable on their own.
4. Gaps against the named doc sections: things the epic promises, or the
   cited sections require, that no bead covers, and Done-when criteria that
   would let a bead finish without delivering what dependents need.
5. Bad decisions: choices in the beads that contradict the docs or will cost
   later milestones.

Give a numbered list of findings. Each finding states the bead id(s), a
severity (blocker / should-fix / nit), the problem, and a proposed change to
the bead text or dependencies. End with an overall verdict: whether the plan
is ready to implement, and what must change first.

===== EPIC $epic_id =====
PROMPT
  cat "$tmp/epic.txt"
  for id in "${children[@]}"; do
    printf '\n===== CHILD %s =====\n' "$id"
    show_bead_full "$id" || die "bd show $id failed"
  done
} >"$tmp/prompt.md"

run_codex "$tmp/prompt.md" "$top/.reviews/$epic_id-$(timestamp).md"
