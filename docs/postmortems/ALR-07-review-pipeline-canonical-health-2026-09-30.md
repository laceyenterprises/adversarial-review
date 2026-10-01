# ALR-07 — Canonical autowalk health and review collector blindness

Incident date: 2026-09-30 PDT. Severity: SEV2. Tracking join key: local PMO
ALR-07; native Linear projection remains pending authentication. Disposition:
RCA fix prepared; incident remains open pending cross-model convergence, normal
HQ reintegration, deployment and independent runtime proof. No admin merge.

## Incident report and evidence

Locked project: `alert-incident-recovery-20260930`, version 1.0.0. Sources:
operator-preserved `project/SPEC.md`, `project/CENSUS.md`, `project/incidents/ALR-07.md`
and `evidence/ojo-raw.json` under the September 30 alert-triage artifact directory.
The locked incident report records pipeline-health20261001T020010Z reporting
`dagAutowalkHealthy=no` because the retired LaunchAgent was not loaded. OJO owned
the job, scheduler freshness was fresh, and the latest completed scheduled run
had failed. The census records 13 delivered pipeline-health outbox items (11
page records and two digests), while the latest snapshot had no page-tier review
findings. Delivery records are not all interruptive pages.

Preserved OJO evidence records last green at 2026-10-01T00:00:33.632Z and the
02:30:08Z failure with exit 124 after the 900-second deadline. The retired
launchd timer is intentionally absent. A separate active owner held the autowalk
singleton; this worker did not inspect or mutate its lock, stop it, restart any
service, run autowalk, access the live review database, or modify leases.

## Confirmed causal chain

1. `summarizeLaunchdServices` probed the retired timer and
   `summarizeDagAutowalkHealth` required its loaded state plus exit/log freshness.
   Canonical OJO evidence was never consulted. This produced an incorrect
   service diagnosis independently of the real scheduled timeout.
2. Conflict collection directly invoked `gh pr list` without an explicit
   registered auth identity. Terminal-state and first-pass CI probes used the
   same ambient executable path. Collector execution therefore depended on the
   launch context's tokens/keychain. Collection failure already had a blind
   finding, but raw stderr leaked into diagnostics and the list cap could be
   mistaken for complete coverage.
3. Scheduler freshness is evidence of a recent scheduled fire, not completed
   DAG advancement. Process liveness, admission and a warning/skip cannot prove
   recovery. The preserved timeout remains an actionable failure after removing
   the retired-timer diagnosis.
4. The current collector deliberately downgrades page requests to tickets;
   the review-freshness detector owns the single page criterion. Changing this
   collector's finding set must not add a second page route.

Hypotheses, not confirmed attribution: the earlier unreadable-conflict finding
may have involved authentication, transport, version skew or local merge-tree
access. No preserved evidence identifies a particular failed credential. The
underlying autowalk timeout's phase-level cause belongs to ALR-02. This change
does not claim to repair the walker or explain all historical delivered pages.

## Reproduction and change

A fixture executed the base collector and changed collector against identical
isolated HQ/repo directories, a deliberately absent retired timer, and a fresh
successful owner-scoped OJO job. No network or live ledger was used.

| Observation | Before | After |
|---|---|---|
| Retired timer unloaded, OJO completed successfully | healthy=false; retired-launchd finding | healthy=true; no autowalk finding |
| OJO fresh but latest run exit 124 | retired service/log diagnosis | unhealthy, reason=timeout |
| OJO successful progress older than threshold | log-based result | unhealthy, reason=nonprogress |
| Queued job or active singleton | process/log-based result | inconclusive until completed progress is proved |
| Inaccessible/malformed/wrong-owner OJO | could diagnose service absence | inconclusive; never healthy |
| GitHub authenticated empty listing | zero conflicts | collected=true, zero conflicts |
| GitHub failure, invalid list or 100-row cap | ambient failure/raw diagnostics or truncated result | collected=false; bounded blind reason |

Autowalk now reads `hq ojo --owners <owner> job dag-autowalk` with three bounded
3-second attempts, 100/250ms transient backoff and a 1 MiB cap. JSON status is healthy/unhealthy/inconclusive;
healthy is true/false/null, and Prometheus uses NaN for inconclusive. Existing
max-log-age configuration is retained as the progress-age threshold for
compatibility; no shared YAML schema changes were introduced. Latest failure,
stale/suppressed scheduling and stale progress remain actionable. A fresh
last-green requires matching completed-run evidence; a newer warning or an
in-flight run is not recovery. This follows ALR-02's locked vocabulary without
editing its owned walker or superproject surfaces.

All production collector GitHub reads use a small Python bridge that imports
the registered adapter's existing `AuthPolicy`/`AuthResolver`. The deployed
adapter CLI does not offer general open-PR listing; the bridge adds this read
without duplicating broker credential resolution. It strips ambient tokens,
requires explicit service selector/App/installation bindings, resolves broker
auth in the child, and never returns credentials to Node. Reads have bounded
execution/output and sanitized errors. SIGTERM unwinds subprocess execution and
kills/waits for its child. Transient `gh` failures retry up to three 5-second
attempts with 100/250ms backoff within the existing 20-second outer deadline;
failed/pending check data remains readable. OJO retries only SQLite contention,
temporary spawn/resource failures and subprocess timeouts. Permanent failures
and invalid evidence remain inconclusive without retry. No ambient fallback is permitted.

The collector still emits actionable queue-starvation tickets, slow/moving
budget trends and actual progress-stall diagnoses. Findings have stable
`incident_key` values independent of timestamps and aggregate finding changes;
both autowalk diagnostic states share an owner/job key. No finding from this
collector pages directly. ALR-04 owns centralized episode latching and global
page policy; downstream consumers must use stable family identity.

## Validation

Offline fixtures cover retired timer with healthy OJO, timeout/nonprogress,
queued/active singleton, warning/last-green ambiguity, unavailable/wrong-owner
OJO, GitHub auth binding, zero conflicts versus errors/truncation, sanitized
output and stable incident identity. Existing TTM and review-freshness tests
cover moving reviews versus truly stalled work and debounce behavior.

Validation passed: ESLint with zero errors (152 existing warnings); full offline
npm test with 7,503 tests, 7,498 passed, five skipped and zero failures; contract
typecheck; byte-equivalence research demo; strict CDM audit; fixture fallback
canary; sandboxed failover drill. The offline full suite ran with GitHub tokens
removed and a rejecting gh stub; the auth bridge's separate fixture uses a fake
registered resolver and fake gh. Its deadline test confirmed no surviving child.
The named HQ CI mirror passed CDM/typecheck, with its slow test tier separately
covered by the full suite. A PPH_FULL mirror also follows the shared host heavy
check semaphore. Final mirror/PR-head results are recorded in acceptance evidence.

Initial verification caught stale retry-count and finding-definition assertions,
which were updated for the registered collector bridge and both explicit OJO finding codes.
Running a direct targeted test alongside the first full suite also changed a
checkout-local fixture status file and tripped the runner's isolation check;
final full validation used the isolated suite alone and passed. No live review
DB or lease was involved.

## Rollback and activation/proof

Rollback: revert this incident commit through a normally reviewed PR and HQ
reintegration. This changes read-only diagnosis only; there is no migration,
configuration mutation or lease/database rollback. A revert restores the
incorrect retired-timer diagnosis, so retain the incident evidence.

After normal cross-model convergence and HQ reintegration, deploy the reviewed
adversarial-review submodule through the authorized superproject owner. Verify
the collector's deployed ancestry and owner environment: registered adapter,
Python >=3.11 (`HQ_PYTHON3` override if needed), service broker role, expected App
and installation IDs and broker secret file path. Never copy raw credentials.
Run the deployed health collector under its actual owner and preserve a
secret-free snapshot. Prove that retired launchd absence is irrelevant, the
known timeout stays unhealthy until a successful completed sweep, unavailable
OJO/GitHub becomes inconclusive, and zero conflicts has measured coverage.
Coordinate completed-sweep evidence with ALR-02 and downstream stable episode
consumption with ALR-04. Preserve queue-starvation and moving/stalled review
proof. These activation and runtime proof steps remain operator-owned; this
worker performed no live activation and does not declare the incident resolved.
