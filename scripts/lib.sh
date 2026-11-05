# Shared helpers for scripts/*.sh. Source it; do not execute it.
# shellcheck shell=bash

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# require_tools TOOL...: exit non-zero naming every missing tool.
require_tools() {
  local missing=() tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if ((${#missing[@]} > 0)); then
    die "missing required tool(s): ${missing[*]}"
  fi
}

# repo_toplevel: top of the current worktree, or die.
repo_toplevel() {
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git work tree: $PWD"
}

# fence_for FILE: a backtick fence longer than any backtick run in FILE.
fence_for() {
  local fence='```'
  while grep -qF -- "$fence" "$1"; do
    fence="$fence\`"
  done
  printf '%s' "$fence"
}

# run_codex PROMPT_FILE OUT_FILE: run Codex read-only on the prompt from the
# current directory, write its final message to OUT_FILE, then print it.
# Codex progress goes to stderr so stdout carries only the review.
run_codex() {
  local prompt_file=$1 out_file=$2
  mkdir -p "$(dirname "$out_file")"
  echo "Running codex exec (read-only); this takes a few minutes..." >&2
  if ! codex exec --sandbox read-only --skip-git-repo-check -o "$out_file" - \
    <"$prompt_file" >&2; then
    die "codex exec failed"
  fi
  [[ -s $out_file ]] || die "codex produced no output in $out_file"
  cat "$out_file"
  echo >&2
  echo "Saved review to $out_file" >&2
}

timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

# Render a bead in full for a review prompt. `bd show` without --json
# truncates long table cells, so the description comes from the JSON form.
show_bead_full() {
  local id=$1
  bd show "$id" --json | jq -r '
    (if type == "array" then .[0] else . end) as $b |
    "# \($b.id): \($b.title)",
    "status: \($b.status)  priority: P\($b.priority)  type: \($b.issue_type)" +
      (if $b.parent then "  parent: \($b.parent)" else "" end),
    "",
    $b.description,
    "",
    (if ($b.dependencies // []) | length > 0 then
      "Depends on (recorded): " +
        ([$b.dependencies[] | "\(.id) (\(.title))"] | join("; "))
     else "Depends on (recorded): none" end)'
}
