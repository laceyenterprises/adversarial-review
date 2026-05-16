#!/usr/bin/env bash
set -euo pipefail

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 64
fi

repo_root="$(git rev-parse --show-toplevel)"
current_hooks_path="$(git -C "$repo_root" config --worktree --get core.hooksPath || true)"
if [[ -n "$current_hooks_path" && "$current_hooks_path" != ".githooks" && "$force" -ne 1 ]]; then
  echo "Refusing to overwrite existing worktree core.hooksPath=$current_hooks_path. Re-run with --force to replace it." >&2
  exit 1
fi

git -C "$repo_root" config --worktree core.hooksPath .githooks
echo "Configured worktree core.hooksPath=.githooks"
