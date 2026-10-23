## Summary

Adds `nextAction(snapshot)`: one pure, total decision per open PR that names the next step owner, gives an anchored UTC deadline and lists the evidence it used, in place of a scattered page/wait/drain/conflict/empty-close vocabulary. It runs in shadow only. Legacy `decideClosureOwner` keeps authority and every effect, and each disagreement is logged so the rollout owner can classify real cases before any caller switches.



## What changed

- `src/pr-next-action.mjs` (new, outside frozen `src/ama/`): pure, total `nextAction(snapshot)` over the NXA-01 pass snapshot. The ordered table runs R00–R16: confirmed terminal → explicit hold/draft/disabled policy → proven live owner → ownership reconciliation → structural restriction (empty-diff, primary change, deterministic safety refusal) → merge-receipt reconciliation → deterministic stop / retry exhaustion → retryable no-merge → failed CI (remaining round, else final hammer) → conflict/DIRTY → pending checks/UNKNOWN (bounded observer) → proven suppressed final push → exact-head review → findings → daemon → owned refresh. Unknown guard evidence never falls through to a more permissive row. Drain and class capacity apply once, after selection, only to a new agent dispatch (drain wins), and keep the action/actor/reason. It reuses the existing check classifier, verdict cleanliness, launch-status and lease constants. It reads no clock, env, file, process or network.
- `src/pr-next-action-consumer.mjs` (new, imports nothing): faithful legacy adapters (old page/wait, follow-up-drain, conflict, empty-close, posted-review, no-progress-lane outputs → owned workflows), evidence builders, and a hook. The hook copies evidence synchronously and loads the shadow lazily, so short-lived hammer/CLI processes pay no load cost.
- `src/pr-next-action-shadow.mjs` (new): one decision per pass shared by every consumer. Every action/actor/reason disagreement is appended, with generation, source, deadline and evidence refs, to a bounded local JSONL log (one rotation at 16 MiB). Launch evidence is read through NXA-01's ledger seam with a 5 s bound that kills the child. Overdue decisions use the existing closure-wait alert path (debounce, refund, retry) only when `AMA_NEXT_ACTION_OVERDUE_ALERTS=1`. The shadow never throws, never rejects, prints nothing, and is inert under the offline runner unless a test installs a sink.
- Shadow calls added, legacy logic untouched: closure orchestration's final owner (covers both `decideClosureOwner` calls and page overrides; the pass snapshot is now threaded through coexistence), posted-review outcomes, the no-progress lane gate, the closer's handed-to-review owner (one observational statement in frozen `src/ama/dispatch-closer.mjs`), the rescue classifier, the hammer-owner route page, and the watcher handoff wake. SMV state projections are byte-identical, so `state-machines.json` is unchanged.
- `bin/next-action-disagreements.mjs` + `src/next-action-disagreements.mjs` (new): bounded read-only classifier for the rollout owner. It groups distinct cases (repeats count once), merges a private dispositions file, and prints an `--aggregate` anonymous mode. Its sufficiency line is guidance only.
- Docs: `docs/NEXT-ACTION-REASON-INVENTORY.md` (rows, legacy reason→row inventory, shadow sources, rollout procedure, known evidence limits; design documentation, not a registry), a runbook section and a README state/smoke note.


## Why it matters

Stranded PRs have come from closure decisions that were split across consumers. Some paged without an owner. Some waited on unreadable evidence as if it were absent. Some sent red CI or DIRTY heads nowhere, or let a merge receipt stand in for a merged PR. This gives every open PR exactly one named next step owner and deadline, built from one immutable snapshot and shared by every consumer in a pass. Repair admission stays separate from merge permission, and exact-head, provenance, HCP, required-check, protection, identity and lease checks still decide every mutation. Shipping it as a shadow lets an operator compare it with the frozen legacy owner on live traffic and classify real disagreements before anything switches.


## Post-merge activities

None required; no caller switches and nothing is paged by default. Optional, operator-owned rollout: after deploy, the authorized rollout owner can classify live disagreements with `node bin/next-action-disagreements.mjs --root <watcher root> --dispositions <private file>` (read-only) and may set `AMA_NEXT_ACTION_OVERDUE_ALERTS=1` to route overdue reports through the closure-wait alert path. Missing rollout evidence: this worker collected no live cases (not authorized). Switching a caller still needs at least 20 distinct classified live disagreement cases, including candidate mistakes and expected corrections, under separate operator approval. Until then legacy keeps authority.

## Ticket
NXA-02

## Spec
pr-next-action@c216a174c80e

## Completion shape
pr

## Risk class
high

## Acceptance evidence

Offline, synthetic fixtures only (Node 26.10.0).
- `node test/run-tests.mjs test/pr-next-action.test.mjs test/pr-next-action-shadow.test.mjs test/next-action-disagreements.test.mjs`: 101 tests, 101 passed. Coverage: a table row for every action and reason family, including all seven required families (suppressed pushed-head stale review, terminal exit-zero no-merge retry, exhausted red CI, DIRTY repair, drain without debt, actual class-cap deferral, authorized context-only rebased reversal) and foreign head, stale verdict, invalid attestation, hard safety stop plus conflict, alert failure retry (real closure-wait with a refused then accepted transport), hold provenance, and remote-open despite a merged receipt. A cross-product of complete/unknown/error/missing source states (1,536 cases) checks the safety invariants. An all-subsets combined-defect oracle (512 cases) checks row precedence. A frozen-input test asserts no clock/env/fs/child_process access and deterministic repeated output; anchored deadlines do not slide on later polls. Byte-equivalence of legacy results/effects with a throwing shadow sink is checked for the real closure orchestration (agreeing and disagreeing fixtures), the posted-review handler and the rescue classifier.
- Scoped regression over 195 test files (every file importing a touched consumer or new module, plus README/runbook/state-machine readers, including `test/watcher-claim-loop.test.mjs` and `test/smv.test.mjs`), in three bounded runs: 3,926 tests (3,925 pass, 1 skipped); 2,920 tests (2,919 pass, 1 skipped); `test/hamclose-ownership.test.mjs` 21/21. 0 failures. During development this surfaced and fixed: stubbed-module graphs (claim-loop, github-api), SMV projection drift, and a per-process load cost in rendered hammer runs. GHBUDGET-01 was A/B-checked against the unmodified base after the fix: 17.8 s / 18.3 s vs base 21.2 s / 27.0 s.
- `npm run lint`: 0 errors, 147 warnings (same count as baseline, none in new files). `npm run typecheck:contracts`: pass. `bash demo/research-finding-walkthrough.sh`: pass, 3 byte-stable transcript deliveries. `git diff --check`: clean.
- Baseline before edits: closure-owner/snapshot/CI-repair slice 104/104.
- Managed exact-head push: CDM re-derivation and contract typecheck passed; slow suite deferred to CI.
- Not claimed: full `npm test` was not run (it exceeds the worker's per-command bound), so there is no whole-suite pass. No live data was read and no production case collected. Scar search (`hcp_memory_search`) was available and returned no records for the touched files.

## Out-of-scope changes

(none)

---
<!-- hq:worker-class=claude-code hq:worker-id=claude-code-nxa-02 hq:opened-at=2026-10-23T15:39:58Z -->

<!-- hq:run-provenance:v1 -->
## Run provenance

- Requested worker class: claude-code
- Actual harness: claude-code
- Model(s) billed: claude-opus-5-5
- Resolved reasoning level: high
- Change-kind: infra (declared)
- Account receipt (attribution only): {"attemptRef": null, "brokerProvider": null, "evidenceGeneration": null, "holderRef": null, "identity": "claude-code", "leaseRef": null, "requestedWorkerClass": "claude-code", "selectionReason": "unknown", "tokenAccountId": "unknown"}
- Automatic scope grants: {"additionalRepo": "agent-os", "policyVersion": "REPOAUTO-01.rules-v1:7d326ec8b964c3855c406abcf548be81f34c1b85086022cd7877526b72b003e8", "questionClass": "plan-owner-companion", "reason": "verified committed plan owner"}
<!-- /hq:run-provenance:v1 -->

## Scope expansions

- `adversarial-review:README.md`
- `adversarial-review:bin/next-action-disagreements.mjs`
- `adversarial-review:docs/NEXT-ACTION-REASON-INVENTORY.md`
- `adversarial-review:docs/RUNBOOK-ama-closure.md`
- `adversarial-review:src/ama-closure-orchestration.mjs`
- `adversarial-review:src/ama/dispatch-closer.mjs`
- `adversarial-review:src/hammer-owner-route.mjs`
- `adversarial-review:src/merge-agent-rescue-classifier.mjs`
- `adversarial-review:src/next-action-disagreements.mjs`
- `adversarial-review:src/pollonce-phases.mjs`
- `adversarial-review:src/posted-review-row.mjs`
- `adversarial-review:src/pr-next-action-consumer.mjs`
- `adversarial-review:src/pr-next-action-shadow.mjs`
- `adversarial-review:src/pr-next-action.mjs`
- `adversarial-review:test/next-action-disagreements.test.mjs`
- `adversarial-review:test/pr-next-action-shadow.test.mjs`
- `adversarial-review:test/pr-next-action.test.mjs`


## Sensitive paths changed

- `adversarial-review:src/ama-closure-orchestration.mjs`
- `adversarial-review:src/ama/dispatch-closer.mjs`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
