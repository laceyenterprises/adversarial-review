# PRM-06 validation and prerequisite

Publication is blocked on an upstream capture prerequisite. Consumer changes
are preserved for continuation; no service activation or live state mutation
has been performed.

## Producer parity

Producer checkout revision: `3dd897ce2d5f610967f200cf18d93f9a403f7483`.
The selected existing owner suites ran under the provisioned command wrappers
and Python socket guard, with production ledger DSNs removed, no recapture
flags, and `AGENT_OS_SESSION_LEDGER_VDB=false`:

```bash
NETGUARD_LOG=/tmp/prm06-producer-parity-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
AGENT_OS_SESSION_LEDGER_VDB=false python3 -m pytest \
  ../agent-os/modules/worker-pool/lib/python/tests/test_quota_reserve_weekly.py \
  ../agent-os/modules/worker-pool/lib/python/cwp_dispatch/test/test_dispatch_post_spawn_sqlite.py \
  ../agent-os/platform/session-ledger/tests/test_terminalize_launch_request_success.py \
  ../agent-os/modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_open_required_identity.py \
  -k 'capture_parity and not postgres' -q --disable-warnings
```

The invocation was bounded by a 240-second subprocess timeout. Observed result:
**29 passed, 4 failed, 159 deselected in 163.01 seconds**. All four failures are
`test_fleet_producer_capture_parity[{ready,unavailable,degraded,disabled}]`.
Snapshot, dispatch, launch-row and publication capture cases passed.

The fleet test prepares quota files, an empty migrated ledger and a fake broker
transport, then calls `cmd_status(..., json=True)`. Since
`fd82cbc82e` (the published-input JSON path), this reads
`quota/status-inputs.json`; the capture scenario never publishes that input.
Consequently OpenAI floors emit null measurements and unavailable evidence,
with null held counts, rather than the checked-in measured floors/counts.
The mismatch is in the producer's existing parity suite, independent of review
consumer changes. The current JSON reader's documented unavailable behavior
must not be replaced with a consumer-generated healthy example.

Required owner work in `agent-os`: update the fleet capture harness to invoke
the real published-input producer on its disposable root and frozen clock,
retaining fake external transport; rerun owner parity and recapture any intended
wire changes. Refresh the portable copies with the documented command, rerun
consumer checks, and resume managed publication. This ticket authorizes reading
that repository, so it does not repair the upstream harness here.

## Consumer validation

The initial four-file account/contract run passed 159 tests. After extending
negative cases, the contract-only isolated run passed 46 tests with no failures.
The broader direct `node --test` attempt selected 160 existing/added test files;
its per-file automatic isolation re-executions conflicted with files running
directly against checkout-relative fixture state. Those checkout-write reports
are not valid regression evidence. Verification was repeated through the
repository's existing isolated focused runner, which invokes `node --test`
with disposable roots and fake CLI transport.

The 14-file isolated attempt completed **552 passing tests, 0 failing tests,
0 skipped**, in 294.408 seconds. Its runner exited 1 because the earlier
concurrent direct attempt changed checkout-relative fixture files while its
checkout-write detector was active. This is not an accepted green runner result.

The subsequent five-file isolated run completed **184 passing tests, 0 failing,
0 skipped**, in 3.067 seconds, runner exit 0. It includes the corrected
byte-equivalence regression assertion and the 46 contract-reader cases.

Quality checks: `npm run lint` exit 0 (existing warnings),
`npm run typecheck:contracts` exit 0, the offline
`bash demo/research-finding-walkthrough.sh` exit 0, changed-file ESLint `--fix`
exit 0, and `ruff check` / `ruff format --check scripts/contracts/refresh.py`
exit 0. `git diff --check` passed. The target repository full suite was left to
existing CI; no publication was attempted with incomplete producer evidence.

Existing source-projection hashes were refreshed after reviewing the shared
reader refactor; lifecycle transitions, smoke promises and enforcement are
unchanged.
No full host suite, CI job, workflow, gate or runtime Python dependency was added.


### Isolated 14-file attempt (cases pass; runner exit 1 as explained above)

```text
test/producer-contract-readers.test.mjs
test/codex-account-routing.test.mjs
test/claude-account-routing.test.mjs
test/codex-worker-account-routing.test.mjs
test/afh-reviewer-fallback.test.mjs
test/ama-harness-fallback.test.mjs
test/review-worker-class-fallback.test.mjs
test/remediation-hq-dispatch.test.mjs
test/remediation-oauth-preflight-broker-mint.test.mjs
test/reviewer-runtime-adapter.test.mjs
test/github-adapter-read.test.mjs
test/watcher-claim-loop.test.mjs
test/smv.test.mjs
test/arc19-boundary-gate.test.mjs
```

### Final five-file isolated run (runner exit 0)

```text
test/review-queue-depth-failover.test.mjs
test/watcher-reviewer-quota.test.mjs
test/watcher-reviewer-dispatch.test.mjs
test/argusquota-01.test.mjs
test/producer-contract-readers.test.mjs
```

### Initial 160-file direct attempt

Observed aggregate: 3,618 passing, 20 failing, 0 canceled; 722.602 seconds.
The attempt preceded final corrections and suffered the isolation contention
described above, so it is recorded as an attempt rather than green evidence.

```text
test/adversarial-gate-status.test.mjs
test/afh-reviewer-fallback.test.mjs
test/agent-runtime-canary.test.mjs
test/agent-runtime-local.test.mjs
test/agent-runtime-os-dispatch.test.mjs
test/agent-runtime-reviewer-adapter.test.mjs
test/agent-runtime-router.test.mjs
test/agy-quota-cooldown.test.mjs
test/agy-reviewer-identities.test.mjs
test/alert-delivery.test.mjs
test/ama-closer-branch-holder-reap.test.mjs
test/ama-closer-dispatch-priority.test.mjs
test/ama-closer-lease-failed-without-merge-reclaim.test.mjs
test/ama-closer-reconciliation.test.mjs
test/ama-closer-single-repo-provision.test.mjs
test/ama-closer-stale-worktree-registration.test.mjs
test/ama-closer-terminal-cancel.test.mjs
test/ama-closer-transient-classification.test.mjs
test/ama-dispatch-dir-names.test.mjs
test/ama-dispatched-age-escape.test.mjs
test/ama-freeze-note.test.mjs
test/ama-git-merge-signal.test.mjs
test/ama-ham-audit-parser.test.mjs
test/ama-hammer-background-dispatch.test.mjs
test/ama-hammer-outcome-truth.test.mjs
test/ama-hammer-retry-cap.test.mjs
test/ama-hammer-worker-class.test.mjs
test/ama-harness-fallback-alert.test.mjs
test/ama-harness-fallback.test.mjs
test/ama-merge-action-receipt.test.mjs
test/ama-merge-lease-cli.test.mjs
test/ama-settled-verdict-resolution.test.mjs
test/amafind-01.test.mjs
test/arc10-decomposition-gates.test.mjs
test/arc19-boundary-gate.test.mjs
test/argusquota-01.test.mjs
test/attestation-log-gate-provider.test.mjs
test/ccx-04-corporate-fallback.test.mjs
test/cfg-promotion-watcher-knobs.test.mjs
test/ci-recovery.test.mjs
test/ciblockham-01.test.mjs
test/ciblockham-03.test.mjs
test/classification-routing-tier-unavailable.test.mjs
test/claude-account-routing.test.mjs
test/closed-pr-label-cleanup.test.mjs
test/closerreuse-01-replay.test.mjs
test/closing-keywords.test.mjs
test/code-pr-security-domain.test.mjs
test/codex-account-routing.test.mjs
test/codex-worker-account-routing.test.mjs
test/comment-only-final-round-closer.test.mjs
test/commentclose-01-replay.test.mjs
test/commentclose-02-replay.test.mjs
test/cyclecapham-01.test.mjs
test/dirtyown-01.test.mjs
test/dirtyown-02-replay.test.mjs
test/domain-registry.test.mjs
test/event-driven-hammer-wake.test.mjs
test/federation-execution-adapter.test.mjs
test/finalclose-01.test.mjs
test/follow-up-jobs.test.mjs
test/follow-up-merge-agent-fast-merge.test.mjs
test/follow-up-merge-agent-proactive-stuck-scan.test.mjs
test/follow-up-merge-agent-stuck-pre-spawn.test.mjs
test/follow-up-merge-agent-stuck-round2.test.mjs
test/follow-up-merge-agent-watcher-ownership.test.mjs
test/follow-up-merge-agent.test.mjs
test/follow-up-remediation-quota-hold.test.mjs
test/follow-up-remediation.test.mjs
test/follow-up-retrigger-review-label.test.mjs
test/gemini-dispatch-concurrency-cap.test.mjs
test/gemini-quota-cooldown.test.mjs
test/gempool-routing.test.mjs
test/github-adapter-read.test.mjs
test/github-api.test.mjs
test/github-budget-credentials.test.mjs
test/github-outbound-call-sites.test.mjs
test/github-outbound-integration.test.mjs
test/guardrevert-refusal.test.mjs
test/ham-terminal-self-cert-ground-truth.test.mjs
test/hamclose-ownership.test.mjs
test/hamclose-replay.test.mjs
test/hamfinal-01.test.mjs
test/hamintent-03.test.mjs
test/hamlane.test.mjs
test/hammer-api-publish-cli.test.mjs
test/hammer-api-publish.test.mjs
test/hammer-comment-only-terminal.test.mjs
test/hammer-head-context.test.mjs
test/hammer-scratch-sweep.test.mjs
test/hammer-scratch.test.mjs
test/hammer-stale-review-self-cert.test.mjs
test/hammertrim-contract.test.mjs
test/hamrefund-01.test.mjs
test/hot-path-cache.test.mjs
test/infra-runtime-missing-library.test.mjs
test/kernel-parsers.test.mjs
test/load-aware-call-timeouts.test.mjs
test/merge-agent-harness.test.mjs
test/merge-agent-rescue-classifier.test.mjs
test/msm-04-single-route.test.mjs
test/new-key-preference.test.mjs
test/no-merge-hold.test.mjs
test/node-interpreter.test.mjs
test/noowner-01.test.mjs
test/operator-decision-required-alert.test.mjs
test/operator-label-wake.test.mjs
test/pipeline-rollup-comms-e2e.test.mjs
test/primary-change.test.mjs
test/producer-contract-readers.test.mjs
test/quota-exhaustion.test.mjs
test/quota-pause-suspension.test.mjs
test/quota-rearm-cli.test.mjs
test/rebase-provenance-publication.test.mjs
test/recovery-reaper.test.mjs
test/remediation-hq-dispatch.test.mjs
test/remediation-oauth-preflight-broker-mint.test.mjs
test/remfallback-01-sev-replay.test.mjs
test/remlabel-publication.test.mjs
test/research-finding-end-to-end.test.mjs
test/reserve-floor-measurement.test.mjs
test/review-latency-report.test.mjs
test/review-queue-depth-failover.test.mjs
test/review-worker-class-fallback.test.mjs
test/reviewbounce.test.mjs
test/reviewed-head-dispatch-gate.test.mjs
test/reviewer-burst-lease.test.mjs
test/reviewer-cascade-quota-hold-bound.test.mjs
test/reviewer-chunk-timeout.test.mjs
test/reviewer-oversized-delivery.test.mjs
test/reviewer-quota-signal.test.mjs
test/reviewer-runtime-adapter.test.mjs
test/reviewer-spawn-settle-quota.test.mjs
test/reviewer-token-full-fidelity.test.mjs
test/reviewguard-close.test.mjs
test/reviewstall.test.mjs
test/runtime-status-cli.test.mjs
test/session-ledger-read-adapter.test.mjs
test/single-review.test.mjs
test/stacked-base-default-branch.test.mjs
test/stacked-base-merged.test.mjs
test/ticket-pipeline-pause.test.mjs
test/transientstop-01.test.mjs
test/unregistered-repo.test.mjs
test/untrusted-pr-gate.test.mjs
test/wake-closeout.test.mjs
test/watcher-admission-latency.test.mjs
test/watcher-auto-refresh-stale-posted-review.test.mjs
test/watcher-claim-loop.test.mjs
test/watcher-closure-latency.test.mjs
test/watcher-daemon-clean-merge.test.mjs
test/watcher-dispatch-priority.test.mjs
test/watcher-dispatch-starvation.test.mjs
test/watcher-fast-merge.test.mjs
test/watcher-quota-reset-capture.test.mjs
test/watcher-retry-semantics.test.mjs
test/watcher-reviewer-dispatch.test.mjs
test/watcher-reviewer-quota.test.mjs
test/watcher-reviewer-timeout-handoff.test.mjs
test/watcher-vocabulary-fatigue.test.mjs
```
