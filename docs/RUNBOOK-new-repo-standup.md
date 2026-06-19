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

Run the idempotent label initializer:

```bash
# one or more repos (short names resolve against the org):
tools/adversarial-review/scripts/init-adversarial-review-labels.sh foundry podium

# or every non-archived org repo at once:
tools/adversarial-review/scripts/init-adversarial-review-labels.sh --all
```

It ensures the full canonical set: the `merge-agent-*` lifecycle labels, the AMA
operator controls (`operator-approved`, `adversarial-merge-requested`,
`adversarial-merge-blocked`, `no-merge-hold`, `ticket-pipeline-paused`,
`reviewer-cycle-cap-reached`, `paused-for-redesign`), and the `fast-merge:*`
classifiers. Safe to re-run any time.

Verify:

```bash
gh label list --repo laceyenterprises/<repo> --json name --jq \
  '[.[]|select(.name|test("merge-agent|adversarial-merge|operator-approved"))]|length'
# expect >= 8
```

## 3. Worker-class title prefixes

PRs must carry a valid `[codex]` / `[claude-code]` / `[clio-agent]` / `[gemini]`
title prefix or they are recorded malformed-terminal and never reviewed (see the
top-level CLAUDE.md "Worker-class title prefixes are non-negotiable"). Nothing to
configure per-repo; this is a contract on the PR author.

## 4. (Optional) Branch protection

If the repo's GitHub plan supports branch protection and you want the
adversarial-gate context required at merge, add it to the target branch's
protection. The pipeline runs without it (the watcher logs a
`branch-protection-warning` and AMA can still close when
`merge_authority.branch_protection.required: false`).
