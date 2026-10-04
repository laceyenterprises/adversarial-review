# SEV3 PMSC-14 — Governed generated-index rebase falsely holds Comment-only closeout

Incident date: 2026-10-02. Severity: SEV3. Local PMO: PMSC-14.
Native Linear projection: pending reauthentication; no board write claimed.
Disposition: implementation and offline regression evidence prepared; unresolved
until exact-head cross-model convergence, governed merge, reviewed deployed
submodule ancestry, native resident reload and fresh production audit proof.

## Root cause

`proveFinalRoundWorkerPush` required whole-commit `git cherry` equivalence.
Agent OS's main policy forbids worker-authored generated index edits and assigns
regeneration to automation after merge. Reviewed commits mixed implementation
with `docs/INDEX.md`; mandatory fresh-base rebase preserved the implementation
while dropping intermediate generated index hunks and an INDEX-only reset.
Whole-commit equivalence rejected the first mixed commit before evaluating the
remaining provenance. The proof lacked an explicit governed replay contract.

## Failure mode and bounded evidence

The dispatch's preserved production evidence reports Agent OS PR7544 reviewed
at `adc88d1635`, Gemini30234 Comment only with one diagnostic nonblocker.
Codex30237 remediated all four git-show/ls-tree stderr siblings, with four
failed-before scars and 28 targeted passes. The reported pushed head is
`6028e2a63ec132b02ed857ec2a9e44c81da9a0ef`; all three required exact-head checks
were SUCCESS. Native completion withheld that head with
`reviewed-commit-not-replayed 15eef1441403`, then stopped/no-progress at 10:39:30.
A sanctioned watcher wake at 10:48:32 did not create AMA/HAM dispatch.

Preserved read-only comparisons report non-index implementation patch IDs equal
for `15eef → 1d488`, `5b83 → 2afcf`, and `937 → 799`; the reviewed reset was
INDEX-only. Final index bytes matched fresh main `0c84b192`. Evidence handles:
`tick1039-native-wake-result`, `replay-compare`, `replay-proof`,
`pr7544-wake-result`, `replay-owner`. These are supplied incident observations,
not new production measurements made by this worker. The checked-in
`test/fixtures/generated-index-policy/pr7544-replay-evidence.json` preserves
the four supplied JSON records; isolated Git fixtures rebuild the exact commit
shape with small code/documentation files, not claimed production source bytes. Original snapshots,
stopped job/review, withheld reasons, and unrelated ownership remain evidence.

This is a fail-closed availability hold, not proof of an unsafe merge or missing
implementation. PR7544 and the PMSC-05 legacy integration dependency remain open
pending reviewed deployment and native recovery. This worker did not test or
mutate their worktrees, production databases, configs, plists or services.

## Earned hardening and regressions

Parent contract: `merge.finding-remediation-and-authoritative-terminal`.
Earned contract: `COMMENTCLOSE-GENERATED-INDEX-01` — authoritative generated
index omission may preserve reviewed replay authority only under a versioned
repository/path policy, ordered exact implementation replay, fresh base/index
consistency, current-job provenance and live-head fences.

| Named cause | Hardening | Real regression reference |
|---|---|---|
| Whole-commit proof conflicts with governed index omission | Pinned agent-os/main policy; only literal docs/INDEX.md excluded; ordered full binary patch equality | `test/generated-index-replay.test.mjs`: mixed INDEX commits and INDEX-only reset |
| Endpoint equivalence loses cancelled or substituted patches | Preserve patch sequence/multiplicity, blob IDs, paths, modes and binary bytes; reject merges, changed/dropped code, foreign commits and path tricks | Same suite: changed/dropped/cancelled/conflicting-trunk/renamed/foreign-trailer cases |
| Mutable head can move during proof | Inspect immutable SHAs, then fence live head, local HEAD and local/live base | Same suite: force-push during proof; remote/local/base fences repeated five times each |
| Body text can masquerade as a job trailer | Require one exact current-job trailer in the final trailer paragraph | Same suite: body trailer, conflicting duplicates and crafted identifier |
| Terminal failure has no supported re-evaluation owner | Native-owned bounded immutable recovery; digest-bound read model for suppression, ledger and closer; preserve original bytes/status/reason | Same suite: terminal recovery reaches all siblings, active ownership/artifact/blocker/limit rejection and archival |
| Git failure can spill diagnostics or stall proof | Commit/output/deadline bounds, no replace objects or external conversions | Same suite: missing/corrupted objects, unreadable object and bounded diagnostic; existing final-round Git-error test |

Failed-before evidence: the mixed-history fixture returned
`reviewed-commit-not-replayed` instead of granting the unchanged replay. An
ordinary descendant fixture's simulated force-push was accepted by unfixed code.
The terminal recovery observer run against the original module still reported
`hasUnprovenCommentOnlyFinalRoundHead=true` after a valid immutable recovery
record. Those failures were observed before corrected runs; no baseline, scar,
severity, capture or eligibility was weakened. The race tests measure a
controlled force-push injected between live reads, not a claimed production race.

Same-file sibling audit: inspected both `git cherry` directions, HEAD/trailer
reads, merge enumeration, remote-head lookup and Git error handling in
`src/comment-only-final-round.mjs`. Also inspected terminal scans (completed,
stopped, failed, archived), held-head suppression, push-job lookup,
`proveCommentOnlyFinalRoundHead`, completion's pending-CI classifier,
`follow-up-jobs` ledger normalization and native reconciliation. Recovery reads
are outside the directory-stamp cache and validate fresh source bytes, avoiding
stale cached authority. Existing classification and merge predicates remain the
shared owners; no CI rule fork, override, coverage waiver or rereview bypass.

## Required production closeout

Root must record exact-head review with all findings addressed, governed HQ
adjudication/AMA/HAM merge, reviewed deploy ancestry and resident reload in
`operator-artifacts/postmerge-scars-audit-20261002/LEDGER.json`. Only then may the
native owner preview/apply the supported reconciler for the original PR7544
job, using an isolated hydrated proof workspace if current main has advanced.
Newer main is accepted only with identical index/governance bytes and no path
overlap with any reviewed/pushed patch; conflicting movement stays held.
Require its fresh proof and governed reviewed merge/deploy, followed by
PMSC-05V's supported legacy PR-open proof. A PR or fixture pass is not resolution.
Canonical Agent OS hardening-source capture may require a separate reviewed
integration; this RCA supplies earned contract/regression references and does
not invent ledger source events or claim relocation-only capture proof.

PMV shadow posture, post-merge coverage advisory posture, rollout review dates,
human gates and historical failure records are retained. PMSC-01/02/03/11/12/13,
Agent OS PR7528/7529 and PR7392 holds retain their existing owners.


## Offline validation

- `npm run lint`: exit 0, zero errors (existing repository warnings retained).
- `npm test`: 7,550 passed, five existing skips, zero failures (7,555 total).
- `npm run typecheck:contracts`: exit 0.
- `bash demo/research-finding-walkthrough.sh`: exit 0; three byte-stable deliveries.
- `node test/run-tests.mjs comment-only-final-round.test.mjs comment-only-final-round-completion.test.mjs comment-only-final-round-closer.test.mjs commentclose-01-replay.test.mjs generated-index-replay.test.mjs follow-up-jobs.test.mjs follow-up-reconcile.test.mjs watcher-claim-loop.test.mjs hammer-comment-only-terminal.test.mjs`: final scoped run passed, including the delayed-recovery regression.

The initial full run preserved two failing #7311 scars caused by the fixture's
fixed-position Git argv parser after adding `--no-replace-objects`. Only its
argument parsing changed; the original snapshot, production failure assertion,
retry accounting and closeout expectations are unchanged. The corrected full
run and final scoped run passed. The governed policy fixture is inert `.txt`
data so its pinned bytes are preserved rather than reformatted as Python.
This repository has no `docs/INDEX.md` or docs-inventory generator; the Agent OS
index policy is subject-fixture authority, not a new local docs generation gate.
