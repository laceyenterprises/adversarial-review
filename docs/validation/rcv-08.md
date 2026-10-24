# RCV-08 implementation evidence

SPEC: `backlog-recovery-mode@1c61b7fce9a9`. All new fixtures are synthetic.
RCV-07's versioned consumer export is present in the declared Agent OS workspace
at merged implementation `bf9a0d0b41` (PR 9105). Runtime policy never reads projects.

## Counter contention

The scoped fixture is `test/fixtures/hammer-ledger-race.mjs`. Four independent
processes attempt 25 unique native charges each, with a synchronized start.
The refund phase has four processes observe every launch, exercising duplicate
refunds and process restarts against the same persisted PR ledger.

| Implementation | Consecutive runs | Measured outcome |
| --- | --- | --- |
| Unfixed checkout | 5 | Expected 100 charges; actual 34, 33, 31, 30, 32. Five lost-update failures. |
| Shared flock + atomic readback | 10 | Exactly 100 charges and 100 native keys in every run; zero failures. |
| Versioned full refund implementation | 10 | Exactly 100 charge identities, 100 refund receipts, zero remaining series/lifetime charges in every run. |
| Per-budget partial-credit reconciliation | 10 | Exactly the same 100 identities / 100 receipts / zero balances in all ten runs; zero failures. |

Every test command ran under the dispatch's netguard environment and an explicit
per-command timeout. The race commands used 45/60/75/90 second bounds. Busy
writers retry the existing operation; no separate polling service or check was
added. The crash fixture exits immediately after atomic rename, before readback;
restart observes the receipt, refuses a duplicate refund and can charge again.

## Validation boundary

ESLint fixing and repository lint: zero errors (existing warnings).
Contract typecheck and the offline research-finding byte-equivalence walkthrough
pass. The final focused acceptance run passes 431 tests across the changed
accounting, adapter, intent recovery, wait and terminal-review surfaces. The
standalone load-aware operational wait file passes all 19 tests, including the
intermediate-load scale-once case.
Selected SMV graph/projection checks: three pass. The reviewer/merge authority
and existing state graph are unchanged; no new smoke step was registered.

An expanded regression run hit its 210-second command bound in existing watcher
claim-loop synthetic handoff work without reaching a suite summary. Its scoped
synthetic processes were terminated. This is inconclusive evidence, not a claimed
passing run. A four-case claim/CAS selection also reached its 60-second
bound and its synthetic processes were terminated; claim-loop evidence remains
inconclusive. The full npm suite and broad worker/main-catchup/Sentinel/PMV suites
were not run, following the dispatch's scoped-only validation instruction.

HCP scar searches naming the actual accounting, dispatch, timeout, adapter and
hold-refund files completed successfully and returned no records. Local runbooks
and the supplied hardening history informed the implementation. No live repair,
paid worker, pager delivery, config flip or service restart ran.

## Deployment and activation remain pending

The exact deployed `bin/recovery-status.mjs --json` probe returned exit 1,
`MODULE_NOT_FOUND`; there is no live activation evidence from this worker run.
After merge, normal main-catchup must float the public overlay and the existing
service owner must perform any owed bounce. The deployed optional overlay must
be initialized and caught up. The read-only probe then reports actual configured
values, runtime consumer/charge observations, refund counters, ages and wait
coverage. Source-only assertions are not activation. RCV-09's operator owns final
arming/rollback evidence. No feature-head submodule pointer change is included.
