# RUNBOOK — Adversarial Review: new-repo standup

When a new repository should be covered by the adversarial-review pipeline
(first-pass review, remediation, merge-agent, AMA closure), run these steps.

## 1. Watch enrollment — automatic

The watcher **auto-discovers** every non-archived repo in the org via
`octokit.rest.repos.listForOrg` each refresh (`src/watcher.mjs`). A new repo is
picked up on the next refresh with no config change — confirm by looking for it
in the watcher log line `[watcher] Org repos refreshed — watching N repos: …`
(or its per-repo `branch-protection-warning` lines). There is no static repo
allowlist to edit.

## 2. Initialize the canonical labels — REQUIRED, not cosmetic

The pipeline **applies and reads** GitHub labels mid-flow — most importantly
`merge-agent-dispatched`, which the watcher adds on every merge-agent dispatch.
A repo the watcher is watching but whose labels are missing fails mid-pipeline:

> 2026-06-19: `foundry#15` merge-agent dispatch errored
> `'merge-agent-dispatched' not found`, and `podium` had **zero**
> adversarial-review labels — so closures could not be dispatched there at all.
> On 2026-06-20, app repos that had only the older adversarial subset were
> missing `retrigger-review`, so merge-agent could not request a fresh watcher
> pass after pushing a rebased branch.

Run the idempotent label initializer:

```bash
# from a full agent-os monorepo checkout, seed the shared PR-control subset:
scripts/init-pr-control-labels.sh --repo laceyenterprises/<repo>

# from this adversarial-review checkout, seed the full adversarial-review superset
# for one or more repos (short names resolve against the org):
tools/adversarial-review/scripts/init-adversarial-review-labels.sh foundry podium

# or every non-archived org repo at once:
tools/adversarial-review/scripts/init-adversarial-review-labels.sh --all
```

The agent-os initializer seeds the shared PR-control subset. The
adversarial-review initializer is the superset: it includes that subset plus
AMA controls, additive-scope labels, ticket-pipeline pause, and the
`fast-merge:*` classifiers. Run the adversarial-review initializer, or run both,
on any repo that participates in AMA closure or the fast-merge lane. If you are
standing up a standalone adversarial-review checkout without the full agent-os
monorepo on disk, run the adversarial-review initializer directly. Safe to
re-run any time.

Verify:

```bash
gh label list --repo laceyenterprises/<repo> --json name --jq \
  '(["retrigger-remediation","retrigger-review","merge-agent-requested","merge-agent-dispatched","merge-agent-recovery-in-flight","operator-approved","adversarial-merge-requested","adversarial-merge-blocked","merge-on-comment-only","address-all-findings","merge-agent-skip","do-not-merge","no-auto-merge","no-merge-hold","merge-agent-stuck","stale-drift","pr-class: additive-only","operator-approved: scope-expand","reviewer-cycle-cap-reached","paused-for-redesign","operator-approved: advisory-only-review","ticket-pipeline-paused","fast-merge-veto","fast-merge:docs","fast-merge:spec-hash-rebind","fast-merge:test-fixtures","fast-merge:submodule-bump"] - map(.name)) as $missing | if ($missing|length)==0 then "ok" else "MISSING: \($missing)" end'
# expect ok
```

## 3. Enforce the canonical merge method (squash-only) — REQUIRED

The fleet treats one PR as one logical ticket, and all automation merges via
`gh pr merge --squash`. If `allow_merge_commit` / `allow_rebase_merge` stay
enabled, manual UI/CLI merges create merge-commits (and rebase merges), giving
the mixed history observed 2026-06-19. Disable them so every merge — automated
or manual — squashes, keeping history linear and the build-completion ledger's
PR↔mergeCommit correlation single-shaped.

Run the idempotent settings initializer:

```bash
# one or more repos (short names resolve against the org):
tools/adversarial-review/scripts/init-repo-merge-settings.sh foundry podium

# or every non-archived org repo at once:
tools/adversarial-review/scripts/init-repo-merge-settings.sh --all
```

Verify:

```bash
gh api repos/laceyenterprises/<repo> \
  --jq '{squash: .allow_squash_merge, merge_commit: .allow_merge_commit, rebase: .allow_rebase_merge}'
# expect squash=true, merge_commit=false, rebase=false
```

## 4. Worker-class title prefixes

PRs must carry a valid `[codex]` / `[claude-code]` / `[clio-agent]` / `[gemini]`
title prefix or they are recorded malformed-terminal and never reviewed (see the
top-level CLAUDE.md "Worker-class title prefixes are non-negotiable"). Nothing to
configure per-repo; this is a contract on the PR author.

## 5. (Optional) Branch protection

If the repo's GitHub plan supports branch protection and you want the
adversarial-gate context required at merge, add it to the target branch's
protection. The pipeline runs without it (the watcher logs a
`branch-protection-warning` and AMA can still close when
`merge_authority.branch_protection.required: false`).
