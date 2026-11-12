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

## Interface changes

- New `src/remediation-live-pr-owner.mjs`: `createLivePrOwnerLookup` (runs
  `hq merge-agent pr-owner --repo R --pr N --json [--root HQ_ROOT]`),
  `claimWithLivePrOwnerGate`, `createLivePrOwnerClaimDecision`,
  `parseLivePrOwnerReply`, and the reasons `deferred-live-pr-owner` and
  `deferred-live-pr-owner-unknown`.
- `claimNextFollowUpJob` accepts `livePrOwnerDecision`. It is a synchronous
  pre-claim hook that can return `lookup`, `defer` or `claim`.
- `consumeNextFollowUpJob` and `consumeFollowUpJobsUntilCapacity` accept
  `livePrOwnerLookupImpl`. The follow-up daemon and `follow-up-remediation.mjs`
  `main()` wire the HQ lookup in. Other callers keep the previous behavior.
- Pending job records may carry `livePrOwnerDeferral`; see
  `docs/data-model/follow-up-jobs.md` ("One owner per PR branch").
- Uses the companion agent-os read command `hq merge-agent pr-owner`. It wraps
  `_active_worker_for_pr_head(pr_wide=True)`, which is the query behind the
  `hq dispatch --pr` "existing worker owns this PR" refusal. An older HQ CLI
  rejects the subcommand with exit 64 and `unknown merge-agent subcommand:
  pr-owner`. Only that exact reply keeps the previous claim behavior, with a
  warning. This is the same companion-deploy seam `hq dispatch --pr` uses for
  repair-in-place. Every other failure defers.

No new kill or cancel path exists. In-progress jobs are never read or rewritten
by this check. No CI check, gate, ratchet or label is added.

## Verification

- `node --test test/remediationowner-01.test.mjs`: 12/12. The suite covers:
  - a live PR-update owner defers and is named;
  - a terminal owner proceeds and the deferral is cleared;
  - a failed, thrown or empty lookup defers;
  - a different PR still proceeds;
  - an unchanged record is not rewritten;
  - the lookup budget holds;
  - the ungated path is unchanged;
  - concurrent gated claims keep the same-PR reservation;
  - an HQ CLI without the subcommand keeps the old behavior and warns;
  - `consumeNextFollowUpJob` leaves a running remediation untouched.
- `follow-up-remediation`: 385/385. `follow-up-jobs`: 172/172.
  `watcher-claim-loop`: 168/168. `arc19-boundary-gate`, `smv`: green.
- The 51 other test files that drive claim/consume/daemon paths pass through
  `node test/run-tests.mjs`.
- A read-only smoke through `createLivePrOwnerLookup` returned
  `{"state":"unsupported"}` against the deployed HQ CLI and `{"state":"free"}`
  against the companion branch's CLI, for a PR with no live owner.
