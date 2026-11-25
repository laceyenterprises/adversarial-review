# Change notes

- HAM PR #1735: tighten descendant termination and bounded-runner assertions, make lane-release wake tests deterministic, and exercise the review-observation CLI with persisted review and closeout evidence, including multibyte inputs at the UTF-16 code-unit size boundary. Isolate direct reviewer quota admission from builder routing and host configuration.

- FINDINGS-dd4e87b5: strengthen offline test coverage for review-observation CLI input and errors, canonical Claude batch-steer environment aliases and conflict rejection, DAG input guards and producer refusals, findings dispatch timeouts under synthetic load, direct reviewer quota admission, successful Codex catalog seeding, and closer settlement after a remote merge with unavailable capture evidence. Keep cold-start and descendant-cancellation fixtures independent of the host ps executable and CPU sampling. Pin the bounded runner's unconfirmed-cleanup failure on restricted hosts while still requiring descendant termination. Release native lane locks after the fixture watch subscription enters the event loop, preserving the original deadline and stale-route assertions. Re-check historical findings against current main; production behaviour is unchanged.

- FINDINGS-94c784e1: Correct the closer backlog-repair runbook to use the SDK-only CLI, pass its read activation flag and SDK session/bootstrap environment through `sudo`, describe current output and rejected database-source flags, and make dispatch-read subprocess fixtures independent of host load diagnostics.
- HAM PR #1726: recognize negated lists with or without a serial comma, retain
  human ownership for mixed credential and approval clauses in either order,
  and handle stdin stream errors when async Codex probes exit early.

- PR #1726 final comment remediation: cli-direct Codex discovery awaits credential
  and catalog preparation with shared staging and cleanup. Async probes close
  stdin; their bounded stderr buffers are discarded or used only for redacted
  login recognition. Legacy blocker ownership accepts standalone negated-need
  phrases and enumerated lists ending in ", or", while retaining human ownership
  for missing credentials and separate approval clauses. Regression cases now
  live in the existing ownership and service-home suites discovered by `npm test`.

New repository notes live in [`docs/changes/README.md`](README.md), one
`<TICKET-ID>.md` file per ticket. Follow that convention for new work; the
entries below are preserved historical notes. No per-ticket README or index
update is needed.

- LIVEPACKNEW-01: a head-only pack plan is conclusively not live when a complete base-plan scan finds no matching planId, without a ledger read. Collisions retain ledger checks and base-authoritative tickets; unavailable scans fail closed. Unavailable ledger reads retry up to three attempts within ten seconds, with retry counts in structured review facts. Retries stop when the budget expires during backoff; counts include only dispatched retries and are zero for unread packs in remediation facts. Offline regressions cover deadline boundaries and malformed plans.

- **HAM-1722:** Preserve closer leases when environment launch IDs conflict while retaining audit identity precedence; use launch-request-format fixtures and cover identical aliases and ambiguous terminal outcomes.

- FINDINGS-6d0e0584: AMA audit uses the first nonempty launch identity from `HQ_LAUNCH_REQUEST_ID`, `AGENT_OS_WORKER_LRQ_ID`, and `LAUNCH_REQUEST_ID`. JSON identity remains audit metadata and cannot release a closer lease.
- REVIEWLARGE-01 final remediation: restore raw-first size recovery, defer copy/blob inspection until summarisation is needed (64 KiB diff floor), and disclose the manifest inside Summary before final reply validation. Only an exhausted chunk size refusal becomes exit 77; state projection hashes remain valid.

- REVIEWLARGE-01: reviewers summarise base-declared generated paths and byte-identical moves/splits in a hashed manifest before prompt sizing. Typed prompt-size failures retry summarisation and bounded chunking; chunk findings retain provenance and any blocking finding blocks the combined verdict. Posted reviews disclose their scope; exhausted chunk plans retain the operator path. See [large review diffs](../review-large-diffs.md) and the MERGEHOTSPOT-01 SEV report in agent-os.

- GRK-10 final remediation: refused or missing custom reviewer models return no route without throwing; Claude remediation aliases normalize to their reviewer family. Removed the unreachable same-family last-resort worker fallback and added exhaustion regressions. Author-tagging reference tables and roster expectations now include Grok; the fallback route fixture supplies explicit builder provenance.
- GRK-10: `[grok]` builder titles route to Codex review and `remediator-codex`. Closer wrappers retain the original builder tag; family checks refuse Grok acting aliases and unknown provenance before dispatch and fallback. Existing availability policy can select an eligible non-Grok fallback or defer. Activation is the companion merge and watcher reload in GRK-16, which also owns the live review/remediation route receipt; no live activation is performed here.

- REVIEWCARRY-01 final remediation: the watcher prefers the named base branch over a possibly stale PR base SHA when proving carry-forward, retaining the SHA fallback when the name is absent. Daemon merges authorized by that proof record `closureAuthority: daemon-review-carry-forward`; existing operator and closer authority precedence is preserved. Offline watcher and daemon regressions cover these cases. Lifecycle states and existing smoke promises are unchanged.

- REVIEWCARRY-01: a rebase that changes only generated files no longer throws away a settled clean review. Before, a PR with a settled `Comment only` review and no blocking findings that was rebased only to resolve conflicts in a generated fixture or catalog lost its reviewed SHA, read as `stale-review-head`, and went through a new review, strict remediation and a new head again, sometimes several times a day with the same content. Now, before the watcher requests the automatic re-review of a moved head, `src/review-carry-forward.mjs` compares the PR's own patch (GitHub compare against the merge base) at both heads as a normalized diff: hunk line numbers are dropped and content and whitespace are kept exactly. Paths the host repository declares in `.adversarial-review/generated-paths` are excluded. The declaration is read at the base-branch merge base, never at the PR head; catch-all, negated, traversal and self-matching patterns are refused, so the declaration file is always compared. If the patches are equal and non-empty, the new merge base descends from the old one, and the review is settled `comment-only`/`approved` with zero blocking findings and no pending remediation, the review carries forward. The watcher writes a once-per-head record under `data/review-carry-forward/` naming both SHAs, the excluded patterns and the generated paths that changed (see `docs/data-model/review-carry-forward.md`), and does not request the re-review. Closers see the record: the gate status no longer reports `stale-review-head` for that pair, the AMA closer uses it as the head proof for `closerAuthoredStaleEligible`, and the daemon clean-merge path accepts the pair and validates the live head. CI, mergeability, strict clean-review and live-reconcile gates still apply. Any non-generated difference (including whitespace), a blocking finding, a capped or unreadable diff, or a reset onto an older base keeps today's exact-head re-review. The SEV2 report ships with MERGEHOTSPOT-01 in agent-os. Tests: `test/review-carry-forward.test.mjs` and REVIEWCARRY-01 probes in `test/ama-hammer-background-dispatch.test.mjs`.

- CLOSERPARKOWNER-01 final remediation: the ownership regression fixture now runs two closure passes. The first persists a dispatched closer lease; the second reads that lease and synthetic running-launch evidence, retains R03 custody, and proves that the executor runs only once.

- CLOSERPARKOWNER-01: a PR parked after a comment-only final round no longer waits indefinitely for an owner. Diagnosis: EXHAUSTEDHEADOWNER-01 (PR 1667) deliberately leaves a completed final-round push head to the closer lane (`!isCompletedFinalRemediationJob` in `processReviewSubject`), so the closer, not exhausted-head admission, owns these heads. The closer never ran for them: the pre-walk `recoverOverdueOwnership` check read a lane record that had recorded no selected action, synthesized an evidence-free R04 `closure-recovery` default, and once its five-minute deadline lapsed paged the transition and returned `recovery-exhausted`. `processReviewSubject` returns on any recovery outcome, so the posted-review handler (the only caller of the closer) never ran again, the lane record was never rewritten and the lapsed deadline could not clear. Fix in `src/ownerproof-review-recovery.mjs`: discovery recovery ends the pass only for a selected reviewer or hammer dispatch it can execute, or for an outcome that changed something. A page-only outcome (`ama-pending` or `recovery-exhausted`) for any other expired action, such as a CI observer, an R04 reconcile or a lane record that selected nothing, still pages once per head and transition through the existing alert path, then returns `null` so the closer runs on that same pass. An exhausted executable route keeps its existing two-attempt cap, single page and `recovery-exhausted` outcome. No new label, gate or configuration. Synthetic fixtures in `test/closerparkowner-01.test.mjs` cover owner assignment, no double ownership and an exhausted park that surfaces once.

- CLOSERRETRY-01: the merge-authority closer is no longer dispatched a third time for the same failure on an unchanged head. Terminal no-delivery attempts (the PR still open, the head unmoved) are kept per `(PR, head, failure class)` in `data/follow-up-jobs/closer-no-delivery/` (`src/ama/closer-no-delivery.mjs`). The first attempt and the series' one bounded retry still run; once a class has ended two attempts on one head, the closer stops before the prompt, harness and quota work and returns the existing needs-operator result with reason `closer-repeat-no-delivery-skipped`. Every skip is logged as `ama_closer.repeat_no_delivery_skipped`; the ledger records entry into the skipped state and then at most one skip per 15 minutes per key (`skippedCount`, `skipPersisted` in the log), so a stuck PR does not rewrite it every poll. Each attempt counts once across polls, identified by its launch request id, else its dispatch id, intent key or attempt time. A new head, a different failure class, the existing operator approval allowance, or `npm run reset-pr` (which now moves the PR's ledger aside and notes it in its receipt) re-enables the closer. If applying the operator approval re-drive fails, the closer falls back to the stored ledger gate instead of dispatching, and the skipped-repeat result reports the dispatched worker class. Infrastructure-read and lane-busy deferrals and refunded infrastructure deaths spend no key. No new label, gate or CI check. Offline coverage is in `test/closer-no-delivery.test.mjs`.
- PR #1724 final Comment-only remediation: release parked closer custody using the evaluated historical CI evidence, share all classifier reason sources before enrichment, and cache failed job evidence for 60 seconds. Added offline recovery and cache regressions; merge gates, lifecycle edges and existing smoke promises remain unchanged.


- PRBLOCKERS-01 HAM validation repair: refresh the reviewed `pr-next-action.mjs` source projection hash after adding the closer deadline diagnostic helper. State transitions and the independent graph remain unchanged; targeted SMV validation covers the refreshed manifest.

- PRBLOCKERS-01 final comment remediation: resolve real `remediationWorker` launch IDs, retain actor-specific live actions, separate owner and successor deadlines, attest intermediate closer commits, and fail closed on ambiguous review families. Bound report reads with `--limit`, a rate-budget preflight and a REST read cap; document and test strict malformed ownership handling. No persistent store, lifecycle, merge gate or smoke promise changes.

- PRBLOCKERS-01: Add `npm run pr-blockers -- --repo example/project` for a read-only per-PR blocker table and version 1 JSON, with shared closure decisions, exact-head coverage, CI, durable ownership and optional generated-conflict detail.

- HAM PR #1718: Account for the findings-batch requeue migration’s schema probes in the closure-latency regression test while preserving the existing non-migration read budget.

- FINDINGSREQUEUE-01: findings no longer get stranded on a findings batch that failed after its worker ended. Before this change, a batch whose settlement errored kept its findings bound (`batch_id`) forever: each poll re-checked the same ended launch, and nothing re-batched the findings or launched a new worker. Now, when every launch under the batch's idempotency key is terminal in the launch ledger, a batch is released in two cases. The first is an error that cannot clear (no pushed head, no publication, failed preparation, identity or receipt mismatch, or a malformed manifest). The second is a batch that has stayed unsettled, with an error or without outcomes, for longer than `ADVERSARIAL_FINDINGS_BATCH_TIMEOUT_MS` (default 24h; the ledger may then also prove the launch absent). Release clears `batch_id` on the batch's open findings, adds 1 to the new `finding_backlog.batch_attempts`, and writes a `finding_batch_releases` audit row naming the old batch and the reason. The third attempt drops the finding with `batch-retry-exhausted: <last error>` instead. A live keyed launch, ledger evidence that cannot be read, or a batch waiting on its open marked PR is left untouched. A retry hashes the attempt number into its manifest, so it gets a fresh batch ID and idempotency key. Legacy drop reasons no longer error the whole batch: an exact code in another spelling maps to the current vocabulary, and any other invalid outcome returns only that finding for re-verification while the rest settle. Root cause of `batch-push-evidence-missing`: `hq dispatch status` reports every unobserved milestone as `not_started`, and HQ re-probes `branch_pushed` at exit only for `pr`/`branch-push` launches, never `decision-only` ones. The collector's "milestone present but not done" check therefore rejected batches that had really pushed. The milestone is no longer consulted; the remote tested head, already verified, is the push evidence. A batch that drops everything settles without any push. `nonBlockingBacklog.progress` reports open/unbatched/batched/stranded/retrying/exhausted counts. Migration `20261107_findings_batch_requeue.sql` is additive and idempotent. Tests: `test/findingsrequeue-01.test.mjs`; `test/findings-batch.test.mjs` updated where it pinned the old stranding behaviour.

- HAM PR 1719: rewrite the closure-gate-read import in the activation-check data-URL fixture so the token-parser regression runs on Node 22 and 26.

- CLOSERGATES-01 final comment remediation: normalize closure-resume SHA comparisons, emit final progress receipts for definitive predicate refusals, and count conflict heads on every report while keeping non-final repair observations out of terminal AMA state. Offline regressions cover mixed-case evidence, the predicate CLI, conflict deduplication and exhaustion from final reports alone.

- CLOSERGATES-01: a closer that finished its remediation and validation no longer fails at the merge gates on a single transient read. The closure phase was a chain of mandatory remote reads, each terminal on its first failure and recovered only by a full relaunch. (1) The predicate inputs moved from prompt shell the hammer re-typed into `bin/hammer-predicate-inputs.mjs` (`src/ama/predicate-inputs.mjs`). A re-typed copy had piped `jq -r` output with its trailing newline into `@uri`, so the protection read asked for `main%0A` and got 404 "Branch not found". The helper takes the base from the parsed snapshot, validates it as a branch name and encodes it once. (2) `src/ama/closure-gate-read.mjs` classifies every closure-gate failure: transient failures retry in place with the HAMMERLAUNCHREAD-01 backoff (moved here and re-exported by the controller) inside a 120 s budget; definitive answers refuse as before; a 404 retries only while a branch read contradicts it, and otherwise refuses as `protection-branch-not-found`. `hammer-context.mjs` retries its reads and reports an unreadable protection read as `requiredChecks: null` with `requiredChecksUnavailable: true`, never `[]`. The Git credential helper retries a mint that timed out or failed to run within 7 s; an API mint failure of that kind records the retryable `credential-refresh-unavailable`. (3) A gate that exhausts after the run published its validation audit appends a closure-resume receipt to the head's AMA audit (`src/ama/closure-resume.mjs`). The closer's next launch on the same head gets a closure-only prompt block and `closure-resume.json`, and `hammer-validate.mjs` reuses the evidence instead of re-running. A moved head voids it. (4) `hammer-terminal-audit.mjs --final rebase-conflict` exits 65 and records nothing until conflicts on three heads exhaust the run's repair budget, so a repairable conflict goes through Appendix D. `hammer-publish.sh` exports `HAM_PUBLISHED_AUDIT_HEAD`. Tests: `test/closergates-01.test.mjs`, plus updates in `ama-hammer-retry-cap`, `ama-hammer-merge-protocol-prompt`, `hamgittoken-01` and the protection-fetch helper.

- HAMMERLAUNCHREAD-01 final comment remediation: verified that `assert-owner` and `assert-launch` already enforce zero arguments in the reviewed head. Added offline CLI regressions for both verbs and `resolve-environment`, checking that trailing arguments (including an empty string) return usage and exit 64 before controller work.

- HAMMERLAUNCHREAD-01: a transient launch-environment read failure no longer throws away a hammer run that has already finished its work. The controller read the dispatch-files evidence for its own launch only at the closure step, after remediation and validation, with three back-to-back attempts. The control-plane lookup fails in short bursts, so all three landed in the same burst, the controller refused `launch-environment-read-unavailable`, and the closer launched a whole new hammer run that repeated the work. Now the hammer prompt's one-time `inputs.sh` initialization runs `bin/hammer-controller.mjs resolve-environment` before any remediation. It keeps the confirmed activation in a launch-bound receipt, `<HAM_RUN_DIR>/launch-environment-<lrq>.json` (mode 0600, written once), and the closing `run` reuses it with no new read. A failure at that early point costs nothing: the existing uncharged deferral (exit 75) fires before remediation, validation or any lease. Failed lookups are retried with spaced backoff (`LAUNCH_READ_BACKOFF_MS`: 2, 5, 10, 20, then 30 s), with each wait capped so no read starts after the unchanged `LAUNCH_UNREADABLE_GRACE_MS`; every lookup keeps its load-aware timeout. The start and lease/merge gate launch-status reads use the same spacing, and the gate's deadline carries those two waits. A closing `run` with no kept receipt (an older prompt, or the merge-agent path) re-reads over the same window and then records the distinct retryable `launch-environment-read-unavailable-at-closure`, so a refusal after work can be told apart from one before it. The identity, legacy and malformed refusals are unchanged. A kept receipt that is malformed or names another launch refuses with those same reasons and is never replaced by a fresh read. Tests: `test/hammer-controller.test.mjs`.

- CLOSERREVIVE-01: the fixer and the closer now agree on whether a remediation job is alive. A job dispatched through HQ has no local process or heartbeat, so `remediationJobOwnership` expired it five minutes after spawn while the launch was still running; the closer then reclaimed it every poll and skipped the PR. The reconcile pass now records the launch status it reads from `hq dispatch status` as `remediationWorker.hqLaunch`, terminal included (a launch it reads as exited is recorded as terminal at once, so it stops owning the job), and the shared predicate reads liveness from it (requested, leased and running are live; terminal is not; a just-requested launch is live until first observed; local heartbeats and PIDs never make an HQ launch live). The stale-claim sweep uses the same predicate through `staleClaimMayBeReclaimed`, and the active-defer stop never stops an HQ launch, so a running HQ launch is never both a live owner and a reclaim candidate. A comment-only final round whose re-review the watcher suppresses, while it runs and after it completes with a push of the current head, now feeds the shared next-action snapshot as a suppressed final push, so the closer launches instead of waiting for an exact-head review that never comes (a live remediation launch still owns the head first). The watcher's AMA-pending log names the owner (`lrq=`, `owner=<actor>(...)`, `owner=closer(launching)`) or says `released ownership` with `owner=none` instead of `lrq=unknown workerClass=unknown`. Tests: `test/closerrevive-01.test.mjs`.

- PROFILENODE-01: the config loader reads an optional profile overlay, `config.profile.<profile>.yaml`, between `config.yaml` and `config.local.yaml`, with profile resolution matching the platform loaders: an explicit top-level `profile:` key, then env `AGENT_OS_PROFILE`, then `reference-host` when `config.profile.reference-host.yaml` sits beside the top file, otherwise `core`. Only the `reference-host` profile has an overlay file, merged with the same deep-merge semantics as the local layer (so `config.local.yaml` and env still win). The resolved profile is exposed as `AgentOSConfig.profile` and `profileSource` (it is not injected into `values`), the overlay is a cache-watched file, and `AGENT_OS_PROFILE` is part of the cache key, keyed on the trimmed value `resolveProfile` reads (blank counts as unset), so a blank or padded value shares the slot of the profile it resolves to. Readers such as the `github-app-identity.mjs` `entitlements.<id>.gh_bot_login` lookup already go through the loader and now see overlay keys. With no overlay the effective config is byte-identical to before. Covered by `test/config-loader-profile-overlay.test.mjs`.

- ANY-12 final-review remediation: the standalone review hardens its failure modes. A provider body that cannot be read, and any unexpected error in `adversarial-review standalone`, now exit `2` instead of `1` (request-changes). `--max-output-tokens` sets the reply budget (default 8192), and a reply cut off at the limit (`stop_reason: max_tokens`, `finish_reason: length`) is reported as truncation instead of an empty or partial review. The request states that the model sees only the diff, and the diff sits between per-request nonce tags it cannot close. A stdin diff is refused as soon as it passes `--max-diff-bytes`. The CLI's main-module check resolves symlinks, so the npm bin link no longer exits `0` without doing anything. Offline tests cover each case.

- ANY-12: adversarial-review stands alone. Added a `NOTICE` (Lacey Enterprises LLC; the Apache-2.0 `LICENSE` is unchanged and now pinned by a test), a standalone `src/standalone-review.mjs` entrypoint (`npm run review:standalone`, or `adversarial-review standalone`) that reviews one diff through an Anthropic or OpenAI API key using only the kernel prompt, reply and verdict contracts, and a README install-and-run section. The path is additive: no existing entrypoint, config key or default changed, and it imports no daemon, config or host module. Offline tests drive it with a stub provider.

- GEMINIREMEDIATE-01 final review remediation: the alternate reviewer for a Gemini-remediated head is now the reviewer the watcher's own route picks with Gemini excluded (domain route tables and config included), not any uncapped quota harness; `routePR` now passes `reviewerReassignment` and `excludedReviewerModels` through; the per-poll job lister caches each state directory's listing by directory identity and mtime instead of re-listing `completed/` every tick; and `docs/data-model/catalog.json` registers `src/gemini-remediated-head.mjs` and `remediationWorker.reviewerReassignment`. Watcher test stubs export `GEMINI_REMEDIATED_HEAD_REASON`.

- GEMINIREMEDIATE-01: Gemini can remediate while it is the always-on reviewer. The remediator fallback refused Gemini whenever Gemini reviewed the next round (`reviews-next-round:gemini`), and always-on made that every round, so while Codex was capped nothing could remediate although Gemini had capacity. The rule it protects, that no model reviews a head it produced, is now kept per round: the fallback selects Gemini when another reviewer model may review the builder's PR (not Gemini, not the builder's own family) and is not capped, and records `remediationWorker.reviewerReassignment` (`gemini-remediated-head`). The watcher then excludes Gemini from every review of that PR (always-on/fallback layer, an operator Gemini pin, the AFH fallback, exec-failure and timeout fallbacks, review-worker-class fallback) via `excludedReviewerModels` on the route, and logs `reviewer-reassignment` when it claims the review; the review row's `reviewer` is the reassigned model from that claim. Gemini never reviews a Gemini-built PR, as before. With no usable alternate the refusal stays and the skip reason now names why (`reviews-next-round:gemini;no-alternate-reviewer:claude=builder-family,codex=capped:...`). Non-capped routing and routes without an exclusion are unchanged. No new column, config key or check; see the agent-os SEV2 report for the incident.

- REMLANEACCOUNT-01: in native orchestration mode an account-bound remediation lane (`remediator-claude-corp`) is handed to HQ dispatch, which binds the account, instead of being refused with `requires-account-bound-hq-dispatch`. While Codex was capped this refusal held every comment-only PR (`remediator-capped-hold`) although corporate Claude had quota. The lane is refused only when HQ dispatch is unreachable (no `HQ_ROOT`, or one that does not exist); `agentos` mode and every other lane are unchanged, and the handoff keeps the ordinary `hq` claim/liveness/completion/reaping bookkeeping (`remediationWorker.hqDispatchHandoff` audit). The watcher's `remediation-job-missing` closure blocker now carries `remediationHold` (lane, reason, hold-until) read from the latest held job. The 174-deep `ama.closure_queue_depth` gauge was diagnosed as merged PRs the closure-lag reaper never re-reads (its live check skips already-paged entries); that is a separate follow-up and is not changed here.

- LAC-2157 final comment remediation: `createRateLimitThrottle` now uses an injected `statImpl` for store ownership discovery by default, while preserving explicit `storeStatImpl` overrides. Offline regressions cover directory ownership fallback and owner-scoped writes.

- GHSTATEOWNER-01 / LAC-2157: the `0600` GitHub budget store is now private to its owner in practice as well as in mode. A caller whose uid does not own the shared store (or, before it exists, its directory) uses `rate-limit-state.uid-<uid>.json` with its own lock and throttle status file, and never writes the shared store. Reads classify `missing`, `malformed` and `unreadable` (errno) instead of returning an empty snapshot for every failure. A writer refuses (`GITHUB_BUDGET_STORE_UNREADABLE`) to rename over observations it could not read. `runtime-status` reports the store scope and classification. Credential isolation, the observed-limit floor, merge rules, atomic writes and locks are unchanged. See the [SEV4 report](../postmortems/SEV4-GHSTATEOWNER-01-a-private-github-budget-store-was-read-as-empty-across-owners-2026-11-03.md).

- STRICTSETTLED-01: unify the watcher's settled-clean release predicate across follow-up claims and active defer with merge authority's strict-mode predicate, so Comment-only reviews that still owe remediation retain their worker path. The AMA closer requeues a settled release with no live remediation job at most once per PR head, within the remaining round budget, recording `remediationJobMissingRecovery`. The spec and runbook distinguish automatic recovery from explicit operator retriggers and document the shared requeue metadata.

- WATCHERANONBUCKET-01: cap the throttle floor at 10% of the observed quota (minimum 1), so anonymous 60/h buckets can admit requests. Deferred diagnostics name the credential, balance and effective floor; transitions to zero remaining retain a known limit when failure headers omit it.

- LAC-2151 final comment remediation: verify the cached processed review digest as well as the raw model reply before redelivery; missing or mismatched cached text is retained as evidence and not reused.

- LAC-2151 integration with LAC-2075: the durable write-boundary hook follows the sending-token budget preflight; tests retain both protections.

- LAC-2151 storage hardening: a saved review must durably enter `write-started` before publication. A failed checkpoint preserves exact-head recovery and refuses the public write; later bookkeeping failures cannot make a posted body reusable.

- REVPOSTSTALL-01 / LAC-2151: a reviewer reply that passes the posting contract is now preserved with its exact head and identity binding before the pre-post side calls. A delivery stall that has not reached the GitHub write is bounded and released as uncharged `[reviewer-stalled]`. The next same-head claim posts the preserved reply without rerunning the model. Witness: PR 1700's completed Gemini review waited about 57 minutes behind the shared default-credential core throttle. Why that shared bucket stays below its floor is unproven. See the [SEV3 report](../postmortems/SEV3-a-generated-review-waited-57-minutes-behind-the-shared-github-throttle-2026-11-03.md).

- LAC-2075: GitHub budget preflights and header observations now name the credential that sends the request. A low anonymous `default` bucket can no longer defer watcher intake or other authenticated reads and writes, and one token cannot borrow another's budget or poison it. A low or zero budget for the sending token still defers. This also covers the `reviewer.mjs` review-post preflight. The floor, urgent reserve and fail-closed gates are unchanged. See the [SEV3 report](../postmortems/SEV3-LAC-2075-authenticated-github-reads-deferred-by-the-anonymous-budget-2026-11-03.md).

- PR #1701 final comment remediation: strengthen offline fixtures to assert that the known-published-head stop emits one progress call and that successful merges persist run-scoped exact-head proof from the post-merge JSON read. The outcome classifier always returns an object, including for missing live state; production behavior, persistent shapes, lifecycle states and smoke promises remain unchanged.

- PR #1701 rescue: give rendered merge fixtures isolated launch/run identities, keep ambient worker identity out of fixtures, and assert retry events retain their raw infrastructure reason in `lastPhase` alongside the classified outcome. Existing exact-head merge-proof and retry/refund rules remain enforced.

- LAC-2133 final comment remediation: accept camelCase launch request time and identity in the live closer inspection handoff, including its diagnostic timestamp, while retaining snake_case precedence and custody fences. Offline regressions cover alias timing, identity mismatches and incomplete snapshots; the existing subject/head guard already rejects a missing snapshot.

- PR #1699 rescue: shorten redundant scope/restore guidance to meet the existing rendered 60 KiB prompt limit. CI edits and additions remain operator-only, permitted non-CI base restoration retains finding authority and validation, gitlink edits remain forbidden, and dispositions stay in the correct reply/audit artifact. The byte-budget limit is unchanged.

- WSOBSPAGE-01 final comment remediation: share one workspace inventory between closer reaper discovery and probe-history pruning per pass. Memoize CI-orphan workspace evidence by repository and branch within each health snapshot, including refusals; skip reads for missing branches and cap observation paging at the remaining snapshot deadline. Targeted offline regressions cover cursor refresh, incomplete inventory, scoped cache isolation and deadline exhaustion. Existing lifecycle states, persistent shapes and smoke promises are unchanged.

- WSOBSPAGE-01: CAPREHEAD and pipeline health request workspace evidence for the target repository and branch; the closer reaper excludes directories proven absent. Unknown identities and presence remain evidence requiring custody checks. The companion Agent OS producer filters before pagination within its existing 10,001-slot bound. Workspace reads budget one page for an exact worker, the producer bound for scoped requests, and 1,000 rows for compatibility listings. Exhausting that budget returns inspectable rows with `ok: false`, `complete: false`, `truncated: true` and `reason: worker-observation-truncated`; custody and health consumers reject partial evidence. Real outages retain their unavailable result. Synthetic coverage includes 4,300 slots and twelve live workspaces.

- PR #1697 rescue integration: reviewed the existing terminal-retry and dispatch-outcome edges, documented fresh replacement identity and bootstrap-drain custody, and refreshed the combined dispatcher source projection without changing lifecycle enum values or graph edges. The independent SMV graph and mutation tests remain authoritative.

- CLOSERCRASHRECLAIM-01 final comment remediation: deduplicate successful bootstrap-drain signals, fall back to direct-child termination after group signaling errors, and place the crash-recovery guidance in its own [closure runbook subsection](../RUNBOOK-ama-closure.md#closer-crash-recovery-closercrashreclaim-01). Offline regressions cover delayed exit, escalation and unconfirmed drain.

- CLOSERCRASHRECLAIM-01: drain readiness controller groups after bootstrap failure; allocate a fresh worker identity after terminal lease reclamation; key hammer wakes by lease generation and next attempt. Live-owner and dirty-tree fences remain enforced. See [closure recovery](../RUNBOOK-ama-closure.md).

- AMA-PR-1699: clarify that CI scope restrictions also govern guarded restorations, put remediator scope dispositions in `pushback[].reasoning`, and record Hammer dispositions in its audit comment.

- HAMMERNOCI-01: hammer and remediator instructions decline CI changes as operator-only and identify follow-up-only findings in replies without implementing them. Existing prompt tests cover both rules in rendered instructions.
- LAC-2133 / HAMWORKPROGRESS-02: bound live closer operator inspection independently of heartbeats; preserve execution custody, validators, writers and claimed successor generations. The original regression returned ama-pending at expiry; injected-clock coverage verifies handoff, deduplication and failed-delivery retry. Loaded-runtime and natural closure acceptance remain pending.

- PR #1696 rescue: keep publication-recovery and delivery-index dependencies inside the existing offline watcher fixture boundaries in the fast-merge and reviewer-timeout handoff suites. Both suites continue to exercise the real watcher and CI admission paths; disposable-Git publication proof and durable delivery behavior remain covered by their dedicated integration tests.

- PR #1696 final comment remediation: validate supplied publication-proof head SHAs, reuse CI admission's known head while retaining the final live-head check, and classify concurrent in-place round exhaustion from the current job. Focused offline fixtures cover malformed heads, head movement and concurrent exhaustion. Repair watcher/API fixture isolation and completion diagnostic expectations, and retain indexed reply-comment delivery debt on recovered final completion; lifecycle states, round budgets and smoke promises are unchanged.

- REMPUBPROOF-01: prove rebased remediation publication from equivalent worker patches on the live head; recover proven publication stops once through validated final completion or the remaining CI-regression round budget. Retained unpublished debt names both heads. Synthetic Git fixtures cover rebase, missing/partial work, unrelated heads, stale evidence, final blockers and budget exhaustion.

- PR #1692 final review: cover exact single-column drift for both the passes and reviews selectors, including the reviews enrichment tables. Table-less stores retain the unavailable-store contract.

- SENTINELREVIEWROOT-01: table-less review evidence returns `review_store` unavailable, preserving column diagnostics for existing tables. Synthetic fixtures cover both selectors and single-column drift.

- PR #1693 HAM remediation: cache the produced-head snapshot fields once in the retention guard and remove the unreachable conflict alternative from the downstream green-CI branch. Offline regression tests retain conflict-first repair and base-policy behavior.

- LAC-2148 final comment remediation: pass snapshot mergeability and merge state into the verify-head base-policy helper so its conflict guards remain authoritative at the produced-head retention call. Focused offline tests cover the snapshot arguments.

- 2026-11-02 — LAC-2148 / CONFLICTBEFORECI-01: route positively conflicting published heads through bounded conflict repair before absent-CI waits; retain unknown observation, LAC-2097 head retention and existing custody/merge gates. See [RCA](../postmortems/LAC-2148-conflict-before-ci.md).

- ARCH-01 final remediation: defer the architecture review schema mirror until this reader consumes its settings, per CFGREADERSCOPE-01. Offline tests verify that checked-in configuration and local overlays ignore this sibling-owned namespace, including future keys and thresholds validated by Python.

- LAC-2146 final remediation: the qualification in [PR #1691](https://github.com/laceyenterprises/adversarial-review/pull/1691) covers unresolved unpooled fallback attribution in `skipped[]`, including an absent resolver and exhausted or successful subsequent routes.

- GEMREMEDIATORCLASS-01 / LAC-2146: [PR #1691](https://github.com/laceyenterprises/adversarial-review/pull/1691) implements concrete HQ `remediator-gemini` routing while preserving the logical remediation route, registered model policy, entitlements and dedicated builder isolation. The paired [Agent OS #10117](https://github.com/laceyenterprises/agent-os/pull/10117) release and live adoption remain separately gated by [LAC-2146](https://linear.app/laceyenterprises/issue/LAC-2146).

- ARCH-03: [PR #1688](https://github.com/laceyenterprises/adversarial-review/pull/1688) implements ARR-only architecture-rubric selection across reviewer stages and runtimes; mixed PRs retain the code rubric. Source merge, normal deployment and natural ARR-only/mixed review acceptance remain distinct. Verdicts, attestation, remediation and merge behavior are unchanged.

- Isolate controller test audit heads from inherited Hammer dispatch SHAs so startup-failure fixtures record audits under their own test identity.

- CLOSERLAUNCHENV-01 final remediation: retryable controller startup failures
  keep deferred audits without emitting final `terminal-stop` progress receipts;
  malformed activation and foreign identity retain final receipts. Documented
  that synchronous dispatch-file retries run back-to-back without backoff.

- LAC-2145 / LEASECIPROOF-01: pair synthetic pending-owner PIDs with raw process-start fixtures and qualify all three intermittent assertions with counted trials. See the [SEV/RCA evidence and limitations](../postmortems/LAC-2145-pending-owner-proof-qualification.md). Production ownership fences are unchanged.


- FINDINGSBATCHCUSTODY-01 (LAC-2143): accept native workspace display paths
  without deriving repository authority from them; replay the actual public
  launch projection and retain keyed identity and publication fences. Historical
  invalid outcomes remain under separate owner adjudication.

- REVIEWSTALL-01 HAM validation repair: align the Codex invocation regression
  with ceiling-capped stall deadlines and reviewer metadata, and refresh the
  reviewer runtime state-source fingerprint for the existing cancellation path.

- REVIEWSTALL-01 final comment-only remediation: `spawnWithInput` and
  `spawnCaptured` forward custom `onStall` receipt sinks; omitted sinks retain
  the stderr fallback. Stall classification accepts raw strings as well as
  Error objects. Focused offline regressions cover both wrappers and input
  shapes; lifecycle states and smoke promises are unchanged.

- REVIEWSTALL-01: native reviewer calls use load-aware first-output and
  no-progress deadlines within the existing wall ceiling. Stalls emit a
  timing receipt, release the seat, and return to the existing queue without
  spending review or recovery attempts.

- HAMGITTOKEN-01 final rescue: the outer 120-second submodule-sync bound owns its child timeout and waits for lock cleanup; bounded snapshot and publication proofs accept unset or empty `HAM_NODE_BIN` consistently. Credential refresh classification and exact-head merge predicates remain intact.

- Preserve the API-published head and starting head before attestation so a failed attestation retains exact publication provenance for closure recovery; cover the failure with an offline regression.

- **HAMGITTOKEN-01 test fixture:** Inject the metered Git execution seam into
  rebased-head coverage tests and assert Hammer credential mode. This restores
  offline coverage of bounded fetch retries after the Git wrapper change.
  Isolate CLI credential fixtures from worker credentials and use explicit ESM
  imports in the API publication fixture for Node 26 compatibility.

- **HAMGITTOKEN-01 final remediation:** Bounded rebased-head submodule sync uses
  the Git outcome classifier, preserving `git-credential-refresh-failed` before
  lease release. Bounded fetches accept an unset or empty `HAM_NODE_BIN`, and the
  credential helper is executable. Offline regressions also verify that API
  publication already preserves its pushed head and provenance after a refresh
  failure. Existing lifecycle states, retry budgets and smoke promises are unchanged.

- **HAMGITTOKEN-01:** Closer Git transports mint credentials on request through
  the existing launch refresh command. Base fetches, publication, history reads
  and controller descendants share the helper; mint failures retain retry
  ownership as `git-credential-refresh-failed`.

- CONFLICTHOTSPOT-01 final comment-only remediation: root README change notes
  remain required in this repository; per-ticket fragments apply to module
  documentation. The hammer prompt explicitly creates or updates module fragments.

REMGEMINI-01 parity: both Node config readers accept `remediator-gemini` as well as `gemini` in the fallback list. This expands validation only; defaults, fallback order, and selected provider do not change. Paired with Agent OS #10087.

- CLOSERLAUNCHENV-01: retry controller launch-environment reads with the shared
  load-aware budget. Exhausted reads and absent legacy metadata use explicit
  retryable no-merge outcomes and existing cap refunds; malformed values and
  foreign identities still hard-stop. See the closer runbook for deployment
  and natural-traffic acceptance.

- HAM: retain explicit bug-fix-only freeze contracts in the MLR-03 documentation,
  including the merge-agent scope and promotion boundary, while preserving the
  live-PR-only exception policy.

- MLR-03: [Merge Authority v2 spec v1.0](../SPEC-merge-authority-v2.md)
  proposes owned recovery, one subject budget, capped load-aware deadlines and
  all 61 MLR-02 inheritance obligations. The [v1 freeze](../../src/ama/FREEZE.md) now
  permits live-PR unblocks only, each with a requirements row and scenario; manual
  recovery receives the same treatment. Operator approval, implementation and
  activation remain later MLR steps.

- CAPREHEAD-02 final comment-only remediation: exhausted-verdict projection uses
  a canonical 40-character hex placeholder distinct from the source head,
  including an all-zero source. Focused offline tests enforce SHA format and
  preserve the actual head in dispatch reservations; lifecycle and smoke
  promises are unchanged.

- CAPREHEAD-02: a capped PR with a known exhausted cycle can receive a single
  builder squash update under the existing exhausted-head verdict obligation.
  Unknown cycles report `cycle-unknown`; lifetime limits and custody remain
  authoritative. Dispatch or proven live custody suppresses the budget page;
  ineligible or uncertain recovery retains escalation. This interim recovery
  retains its planned MLR sunset.

- VERIFYHEADTRANSIENT-01 final remediation: terminal fallback preserves the resolved infrastructure retry outcome; lease model documentation and README state/smoke declarations now match the retry contract. Refreshed the reviewed closer guard fingerprint to resolve CI drift; the lifecycle graph and smoke commands are unchanged.

- VERIFYHEADTRANSIENT-01: explicit closer infrastructure read failures use the existing retryable deferral and lease release path. They refund retry accounting and retain the closer retry owner and load-aware deadline; adjudicated no-merge decisions remain final. See the closure runbook change note for the required live receipt.


- BASEFETCH-01 final comment-only remediation: the offline real-Git failed-fetch
  fixture now asserts empty cleanup diagnostics alongside the preserved fetch
  error. Deleting an absent private ref succeeds silently; unconditional cleanup
  and merge behavior remain unchanged. The validated-closer queue fixture loads
  the new base-capture helpers so strict rebase checks exercise real local fetches.

- BASEFETCH-01: verify-head captures each base fetch through a private temporary
  ref, disables pruning/tag following and configured wildcard refmaps for that
  read, and preserves fetch and load-helper diagnostics. Revalidation receipts
  distinguish invalid validation SHAs from failed base fetches. Offline fixtures
  cover competing local fetches, stalled transport under simulated load and the
  existing branch-protection 403 fallback; merge authority is unchanged.

- HAM CI repair: align offline test expectations with Claude's explicit high
  effort argument and the shared `CODEX_MODEL_ID` reviewer/remediator pin.

- MES-09 final comment-only remediation: standalone local Codex/Claude runtime
  calls resolve implicit defaults before model auth and pass the same pair to
  spawn. Environment pin checks accept raw `codex` and `claude-code` aliases.
  Focused offline regressions cover defaults, explicit pairs and pin aliases;
  lifecycle states and existing smoke promises are unchanged.

- MLR-01 final remediation: status grouping and journal episodes prefer the same subject identity; invalid CLI arguments print usage and return 2. Detached/unreadable Git inspection preserves verified worker liveness. Terminal dirty custody is head-bound and cannot override a current live owner. Focused offline fixtures cover these cases; observation fields, lifecycle states and existing smoke promises are unchanged.

- MLR-01: `merge-lane status [--root <data-root>] [--json]` reads live open-PR inventory and NXA shadow observations. It reports current-head decisions, capped load-scaled deadlines, stable overdue episodes, observed ownerless minutes and clean-verdict-to-merge receipts. Observation/cursor journals are bounded and rotation-safe; matching-head terminal dirty branches provide ownerless evidence when no live owner exists. PRAGE in agent-os is the single overdue pager; the optional NXA overdue alert flag is now inert. Coordinate both repository merges and operator-owned activation before claiming deployment. Closure policy and execution remain unchanged.

MES-09: consume recorded MES apply decisions for implicit Codex/Claude review
and local remediation defaults. Preserve env and OSG pins, validate role/model/
effort against the live registry, and retain static execution on optional CLI
or policy failures. Model-bound auth and launch arguments share the final pair;
operator activation and live evidence remain pending.

- NXAOWNERREAD-01 final comment-only remediation: the closer launch-reader callback
  accepts omitted options. The stalled-read fixture counts resolver invocations
  separately from source reads, verifying the bounded refresh attempts without
  implying that a precomputed source-read count measures resolver retries.

### NXAOWNERREAD-01 — shared ownership reads at launch

The AMA closure scan, next-action evidence, shadow and hammer wake now share
bounded, load-aware ownership reads. When unknown ownership alone masks a
selected same-head hammer route, refresh returns `ownership-read-deferred`
without spending a decision-mismatch cycle or dispatching another owner.
A real live owner or changed route still invalidates selection. Each suppressed
transient mismatch emits `ama.closure.transient_ownership_refresh` with count
and reason; custody and merge admission remain authoritative.
After deployment, the SRE owner floats the revision, confirms the watcher restart,
and observes one full pass for zero `closure-decision-mismatch`, zero shadow
R04 `ownership-unreadable`, and natural closer launches. See the
[AMA closure runbook](../RUNBOOK-ama-closure.md#unreadable-ownership-recovery-ownerunreadable-01)
and the [manual SRE plan](../../modules/worker-pool/post-merge-actions/nxaownerread-01.yaml).

- CAPREHEAD-01 rescue: terminal skips and the disabled switch preserve ordinary
  overdue recovery escalation. Only a dispatched or positively live CAPREHEAD
  launch retains closure custody and suppresses retry-cap notices. The daemon
  classifies history using its canonical runtime root and binds the chosen mode
  plus exact PR coordinates into the prompt; workers need no helper checkout.
  Dispatch shares the bounded coexistence deadline. Canonical settled verdicts
  are `approved` and `comment-only`; all existing merge and lifetime gates remain.


- CLOSERSCANREAD-01 comment-only follow-up: strict unhandled-rejection regressions verify that snapshot and individual reads can reject after their timeout without crashing or mutating ownership. `Promise.race` already retains rejection handlers after settlement; runtime behavior is unchanged.

- CLOSERSCANREAD-01 final remediation: isolate the census cursor from capacity checks, exclude inactive records before budget deferral, require a complete census for missing-row retirement, and preserve individual failure and timeout evidence. Focused offline regressions cover these guards; lifecycle values and existing smoke promises are unchanged.

- CLOSERSCANREAD-01: closer launch scans fall back from failed batch snapshots to bounded individual reads, defer fairly at a load-aware pass deadline, and report snapshot timing and fallback counts. Dispatch lookup deadlines now scale with load; unreadable ownership still holds custody.

### CAPREHEAD update classification and executable prompt

Branch maintenance classifies complete PR history without running merge proofs
or inspecting artifacts in a different repository checkout. The daemon binds repository, PR number, exact source head and selected update
mode into the dispatch prompt using its canonical launch-provenance root.


### CAPREHEAD-01 correction — squash histories containing hammer commits

The daemon selects the strategy with its canonical provenance root, reusing
the existing `isHammerCommit` detection through [`primary-change.mjs`](../../src/ama/primary-change.mjs).
A range containing hammer commits becomes one new builder commit on current
`origin/main` via `git merge --squash <old-head>` and an explicit
force-with-lease push. A non-exhausted builder-only range retains merge-main
and a fast-forward push. Both preserve both sides' behavior, regenerate generated
files, keep the PR open and add no closer trailers or attestations.

Merging main after hammer commits advances only the final merge base; the
first hammer's parent still selects the old primary head. Primary-change then
returns unknown because the merge bases differ. The squash removes hammer
ancestry and the non-closer head receives full fresh review of the entire diff.
The selector identifies hammer history before merge-base and artifact proofs. Unreadable history is reported instead of guessed.
CAPREHEAD-02 supersedes the original non-exhausted-cycle requirement below;
one attempt per head and the lifetime cap remain unchanged.

- **CAPREHEAD-01 final remediation:** ledger validation matches repository casing
  consistently with its path key, retaining reservations and lifetime charges
  across casing changes. Added a test-only counter reset and isolated offline
  regressions for both findings. Store fields, lifecycle states and existing
  smoke promises are unchanged.

### CAPREHEAD-01 — bounded recovery after closer retry exhaustion

A settled approved or comment-only PR whose hammer wake reports `retry-exhausted`
can receive one builder PR-update per current head, up to two attempts per PR.
Recovery requires a known review cycle, green required checks (including
when mergeability is `CONFLICTING`), and proven absence of live closer,
remediator, builder and PR-update ownership. Missing or unreadable ownership
observations retain the blocker. Existing operator holds, autonomous execution
kill switch and hammer lifetime ceiling still apply.

`roles.adversarial.merge_authority.cap_rehead_enabled` defaults to `true`;
`cap_rehead_lifetime_cap` in the same subtree defaults to `2` (`0` disables
attempts). Their canonical environment variables end in `CAP_REHEAD_ENABLED`
and `CAP_REHEAD_LIFETIME_CAP` under
`AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_`. Domain `mergeAuthority` also accepts
`capReheadEnabled` and `capReheadLifetimeCap`. The existing builder default
`roles.build_pack_default_worker_class` applies when the creation title has no
recognized builder class. Hammer classes are refused.

The daemon classifies complete PR history from the canonical runtime, selects
the squash refresh above for exhausted cycles or hammer histories, or a merge
of `origin/main` for non-exhausted builder-only histories, and writes an owned
dynamic prompt binding repo, PR, branch, old head and update mode. The worker needs no local AR checkout. The
prompt requires preserving both sides of conflicts, generator-driven file
regeneration, affected tests and the selected push strategy.
It grants no merge authority and adds
no closer trailers or attestations. The normal review → closer path handles
the resulting head. A head/PR reservation is fsynced before dispatch; failed,
refused or unacknowledged launches spend the lifetime budget and never loop.
The dispatch uses `origin-owned` fleet retry policy.
A launch without an acknowledged ID conservatively retains custody across later heads.
See [the durable record](../data-model/cap-rehead.md).

`ama.cap_rehead.dispatched` and `ama.cap_rehead.skipped` expose reasons including
`cycle-unknown`, `live-owner`, `blocking-findings`, `checks-red`,
`already-attempted` and `lifetime-cap`. The existing
`ama.final_review_to_hammer_launch.summary` metrics include cumulative
process-local `cap_rehead.dispatched` / `cap_rehead.skipped` counters. An exhausted
cycle retains its budgets while the new builder head receives one classified
verdict through the existing exhausted-head owner.


EXHAUSTEDHEADOWNER-01 final remediation: proven completed final-round pushes
retain closer ownership at exhaustion; returning reviewed commits share the
watcher/closure delivered-pass predicate. Probe and pager failures stay local
to their PR/observer, and stale-head admission shares its remediation-budget
snapshot with capped closure. Offline regressions restore closer wake-drain
coverage. The closure runbook records the possible first-deploy SEV1 backlog
burst and read-only verification; existing lifecycle states and smoke promises
are unchanged.

- Explain validation-milestone CLI refusals with the required helper and verify
  that unavailable controller observations remain charged no-merge attempts.

- Preserve the Hammer controller shell exit status when the shell exits during
  an awaited empty process census; cover successful and failed exits offline.

- HAMMERNOPROGRESS-01 final remediation: commit receipts require ancestry above
  the dispatch target, with an offline head-advanced regression. Document all
  seven receipt kinds and bounded reasons, advisory validation signals,
  release-only observation diagnostics and consumer-first expansion rollout.
  Refresh the census timeout inventory and lifecycle observation declarations;
  lifecycle states and existing smoke promises remain unchanged.

- HAMMERNOPROGRESS-01: verified local commits and completed bounded validation
  emit finite run-bound progress receipts before first push. Controller process
  census deadlines scale with load; lease release distinguishes unavailable
  observations from owner loss. See the closure runbook for the
  companion supervisor's load-aware windows and terminal classifications.

- **LABELREARM-01 final remediation:** waiver observation shares asynchronous label reads after cached presence checks, preserves stopped-job budgets and provenance, and clears backoff only for newly accepted intent. Offline coverage now proves one exact-head reviewer spawn and no duplicate on the next poll; pre-review labels require removal and reapplication.

- **LABELREARM-01:** registered operator-label evidence on an already-reviewed, waiver-only hold now requests one exact-head waiver-observation review through the shared evidence predicate, retaining stopped follow-ups for the fresh review to supersede. Accepted intent exits operator backoff. The fresh review still decides; no label bypasses findings or merge checks.

- Correct the post-CI lease probe regression assertion: exhausted GitHub transport retries retain their probe failure and do not emit a lease-contention audit.

- **CLOSERCIWAIT-01 final remediation:** bind claims to the exported exact-head audit body, preserve the settled lease and consumed retry budget through merge, and distinguish pending CI and transport-probe failures from terminal refusals and lease contention. Offline regressions cover these paths; lifecycle states and smoke commands are unchanged, and organic post-deploy acceptance remains pending.

- Make agy print-timeout conversion tests deterministic under CI load while retaining the separate deadline-cancellation test.

PRIMARYDEADCODE-01 permits derived dead-code reversal only for author-added
single-line imports and module-private literal/None bindings in a closed
Python/JS/TS declaration grammar. Transient, unpersisted content reads must
prove every parent-file reference is covered by the same commit's authorized
deletion, with no surviving head references or dynamic namespace hazards.
See the [proof contract](../RUNBOOK-ama-closure.md).
- **CLOSERCIWAIT-01:** published-head CI settles before the closer predicate using the existing bounded lease-yield/reacquire wait. Phase head values are exported, claim binding uses a deployed helper, and verification/terminal failures name the failed operation. Existing smoke commands remain unchanged; post-deploy acceptance is an organic remediation push merging in the same closer run, still pending.
EXHAUSTEDHEADOWNER-01: a new builder head after cycle exhaustion receives one
verdict-only review. Pending repair custody retires on complete terminal owner
evidence at base, or at a moved head after a successful negative publication
read, preserving counters. Verified repair publication evidence persists across
admission ticks. Repeated overdue canonical absence retains custody and pages
the operator for inspection. After normal deployment, observe natural
foreign-head release, delayed verified-publication admission and absence
escalation read-only; offline tests do not
certify deployment. Findings retain final closer ownership; head-scoped retry
and deadline evidence cannot strand a new head. Spent budgets page once, with
lifetime escalation deduplicated across head changes. See the
[closure ownership contract](../RUNBOOK-ama-closure.md#exhausted-cycles-and-new-builder-heads-exhaustedheadowner-01).

REMGEMINI-01 follow-up: pooled fallback skips retain the registry fault in
`skipped[].detail`, matching standalone routing. An offline regression verifies
that account substitution still checks the selected corporate class's model
before launch.

REMGEMINI-01: Gemini remediation runs on the Antigravity harness. The local
spawn runs the managed `agy` with the `remediator-gemini` registry model and
the prompt as the `--print` argument, and the pre-flight probes agy's keychain
credential instead of the legacy CLI's `oauth_creds.json`. Remediator fallback
skips a busy, quota-held, mode-refused or unresolvable candidate for that launch
(`skipped[]` reason `model-unresolvable` for a registry fault) and tries the
next; one unresolvable candidate no longer aborts the selection.
`roles.remediator_fallback` accepts `remediator-grok` for the future Grok lane.

- GRK-03 remediation: always project a frozen `broker_instances` mapping, including empty and legacy-only declarations; cover the stable snapshot shape in offline reader and role-config tests.
- GRK-03: mirror account-scoped Grok OAuth/API-key declarations, reject duplicate custody/secret bindings, and retain subscription-first order and instance metadata through typed readers. Activation and both auth-kind MODEL-TURN receipts remain with GRK-16.

CLOSERPROOF-01: the hammer retry-cap series follows the heads the closer
authored. `proveCloserAuthoredStaleHead` also reports `currentHeadHammerAttested`
(an authenticated hammer edge ends at the exact SHA). The closure pass resets
the series once for a head with no such edge, such as another worker's rebase of
the hammer's commit, so that head is not stopped by an exhaustion recorded for
an earlier head. Trailers are never read. The lifetime ceiling is unchanged, and
a hammer push on the same attested chain keeps the cap.

MES-06: the review service records one shadow Model/Effort Selector decision
per review pass and per local remediation round through `hq mes decide --record
--json`. The CLI call is bounded and fails open, and it never changes the
execution the resolver chose. See "Model/Effort Selector review-service hook (MES-06, MES-09)".

HAMTERMSTOP-01: the hammer's `terminal-stop` progress receipt is recorded only
on the closer's explicit final exit (`bin/hammer-terminal-audit.mjs --final`).
Merge-phase deferred and retryable no-merge outcomes, and helper early failures,
no longer mark a still-working run terminal; their AMA terminal audits and
merge-action receipts are unchanged.

READMEFIX-01 restores the README title and introduction at the top and keeps
change notes in this section, newest first. Conflict resolution retains the
REMJOBPHANTOM-01 note added on main alongside the relocated notes.

AGYTELEMETRY-01: Gemini/agy reviewers request stream JSON and join the unique
`conversation_id` to the CLI planner transcript. Measured counters use
`agy-measured`; request/session disagreement is retained in pass metadata.
Dedicated reviewer accounts return counters through the pinned workspace
helper's `usage CONVERSATION_ID` verb. A missing helper or transcript keeps
the stream session totals, or the existing estimate when no measured totals
exist. Invalid/zero helper counters and transcripts over 8 MiB also fall back.
Cached input is separated from uncached input for pricing; reasoning is already
included in output. Chunked passes omit per-conversation reconciliation metadata.
An unsupported stream flag retries once as plain output within the original
deadline; stream errors are decoded before failure classification.
Deploy the matching Agent OS pinned helper
before reloading reviewer consumers. SRE observes natural measured passes and
the Google/agy quota evidence basis after deployment; source tests are not
the live receipt.

REMJOBPHANTOM-01 grants queued jobs five minutes of pre-spawn custody from
`pendingAt` (or initial `createdAt`), and unspawned claims five minutes from
`claimedAt`. Spawned workers require matching process identity or a progress
heartbeat younger than five minutes. A failed-CI closeout without proven
publication projects its selected retry successor independently of the finished
worker. Terminal jobs, workspaces and stale locks cannot retain closure.
Expired exact-head final-push hammer handoffs restore parked rows through the
existing request CAS and reach
normal leased closure on the next watcher pass. Offline fixtures cover reclaim,
live-worker retention, handoff scheduling and blocking-finding safety. After
normal deployment, passively observe reclaim reasons and normal closure
decisions; existing smoke commands and merge gates remain unchanged.

CLOSERDEADLOCK-01 keeps completed comment-only final-round push heads in the
posted closer lane and restores already queued heads without an operator label.
Each pass logs `owning lane=closer` and observes normal closure gates, including
CI changes and deadlines, despite an unchanged review fingerprint. The existing
handoff smoke covers closure observation across no-progress backoff; offline
watcher fixtures cover parked-row recovery and the first green pass. After
normal deployment, observe those logs on a natural final-round push. Merge
gates, leases, round budgets and per-PR caps remain unchanged.

HAMPROGRESS-01: run-bound closer phase receipts feed supervisor outcome, wall and token limits. HAMMERNOPROGRESS-01: seven first-write-only run-bound receipts: verify-head, remediation-committed, validation-passed, validation-failed, remediation-pushed, merge-attempted, terminal-stop. Commit ancestry above the dispatch target (legacy fallback: reviewed SHA) and advisory completed-command signals earn finite load-aware outcome slices; validation receipts do not prove tests ran, and timeouts remain unknown. Nominal outcome/exit windows are 3600/60 active seconds; final-stop grace expiry retains closer-terminal:<reason>. Wall/token ceilings and attempt charging are unchanged. One-shot and persistent process census deadlines scale with load; unavailable observations refuse merge; merge-lease release and acquisition classify them as controller-observation-unavailable separately from controller-owner-lost (VERIFYHEADTRANSIENT-01). Other admission callers retain generic refusals. SRE owns twelve hours of natural-traffic acceptance after ordinary deployment. Supervisor owns outcome/wall/token stops and existing terminal drain; lifetime charges remain. No merge gate or lifecycle state changes. Deploy the seven-kind supervisor consumer before or together with the producer/schema; older-consumer unknown-name tolerance is unverified; passively observe natural named stops, released custody and replacement under existing ceilings. Existing smoke promises unchanged. CLOSERCIWAIT-01: publication of a changed head uses the existing bounded, load-scaled CI wait before the exact-head predicate, yielding then reacquiring the merge lease. Phase-established heads are exported; post-publication verification and later procedure failures name their failing step. No lifecycle enum, cap, attestation or merge predicate changes. After normal deployment, SRE observes an organic remediation push reaching merge in the same closer run; source publication is not a live receipt. Existing smoke promises and commands remain unchanged. Final remediation preserves the settled exact-head lease and consumed retry budget through the caller predicate and final live gate; only a new merge-phase rebase regenerates internal audit/predicate evidence. CI-only waits defer protection admission to the full predicate, pending-only expiry remains deferred, and exhausted transport probes retain merge-lease-probe-failed. Publication exports the exact-head audit body for claim binding. Lifecycle states, allowances and smoke commands remain unchanged.
See [the closure runbook](../RUNBOOK-ama-closure.md).

HAMSCRATCHRESUME-01: pending quota resume retains hammer scratch through the
sweep and terminal reconciliation. A named terminal missing-phase outcome
permits one fresh closer with a new scratch and lease, crediting its PR/head
charge once while keeping the lifetime ceiling. Existing lifecycle enum values
and smoke commands remain unchanged. Retry edges settle historical quota kills
after successor publication while unresolved quota-killed leaves retain ownership.
Named missing-input cancellations recover despite retained quota metadata.
SRE acceptance is passive observation of
the next natural quota recovery after both repositories deploy and reload.
See [the closure runbook](../RUNBOOK-ama-closure.md).

CAPREHEAD configuration rollout: the Node reader registers `cap_rehead_enabled`
and `cap_rehead_lifetime_cap` first. A superproject Python/shell strict-loader
companion must land before either key is placed in shared YAML. Until then use
`AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_CAP_REHEAD_ENABLED=false` for the
review-service kill switch; this PR writes no live setting. Normal deployment
and loaded-service verification precede organic custody/escalation acceptance.
