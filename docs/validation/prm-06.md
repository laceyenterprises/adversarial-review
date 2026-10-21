# PRM-06 validation

## Producer artifacts

Portable copies are pinned to Agent OS revision
`f54169eb71c6f0b55b51d3025dd435c88652277e` (including the owner fleet
capture repair). `python3 scripts/contracts/refresh.py ../agent-os` copied the
owner definitions and examples without changing their bytes. The producer
revision, source paths and SHA-256 values are recorded in
`test/fixtures/producer-contracts/provenance.json`.

The fleet scenario invokes `publish_status_inputs(root, now=NOW)` against
its disposable quota files and migrated empty SQLite ledger before invoking
`cmd_status(..., json=True)`. Broker observations and review-store transport
are fake. Its recaptured reserve floors and broker bodies match the earlier
examples; the envelope adds `identityPools: {}`. Exact input/normalization and
recapture commands remain in the copied owner records linked from
[the reader guide](../producer-contract-readers.md).

No producer implementation or fixture was edited in the companion repository.
Parity runs did not set recapture flags or use a production ledger. The existing
launch SQLite leg ran; no Postgres parity result is claimed.

### Producer parity results

**33 passed, 159 deselected, exit 0, 75.25 seconds** across these existing files
(selected with `-k 'capture_parity and not postgres'`):

```text
modules/worker-pool/lib/python/tests/test_quota_reserve_weekly.py
modules/worker-pool/lib/python/cwp_dispatch/test/test_dispatch_post_spawn_sqlite.py
platform/session-ledger/tests/test_terminalize_launch_request_success.py
modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_open_required_identity.py
```

From the review repository root, the bounded invocation used:

```bash
env -u AGENT_OS_SESSION_LEDGER_TEST_DSN -u AGENT_OS_SESSION_LEDGER_DSN \
-u AGENT_OS_SESSION_LEDGER_DSN_DIRECT -u AGENT_OS_TEST_ALLOW_PG \
AGENT_OS_SESSION_LEDGER_VDB=false NETGUARD_LOG=/tmp/prm06-producer-parity-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
python3 -c 'import subprocess; subprocess.run(["python3", "-m", "pytest", "../agent-os/modules/worker-pool/lib/python/tests/test_quota_reserve_weekly.py", "../agent-os/modules/worker-pool/lib/python/cwp_dispatch/test/test_dispatch_post_spawn_sqlite.py", "../agent-os/platform/session-ledger/tests/test_terminalize_launch_request_success.py", "../agent-os/modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_open_required_identity.py", "-k", "capture_parity and not postgres", "-q", "--disable-warnings"], timeout=240, check=True)'
```

Broker HTTP capture parity: **4 passed, 52 deselected, exit 0, 2.06 seconds** in
`platform/oauth-broker/tests/integration/test_endpoints.py`, selected with
`-k producer_capture_parity`. The existing tests run the real broker app/cache
and HTTP serializer against temporary stores, stub providers and newly created
loopback listeners. They use the owner's provisioned `site-liveports` guard,
which denies off-host and already-listening endpoints.

The default interpreter lacked the broker import path and async test plugin;
those setup attempts are not parity evidence. Verification used a disposable
Python 3.14 environment with the owner's declared `pytest>=8,<9` and
`pytest-asyncio>=0.23,<1` dependencies (resolved to 8.4.2 / 0.26.0), inheriting
already installed broker dependencies. No host environment or runtime dependency
was changed. With `PYTHON` pointing to that environment, the bounded invocation
from the review repository root is:

```bash
NETGUARD_LOG=/tmp/prm06-broker-parity-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" \
PYTHONPATH="$NETGUARD_ROOT/site-liveports:$PWD/../agent-os/platform/oauth-broker/src" \
"$PYTHON" -c 'import subprocess,sys; subprocess.run([sys.executable, "-m", "pytest", "tests/integration/test_endpoints.py", "-k", "producer_capture_parity", "-q", "--disable-warnings"], cwd="../agent-os/platform/oauth-broker", timeout=120, check=True)'
```

## Consumer validation

Tests ran from this repository root under the verified provisioned
`NETGUARD_ROOT/bin`. The existing `test/run-tests.mjs` runner invokes
`node --test` with per-file disposable state, fake CLI transport and checkout-write
checks. Its isolation is required: mixing direct test execution with isolated
re-executions can write into checkout-relative fixture state. No live dispatch,
publication or service restart was performed.

The selection includes all tests importing the edited readers/consumers directly
or transitively, plus the existing source-projection and decomposition checks.
358 distinct test files were exercised. Files are listed below with their bounded group invocation. Each group has the
existing runner's 900-second limit and a bounded outer command.

| Group | Files | Result | Duration | Exit |
|---|---:|---|---:|---:|
| core | 18 | 700 passed; 0 failed/cancelled/skipped | 703.245 s | 0 |
| siblings-a | 169 | 4,439 passed; 1 timing failure; 2 skipped | 701.458 s | 1 |
| siblings-b + integration | 175 | 4,057 passed; 0 failed/cancelled; 3 skipped | 357.818 s | 0 |
| final focused | 8 | 472 passed; 0 failed/cancelled; 1 existing skip | 676.440 s | 0 |
| final compatibility | 2 | 102 passed; 0 failed/cancelled/skipped | 0.531 s | 0 |
| remediation file alone | 1 | 360 passed; 0 failed/cancelled/skipped | 33.710 s | 0 |

The first two groups ran before rebasing onto review repository `main` at
`12fd745c`. The rebase and local-change restoration completed cleanly; the
existing state projections still match. The final group includes the newly
landed identity/ledger tests and repeats the producer-reader, watcher claim-loop,
state-projection and final-round closer checks on the integrated tree.

The grouped failure was
`test/follow-up-remediation.test.mjs` → `a slow workspace does not hold another
remediation spawn at the concurrency cap`: its existing two-second deadline
expired while two test groups ran concurrently. The entire file then passed
alone on the integrated tree: **360 passed, exit 0**. Neither the assertion nor
its deadline was changed. This does not claim a proven baseline failure or a
cause beyond the observed timeout and successful isolated rerun.

The two existing skips require a parent checkout outside the isolated test
root: session-ledger model parity and the external review CLI. The portable
launch-row/vocabulary capture tests execute in the core/integration groups.
The final sibling group has three existing skips: two prompt drift cases
documented in `KNOWN-SHARP-EDGES.md` and a process-probe case whose introspection
is blocked by the worker sandbox.

```bash
NETGUARD_LOG=/tmp/prm06-remediation-isolated-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/follow-up-remediation.test.mjs
```

Quality checks: `npm run lint` (0 errors, existing warnings),
`npm run typecheck:contracts`, and
`bash demo/research-finding-walkthrough.sh` all exited 0. Changed-file ESLint
`--fix`, `ruff check --fix` / `ruff format scripts/contracts/refresh.py`, and
`git diff --check` passed. Full-suite execution remains with existing CI;
no new gate, CI job or workflow was added.

## Compatibility and activation

Current typed weekly evidence remains distinct from short windows; pre-repair
confidence/status and numeric-string shapes retain their documented shims.
Dispatch identity alias precedence, legacy status subsets, account order,
thresholds, selection/hold policies and merge/retry authority are retained.
Diagnostics identify the producer and field for missing, malformed, stale or
unrecognized evidence; unavailable transport paths name `$stdout`/`$body`.
Malformed capture mutations are explicitly labelled negative tests.

Existing state-source projection hashes were reviewed/refreshed for the shared
reader refactor. Lifecycle transitions, state/smoke promises and enforcement
policy are unchanged. The AMA audit domain and existing catalog document the
optional diagnostic array.

`operator_steps`: None. No migration, configuration flip or privileged activation
is required. Long-running consumers pick up the readers at their next normal
operator-managed deployment/reload; this worker requests no restart. Same-user
read-only verification: `hq fleet quota status --json`, inspecting weekly
object/reason, provider probe state and matching broker provider fields together.

### core (18 files)

```bash
NETGUARD_LOG=/tmp/prm06-focused-core-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/producer-contract-readers.test.mjs \
  test/codex-account-routing.test.mjs \
  test/claude-account-routing.test.mjs \
  test/codex-worker-account-routing.test.mjs \
  test/afh-reviewer-fallback.test.mjs \
  test/ama-harness-fallback.test.mjs \
  test/review-worker-class-fallback.test.mjs \
  test/remediation-hq-dispatch.test.mjs \
  test/remediation-oauth-preflight-broker-mint.test.mjs \
  test/reviewer-runtime-adapter.test.mjs \
  test/github-adapter-read.test.mjs \
  test/watcher-claim-loop.test.mjs \
  test/smv.test.mjs \
  test/arc19-boundary-gate.test.mjs \
  test/review-queue-depth-failover.test.mjs \
  test/watcher-reviewer-quota.test.mjs \
  test/watcher-reviewer-dispatch.test.mjs \
  test/argusquota-01.test.mjs
```

### siblings-a (169 files)

```bash
NETGUARD_LOG=/tmp/prm06-siblings-a-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/adapters/comms-github-pr-comments-identity.test.mjs \
  test/adapters/comms-github-pr-comments.test.mjs \
  test/adapters/operator-composite.test.mjs \
  test/adapters/operator-github-pr-label-controls.test.mjs \
  test/adapters/operator-linear-triage.test.mjs \
  test/adapters/subject-github-pr.test.mjs \
  test/adversarial-gate-status.test.mjs \
  test/adversarial-hard-shutdown.test.mjs \
  test/agent-runtime-canary.test.mjs \
  test/agent-runtime-local.test.mjs \
  test/agent-runtime-os-dispatch.test.mjs \
  test/agent-runtime-reviewer-adapter.test.mjs \
  test/agent-runtime-router.test.mjs \
  test/agy-quota-cooldown.test.mjs \
  test/agy-reviewer-identities.test.mjs \
  test/alert-delivery.test.mjs \
  test/ama-check.test.mjs \
  test/ama-closer-branch-holder-reap.test.mjs \
  test/ama-closer-dispatch-priority.test.mjs \
  test/ama-closer-lease-failed-without-merge-reclaim.test.mjs \
  test/ama-closer-reconciliation.test.mjs \
  test/ama-closer-single-repo-provision.test.mjs \
  test/ama-closer-stale-worktree-registration.test.mjs \
  test/ama-closer-terminal-cancel.test.mjs \
  test/ama-closer-transient-classification.test.mjs \
  test/ama-dispatch-dir-names.test.mjs \
  test/ama-dispatched-age-escape.test.mjs \
  test/ama-eligibility.test.mjs \
  test/ama-freeze-note.test.mjs \
  test/ama-git-merge-signal.test.mjs \
  test/ama-ham-audit-parser.test.mjs \
  test/ama-hammer-background-dispatch.test.mjs \
  test/ama-hammer-outcome-truth.test.mjs \
  test/ama-hammer-retry-cap.test.mjs \
  test/ama-hammer-worker-class.test.mjs \
  test/ama-harness-fallback-alert.test.mjs \
  test/ama-merge-action-receipt.test.mjs \
  test/ama-merge-agent-coexistence.test.mjs \
  test/ama-merge-lease-cli.test.mjs \
  test/ama-retain-loop-cap.test.mjs \
  test/ama-review-cycle-exhaustion-rounds.test.mjs \
  test/ama-settled-verdict-resolution.test.mjs \
  test/amafind-01.test.mjs \
  test/app-sdk-consumption.test.mjs \
  test/arc-08-remediation-port-collapse.test.mjs \
  test/arc-08-remediation-runtime-e2e.test.mjs \
  test/arc10-decomposition-gates.test.mjs \
  test/argus-backfill.test.mjs \
  test/argus-backlog-retirement.test.mjs \
  test/argus-dependency-evidence.test.mjs \
  test/argus-no-drop-regression.test.mjs \
  test/argus-reviewer-routing.test.mjs \
  test/argus-security-drain.test.mjs \
  test/argus-security-health.test.mjs \
  test/argus-security-review.test.mjs \
  test/argusdrain-01-sev-scenarios.test.mjs \
  test/attestation-log-gate-provider.test.mjs \
  test/backfill-review-bodies.test.mjs \
  test/bot-pr-not-malformed.test.mjs \
  test/builder-provenance-routing.test.mjs \
  test/ccx-04-corporate-fallback.test.mjs \
  test/cfg-promotion-watcher-knobs.test.mjs \
  test/ci-recovery.test.mjs \
  test/ciblockham-01.test.mjs \
  test/ciblockham-03.test.mjs \
  test/classification-routing-tier-unavailable.test.mjs \
  test/claude-reviewer-token-proxy.test.mjs \
  test/closed-pr-label-cleanup.test.mjs \
  test/closeout-scraper.test.mjs \
  test/closer-token-backfill.test.mjs \
  test/closerreuse-01-replay.test.mjs \
  test/closing-keywords.test.mjs \
  test/code-pr-security-domain.test.mjs \
  test/codex-oauth-responses.test.mjs \
  test/comment-delivery.test.mjs \
  test/comment-only-final-round-closer.test.mjs \
  test/comment-only-final-round-completion.test.mjs \
  test/comment-only-final-round.test.mjs \
  test/commentclose-01-replay.test.mjs \
  test/commentclose-02-replay.test.mjs \
  test/cyclecapham-01.test.mjs \
  test/daemon-ham-terminal-remediation-remerge.test.mjs \
  test/daemon-head-closer-certified-remerge.test.mjs \
  test/daemon-merge-park-log.test.mjs \
  test/daemon-route-disagreement.test.mjs \
  test/dag-autowalk-health.test.mjs \
  test/dependency-bot-autoadjudication.test.mjs \
  test/diagnose-stuck-rereview.test.mjs \
  test/diff-cache.test.mjs \
  test/dirtyown-01.test.mjs \
  test/dirtyown-02-replay.test.mjs \
  test/domain-registry.test.mjs \
  test/duplicate-family-packet.test.mjs \
  test/duplicate-family-survivor-workflow.test.mjs \
  test/event-driven-hammer-wake.test.mjs \
  test/event-driven-rereview-wake.test.mjs \
  test/fast-merge-timeline-pagination.test.mjs \
  test/federation-execution-adapter.test.mjs \
  test/finalclose-01.test.mjs \
  test/finalization-execution-surfaces.test.mjs \
  test/finalization-executor.test.mjs \
  test/fleet-self-repair-rereview.test.mjs \
  test/follow-up-daemon-maintenance-state.test.mjs \
  test/follow-up-daemon-stuck-rereview-kill-switch.test.mjs \
  test/follow-up-finished-pr-reaper.test.mjs \
  test/follow-up-jobs.test.mjs \
  test/follow-up-lifecycle-remwaste.test.mjs \
  test/follow-up-merge-agent-fast-merge.test.mjs \
  test/follow-up-merge-agent-proactive-stuck-scan.test.mjs \
  test/follow-up-merge-agent-stuck-pre-spawn.test.mjs \
  test/follow-up-merge-agent-stuck-round2.test.mjs \
  test/follow-up-merge-agent-watcher-ownership.test.mjs \
  test/follow-up-merge-agent.test.mjs \
  test/follow-up-merge-gate.test.mjs \
  test/follow-up-pr-ledger.test.mjs \
  test/follow-up-reconcile.test.mjs \
  test/follow-up-remediation-provider-capacity.test.mjs \
  test/follow-up-remediation-quota-hold.test.mjs \
  test/follow-up-remediation-reply-path.test.mjs \
  test/follow-up-remediation.local-mode.test.mjs \
  test/follow-up-remediation.test.mjs \
  test/follow-up-requeue-cli-stopped.test.mjs \
  test/follow-up-requeue.test.mjs \
  test/follow-up-retrigger-label.test.mjs \
  test/follow-up-retrigger-review-label.test.mjs \
  test/follow-up-review-claim.test.mjs \
  test/follow-up-settled-non-blocking.test.mjs \
  test/follow-up-stop.test.mjs \
  test/follow-up-stuck-claim-sweep.test.mjs \
  test/follow-up-worker-cancel.test.mjs \
  test/follow-up-workspace-reaper.test.mjs \
  test/gemini-checkout-conflict-window.test.mjs \
  test/gemini-credential-checkout-concurrency.test.mjs \
  test/gemini-dispatch-concurrency-cap.test.mjs \
  test/gemini-quota-cooldown.test.mjs \
  test/gemini-reviewer-routing.test.mjs \
  test/gempool-routing.test.mjs \
  test/generated-index-replay.test.mjs \
  test/github-api.test.mjs \
  test/github-budget-credentials.test.mjs \
  test/github-label-events.test.mjs \
  test/github-outbound-call-sites.test.mjs \
  test/github-outbound-integration.test.mjs \
  test/guardrevert-refusal.test.mjs \
  test/ham-terminal-self-cert-ground-truth.test.mjs \
  test/hamclose-ownership.test.mjs \
  test/hamclose-replay.test.mjs \
  test/hamfinal-01.test.mjs \
  test/hamintent-02.test.mjs \
  test/hamintent-03.test.mjs \
  test/hamlane.test.mjs \
  test/hammer-api-publish-cli.test.mjs \
  test/hammer-api-publish.test.mjs \
  test/hammer-comment-only-terminal.test.mjs \
  test/hammer-head-context.test.mjs \
  test/hammer-review-handoff.test.mjs \
  test/hammer-scratch-sweep.test.mjs \
  test/hammer-scratch.test.mjs \
  test/hammer-stale-review-self-cert.test.mjs \
  test/hammertrim-contract.test.mjs \
  test/hamrace-mutual-exclusion.test.mjs \
  test/hamrefund-01.test.mjs \
  test/handoff-telemetry.test.mjs \
  test/hot-path-cache.test.mjs \
  test/hq-root-runner-peer.test.mjs \
  test/hq-root-runner-probe.test.mjs \
  test/identbase-01.test.mjs \
  test/identity-baseline-fixture.test.mjs \
  test/infra-runtime-missing-library.test.mjs
```

### siblings-b + integration (175 files)

```bash
NETGUARD_LOG=/tmp/prm06-siblings-b-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/comment-only-final-round-closer.test.mjs \
  test/identity-token-snapshot.test.mjs \
  test/kernel-parsers.test.mjs \
  test/lease-defer-recovery.test.mjs \
  test/ledger-scan.test.mjs \
  test/live-pack-cross-edit.test.mjs \
  test/load-aware-call-timeouts.test.mjs \
  test/merge-agent-cancel.test.mjs \
  test/merge-agent-candidate.test.mjs \
  test/merge-agent-harness.test.mjs \
  test/merge-agent-rescue-classifier.test.mjs \
  test/msm-04-single-route.test.mjs \
  test/new-key-preference.test.mjs \
  test/no-merge-hold.test.mjs \
  test/node-interpreter.test.mjs \
  test/noowner-01.test.mjs \
  test/operator-blocked-draft-reason.test.mjs \
  test/operator-decision-required-alert.test.mjs \
  test/operator-hold-counts.test.mjs \
  test/operator-label-wake.test.mjs \
  test/operator-retrigger-helpers.test.mjs \
  test/orphan-post-reconcile.test.mjs \
  test/ownerproof-review-recovery.test.mjs \
  test/parsebold-nested-bullet-findings.test.mjs \
  test/pending-review-leak-recovery.test.mjs \
  test/pipeline-health-github.test.mjs \
  test/pipeline-rollup-comms-e2e.test.mjs \
  test/portable-installer.test.mjs \
  test/posted-review-head-repair.test.mjs \
  test/posted-review-row-log-noise.test.mjs \
  test/pr-comments.test.mjs \
  test/pr-lifecycle-triage-retry.test.mjs \
  test/pr-terminal-reconcile-cli.test.mjs \
  test/primary-change-reversal-rebase.test.mjs \
  test/primary-change.test.mjs \
  test/print-tcc-targets.test.mjs \
  test/producer-contract-readers.test.mjs \
  test/prompt-set-resolution.test.mjs \
  test/prompt-stage.test.mjs \
  test/quota-exhaustion.test.mjs \
  test/quota-pause-suspension.test.mjs \
  test/quota-rearm-cli.test.mjs \
  test/rate-limit-throttle.test.mjs \
  test/rebase-provenance-publication.test.mjs \
  test/reconcile-posted-orphans-cli.test.mjs \
  test/recovery-reaper.test.mjs \
  test/remconflict-01.test.mjs \
  test/remediation-completion-comments.test.mjs \
  test/remediation-infrastructure-refund.test.mjs \
  test/remediation-push-token-remint.test.mjs \
  test/remediation-worker-class-fallback.test.mjs \
  test/remediator-capped-hold.test.mjs \
  test/remfallback-01-sev-replay.test.mjs \
  test/remlabel-operator-findings.test.mjs \
  test/remlabel-publication.test.mjs \
  test/remorphan-01.test.mjs \
  test/research-finding-end-to-end.test.mjs \
  test/reserve-floor-measurement.test.mjs \
  test/reset-pr.test.mjs \
  test/retrigger-remediation.test.mjs \
  test/retrigger-review.test.mjs \
  test/review-body-capture.test.mjs \
  test/review-cancel.test.mjs \
  test/review-cycle-cap.test.mjs \
  test/review-freshness-wiring.test.mjs \
  test/review-head-grounding.test.mjs \
  test/review-latency-report.test.mjs \
  test/review-mode-latency.test.mjs \
  test/review-pipeline-health-stuck-retry-loop.test.mjs \
  test/review-pipeline-health-ttm.test.mjs \
  test/review-pipeline-health.test.mjs \
  test/review-population-retry.test.mjs \
  test/review-queue-depth-cli.test.mjs \
  test/review-state-backfill-probe.test.mjs \
  test/review-state-identity-schema.test.mjs \
  test/review-state-schema-bootstrap-busy.test.mjs \
  test/review-state.test.mjs \
  test/reviewbounce.test.mjs \
  test/reviewed-head-dispatch-gate.test.mjs \
  test/reviewed-head-settlement.test.mjs \
  test/reviewer-burst-lease.test.mjs \
  test/reviewer-cascade-quota-hold-bound.test.mjs \
  test/reviewer-chunk-timeout.test.mjs \
  test/reviewer-ci-admission.test.mjs \
  test/reviewer-cleanup-findings.test.mjs \
  test/reviewer-command-failed-recovery-guard.test.mjs \
  test/reviewer-failure-class-per-model.test.mjs \
  test/reviewer-fence.test.mjs \
  test/reviewer-final-round.test.mjs \
  test/reviewer-gh-identity-pin.test.mjs \
  test/reviewer-lease-release-retry-cap.test.mjs \
  test/reviewer-model-fallback-rate-alert.test.mjs \
  test/reviewer-model-fallback.test.mjs \
  test/reviewer-orphan-dead-reviewer-fast-path.test.mjs \
  test/reviewer-oversized-delivery.test.mjs \
  test/reviewer-pass-tokens.test.mjs \
  test/reviewer-process-deadline.test.mjs \
  test/reviewer-quota-signal.test.mjs \
  test/reviewer-reattach-posted-review-probe.test.mjs \
  test/reviewer-spawn-settle-quota.test.mjs \
  test/reviewer-spawn-settle.test.mjs \
  test/reviewer-timeout-budget.test.mjs \
  test/reviewer-timeout.test.mjs \
  test/reviewer-token-full-fidelity.test.mjs \
  test/reviewer-token-ledger-lookup.test.mjs \
  test/reviewer-token-pricing.test.mjs \
  test/reviewer.test.mjs \
  test/reviewguard-close.test.mjs \
  test/reviewguard-context.test.mjs \
  test/reviewline.test.mjs \
  test/reviewstall.test.mjs \
  test/role-registry-delivery-identity-boot.test.mjs \
  test/runtime-status-cli.test.mjs \
  test/sdk-cutover.test.mjs \
  test/security-surface-classifier.test.mjs \
  test/session-ledger-read-adapter.test.mjs \
  test/single-review.test.mjs \
  test/slim-review-prompt-selection.test.mjs \
  test/smv.test.mjs \
  test/spec-touch-prompt-presence.test.mjs \
  test/sqlite-orphan.test.mjs \
  test/stacked-base-default-branch.test.mjs \
  test/stacked-base-merged.test.mjs \
  test/stall-count-excludes-malformed-title.test.mjs \
  test/superseded-blocking-verdict-dismissal.test.mjs \
  test/ticket-pipeline-pause.test.mjs \
  test/token-refresh-cycle-simulation.test.mjs \
  test/token-refresh-hold.test.mjs \
  test/transientstop-01.test.mjs \
  test/ttm-slow-vs-stuck.test.mjs \
  test/ttm-tracker.test.mjs \
  test/unregistered-repo.test.mjs \
  test/untrusted-pr-gate.test.mjs \
  test/wake-closeout.test.mjs \
  test/watcher-additive-only-scope.test.mjs \
  test/watcher-admission-latency.test.mjs \
  test/watcher-agy-auth-startup.test.mjs \
  test/watcher-ama-live-review-retry.test.mjs \
  test/watcher-atomic-claim.test.mjs \
  test/watcher-auto-refresh-stale-posted-review.test.mjs \
  test/watcher-autowalk-on-merge.test.mjs \
  test/watcher-broker-secret-cache.test.mjs \
  test/watcher-cascade-resilience.test.mjs \
  test/watcher-claim-loop.test.mjs \
  test/watcher-closure-latency.test.mjs \
  test/watcher-daemon-clean-merge.test.mjs \
  test/watcher-dispatch-priority.test.mjs \
  test/watcher-dispatch-starvation.test.mjs \
  test/watcher-drain.test.mjs \
  test/watcher-failed-orphan-auto-reclaim.test.mjs \
  test/watcher-failure-diagnostic-logging.test.mjs \
  test/watcher-fast-merge.test.mjs \
  test/watcher-fleet-wide-false-deferral-alert.test.mjs \
  test/watcher-gemini-reviewer-selection.test.mjs \
  test/watcher-github-auth-outage-attempt-budget.test.mjs \
  test/watcher-github-budget.test.mjs \
  test/watcher-inline-stale-reviewer-reconcile.test.mjs \
  test/watcher-pending-draft-reconciliation.test.mjs \
  test/watcher-poll-starvation.test.mjs \
  test/watcher-quota-reset-capture.test.mjs \
  test/watcher-reattach.test.mjs \
  test/watcher-retry-semantics.test.mjs \
  test/watcher-review-adoption-scheduler.test.mjs \
  test/watcher-review-dedup-ceiling.test.mjs \
  test/watcher-reviewer-admission.test.mjs \
  test/watcher-reviewer-refill.test.mjs \
  test/watcher-reviewer-timeout-handoff.test.mjs \
  test/watcher-reviewer-token-artifact.test.mjs \
  test/watcher-sigterm-preserves-reviewers-on-drain.test.mjs \
  test/watcher-stuck-alert-debounce.test.mjs \
  test/watcher-title-guardrails.test.mjs \
  test/watcher-vocabulary-fatigue.test.mjs \
  test/withdrawn-review-dismissal.test.mjs \
  test/workflow-push-drift-recovery.test.mjs \
  test/workspace-identity.test.mjs
```

### Final focused checks (8 files)

```bash
NETGUARD_LOG=/tmp/prm06-final-focused-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/producer-contract-readers.test.mjs \
  test/claude-account-routing.test.mjs \
  test/codex-account-routing.test.mjs \
  test/codex-worker-account-routing.test.mjs \
  test/ama-closer-terminal-cancel.test.mjs \
  test/ama-closer-reconciliation.test.mjs \
  test/ama-closer-lease-failed-without-merge-reclaim.test.mjs \
  test/follow-up-merge-agent.test.mjs
```

### Final compatibility check (2 files)

This verifies the last malformed-field diagnostic while retaining the original
`TypeError` class. No routing or hold condition changes.

```bash
NETGUARD_LOG=/tmp/prm06-final-compatibility-netguard.log \
PATH="$NETGUARD_ROOT/bin:$PATH" node test/run-tests.mjs \
  test/producer-contract-readers.test.mjs \
  test/claude-account-routing.test.mjs
```
