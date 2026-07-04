# RCA: AMA Closer Hammer Worktree Leak

Date: 2026-07-04

## Summary

First-pass adversarial reviews stopped for fresh PR backlog items while the watcher stayed alive and busy. The watcher tick loop was monopolized by AMA closer hammer dispatches repeatedly wedged on branch-holder-block provision failures. A manual sweep found 31 orphaned `hammer-ama-pr-<N>-<hash>` worktrees under `$HQ_ROOT/workers/`, back to PR #2819. All were for already merged PRs and each still held its PR branch ref. Removing those targeted worktrees unblocked review intake immediately.

## Mechanism

On settled-but-ineligible or exhausted PRs, the AMA closer in `src/watcher.mjs` dispatches a hammer terminal-remediation worker through `hq` with `--worker-class hammer`, `--task-kind merge`, and `--completion-shape decision-only`. Provision creates a worktree like `hammer-ama-pr-<N>-<hash>/agent-os` tracking the PR branch.

Before this fix, teardown relied on the hammer worker reaching its normal lifecycle end. The adversarial-review service did not have a closer-worktree reaper. The only existing reap logic in this area covered follow-up workspaces or process groups, not AMA closer hammer worktrees.

Two leak paths were observed:

1. Same-PR collision: the closer re-dispatched a hammer for the same PR while a previous attempt still held the branch. Provision failed with `already checked out in worktree` / branch-holder errors. Cleanup could fall through `targeted worktree fallback could not find admin entry`, leaving a half-registered worktree. The closer then retained ownership and retried every watcher tick.

2. Merged-PR orphan: even after a clean merge, leftover hammer worktrees could remain under `$HQ_ROOT/workers/`. They kept holding branch refs and became future collision hazards.

Because the watcher tick loop is single-threaded, repeated branch-holder-block dispatch attempts consumed the tick budget and starved first-pass review scheduling. The visible symptom was PRs sitting 75+ minutes with no review.

## Why #3020 Was Incomplete

HAM-ADOPT #3020 added adopt-or-teardown handling for conflicting branch holders at provision time, but it did not cover prior same-PR hammer attempts that were mid-teardown or half-registered, especially the `targeted worktree fallback could not find admin entry` path. It also did not reap merged or closed PR orphan worktrees. The #3064 incident was a second same-PR hammer attempt colliding with an un-torn-down first attempt after #3020 had already merged.

## Fix

This change adds a closer-worktree reaper to the long-lived follow-up daemon tick. It enumerates `$HQ_ROOT/workers/hammer-ama-pr-*` and registered git worktrees via targeted `git -C $HQ_ROOT/repos/<repo> worktree list --porcelain`. It reaps:

- worktrees for merged or closed PRs,
- prunable worktrees,
- half-registered disk leftovers with no git worktree admin entry.

The reaper is bounded per tick, fail-open, and logs a summary as `closer-worktree-reap: scanned=... reaped=... skipped=...`. It does not run broad `git worktree prune`.

The AMA closer provision path now also handles same-PR hammer collisions directly. If a branch-holder failure points at `hammer-ama-pr-<samePR>-*`, the closer attempts targeted `git worktree remove --force <path>` and `hq worker tear-down --force`, then retries dispatch once. If that cleanup cannot clear the holder, the existing branch-holder debt accounting remains in force.

## Regression Coverage

Tests cover merged-PR reaping without touching open registered worktrees, half-registered and prunable cleanup, and the #3064-style same-PR provision collision where the second hammer attempt tears down the first holder and provisions cleanly.
