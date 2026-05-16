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
worktree_config_enabled="$(git -C "$repo_root" config --bool --get extensions.worktreeConfig || true)"
config_scope=(--local)
scope_label="local repo"
if [[ "$worktree_config_enabled" == "true" ]]; then
  config_scope=(--worktree)
  scope_label="worktree"
fi

current_hooks_path="$(git -C "$repo_root" config "${config_scope[@]}" --get core.hooksPath || true)"
if [[ -n "$current_hooks_path" && "$current_hooks_path" != ".githooks" && "$force" -ne 1 ]]; then
  echo "Refusing to overwrite existing ${scope_label} core.hooksPath=$current_hooks_path. Re-run with --force to replace it." >&2
  exit 1
fi

git -C "$repo_root" config "${config_scope[@]}" core.hooksPath .githooks
echo "Configured ${scope_label} core.hooksPath=.githooks"
if [[ "$worktree_config_enabled" != "true" ]]; then
  echo "Note: extensions.worktreeConfig is not enabled; wrote local repo config instead of per-worktree config." >&2
fi
