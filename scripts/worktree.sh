#!/usr/bin/env bash
# Create a worktree for one bead: branch <bead-id>/<slug> from main in
# ../vtt-worktrees/<bead-id> (sibling of the main checkout), install
# dependencies, and check that bd can see the bead from inside it.
set -euo pipefail

usage() {
  echo "usage: scripts/worktree.sh <bead-id> <slug>" >&2
  exit 2
}

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

(($# == 2)) || usage
bead_id=$1
slug=$2
[[ $bead_id =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid bead id: $bead_id"
[[ $slug =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid slug (letters, digits, . _ - only): $slug"

require_tools git pnpm bd

repo_toplevel >/dev/null
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_root=$(dirname "$common_dir")
worktrees_dir="$(dirname "$main_root")/vtt-worktrees"
target="$worktrees_dir/$bead_id"
branch="$bead_id/$slug"

bd show "$bead_id" >/dev/null || die "bd show $bead_id failed; is the bead id right?"
[[ ! -e $target ]] || die "already exists: $target"
if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
  die "branch already exists: $branch"
fi
git -C "$main_root" show-ref --verify --quiet refs/heads/main || die "no local branch main"

mkdir -p "$worktrees_dir"
git -C "$main_root" worktree add -b "$branch" "$target" main

cd "$target"
pnpm install --frozen-lockfile

if ! bd show "$bead_id" >/dev/null; then
  die "bd show $bead_id fails inside $target; bd does not find the main repo's .beads from this worktree"
fi

echo "Worktree ready: $target (branch $branch)"
