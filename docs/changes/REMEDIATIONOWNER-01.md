# REMEDIATIONOWNER-01: follow-up remediation defers while a live HQ launch owns the PR

## Summary

A follow-up remediation job could start on a PR whose branch an in-place PR
update (`hq dispatch --pr`) was already changing, leaving two owners pushing to one
branch. A local follow-up job has no HQ launch row, so HQ-side refusals could
not see it. The follow-up daemon now checks HQ before it claims a pending job.
If a live launch owns that PR (a PR update, closer, repair-in-place epoch or
another remediator), the job stays pending with a typed `livePrOwnerDeferral`
that names the owning launch. The check repeats on the next pass. A failed or
timed-out lookup also defers, because unknown ownership is not free.

The final Comment-only round fixes lookup starvation: after 25 lookups a durable
filename cursor rotates the next pending scan, including after daemon restart.
The canonical data-model catalog now records both the optional deferral field
and the cursor, with `src/remediation-live-pr-owner.mjs` as a schema surface.
The ownership-race finding is closed against the merged HQ owner contract
(agent-os REMEDIATIONOWNER-01, `hq merge-agent pr-owner`). The spawn path asks
HQ again immediately before the worker runtime starts, after the pre-spawn
gates that can take minutes. If HQ now reports a live owner, or the lookup
fails, times out, is malformed or is unsupported, the claimed job returns to
pending through the shared budget-neutral pre-spawn requeue. It carries a typed
`livePrOwnerDeferral` naming the owner, and an operator retrigger keeps its
one-shot override. An HQ CLI without `pr-owner` no longer keeps the old claim
behavior: no answer is unknown, and unknown defers. There is no second ownership
store. HQ admitting a launch after the spawn-time read, or refusing a PR update
while a local worker runs, is recorded as the agent-os side's residual risk.

## Interface changes

- New `src/remediation-live-pr-owner.mjs`: `createLivePrOwnerLookup` (runs
  `hq merge-agent pr-owner --repo R --pr N --json [--root HQ_ROOT]`),
  `claimWithLivePrOwnerGate`, `createLivePrOwnerClaimDecision`,
  `deferClaimedJobForLivePrOwner` (spawn-time recheck),
  `parseLivePrOwnerReply`, and the reasons `deferred-live-pr-owner` and
  `deferred-live-pr-owner-unknown`.
- `claimNextFollowUpJob` accepts `livePrOwnerDecision`. It is a synchronous
  pre-claim hook that can return `lookup`, `defer` or `claim`.
- `claimWithLivePrOwnerGate` accepts `rootDir` to persist its scan cursor and
  passes the cursor filename as the third `claim` callback argument.
  `claimNextFollowUpJob` accepts `pendingAfter` to rotate its lexical scan.
- `consumeNextFollowUpJob` and `consumeFollowUpJobsUntilCapacity` accept
  `livePrOwnerLookupImpl`. With it, `consumeNextFollowUpJob` can also return
  `{ consumed: false, reason: deferred-live-pr-owner | deferred-live-pr-owner-unknown,
  owner | lookupReason, job, jobPath }` from the spawn-time recheck. The follow-up daemon and `follow-up-remediation.mjs`
  `main()` wire the HQ lookup in. Other callers keep the previous behavior.
- Pending job records may carry `livePrOwnerDeferral`; see
  `docs/data-model/follow-up-jobs.md` ("Live PR-owner admission snapshot").
- Uses the companion agent-os read command `hq merge-agent pr-owner`. It wraps
  `_active_worker_for_pr_head(pr_wide=True)`, which is the query behind the
  `hq dispatch --pr` "existing worker owns this PR" refusal. An older HQ CLI
  rejects the subcommand with exit 64 and `unknown merge-agent subcommand:
  pr-owner`; that defers as `lookup-unsupported` with a warning. Every failure
  defers.

No new kill or cancel path exists. In-progress jobs are never read or rewritten
by this check. No CI check, gate, ratchet or label is added.

## Verification

- `node --test test/remediationowner-01.test.mjs`: 16/16. The suite covers:
  - a live PR-update owner defers and is named;
  - a terminal owner proceeds and the deferral is cleared;
  - a failed, thrown or empty lookup defers;
  - a different PR still proceeds;
  - an unchanged record is not rewritten;
  - the lookup budget holds;
  - a free PR behind 25 owned or unknown PRs proceeds on the next pass;
  - durable cursor recovery, removed-job wrap and malformed-cursor fallback;
  - the ungated path is unchanged;
  - concurrent gated claims keep the same-PR reservation;
  - an HQ CLI without the subcommand defers as `lookup-unsupported` and warns;
  - `consumeNextFollowUpJob` leaves a running remediation untouched.
- Original implementation validation: `follow-up-remediation`: 385/385. `follow-up-jobs`: 172/172.
  `watcher-claim-loop`: 168/168. `arc19-boundary-gate`, `smv`: green.
- Original implementation: the 51 other test files that drive claim/consume/daemon paths passed through
  `node test/run-tests.mjs`.
- Earlier read-only smoke (before the HQ companion merged): `createLivePrOwnerLookup`
  saw the deployed CLI without `pr-owner` and the companion branch's CLI answer
  `{"state":"free"}` for a PR with no live owner.
- Final-round targeted validation passed: `remediationowner-01` (16/16),
  `follow-up-jobs` (172/172), `follow-up-remediation`, `watcher-claim-loop`
  (168/168), `arc19-boundary-gate`, and `smv` including its disposable sandbox
  smoke. Long commands used `bin/run-bounded.sh`; the full local suite was not run.
- Final-round guards passed: `npm run lint` (zero errors),
  `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (94 entries), `bash demo/research-finding-walkthrough.sh`, and
  `git diff --check`. Both affected existing state-source projections are unchanged.

### Spawn-time recheck (rebased onto main after the HQ companion merged)

- `node --test test/remediationowner-01-spawn.test.mjs`: 8/8. It covers:
  - an HQ owner that appears between claim and spawn defers before any worker
    starts, names the owner, charges no round and skips the rest of the pass;
  - a terminal owner (free at spawn) lets the job spawn;
  - a spawn-time lookup that throws, times out or returns nothing defers;
  - the production lookup defers when HQ exits 75 `ledger-unavailable`;
  - an operator retrigger keeps its override across the deferral;
  - without a lookup the spawn path is unchanged.
  With the recheck removed, 7 of the 8 fail.
- `hq merge-agent pr-owner --repo <owner/name> --pr <n> --json` on this host
  returns `{"ok": true, "owner": null, ...}` with exit 0 for a PR with no live owner.
