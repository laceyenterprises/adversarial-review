# Operator-gated remediation can erase a valid PR

A post-merge spec-lock bump for a running build pack received a blocking
`live_pack_cross_edit` finding. Its remediator restored the plan and prompts to
base, leaving an empty PR diff. The merge agent then correctly closed the empty
PR. The publication of the destructive remediation, rather than ordinary
empty-diff closure, was the failure.

## Confirmed causes

The finding renderer and trusted live-pack remediation context explicitly
recommended restoration to base. Follow-up dispatch never classified review
findings against `src/ama/operator-label-gates.mjs`; that registry handled CI
closure holds only. Publication had no preservation boundary for the original
PR delta.

The earlier equivalent bump was created and merged about fifteen seconds apart,
with no reviews, review comments, commit status contexts or label events. Its
body identifies `scripts/build-pack-official-record-bump.sh`. That script's
`--admin-merge` path calls an exact-head admin merge directly; it does not call
the reviewer's live-pack evaluator. This is a bypass of review, rather than
evidence that two executions of the liveness classifier disagreed. Neither
bump qualifies for the narrow plan-only gate-stamp exemption, since both update
prompt references as well as the plan's spec lock.

All incident identities are deliberately omitted from this public account.

## Repair and direct-merge integration

REMLABEL-01 classifies blocking review findings with the shared operator-label
registry. Operator-only reviews hold follow-up and terminal-hammer dispatch,
retain their changes, comment with the required label, and page once per head.
Mixed reviews instruct remediation to fix only ordinary findings and retain the
gated changes. A fresh review observing the existing waiver proceeds normally.

Remediation uses a publisher that refreshes the base and rejects an empty PR
diff or restoration of every original changed path before a lease-protected
push. A refusal records a failed round and preserves the previous remote head.
The staged prompts retain bounded stale-head replay through that publisher.
Ordinary empty-diff closure is unchanged.

`node bin/live-pack-check.mjs OWNER/REPO PR HEAD` exposes the same fail-closed live-pack
evaluator to direct merge callers. It reads the complete file list, pins plan
reads to the base SHA, checks current labels, and refuses changed inputs. Two
synthetic live official-record bumps are both refused; an existing waiver and
finished-pack controls pass. It does not add a CI job or apply labels.

The companion `agent-os` repair calls this checker from
`scripts/build-pack-official-record-bump.sh` immediately before its exact-head
admin merge. A refusal leaves the PR open with its changes intact. Missing
checker code, unreadable results, malformed results and head mismatches also
refuse merge. The checker runs from the installed source checkout, rather than
the PR-controlled scratch checkout. Existing no-PR and already-merged paths
keep their behavior. `scripts/build-pack-official-record-bump.test.sh` covers
these paths with offline transports; its live-pack refusal regression was run
against the unfixed caller and failed because admin merge was invoked.

Deploy this repository's checker before the companion caller, through normal
main-catchup and overlay float. Until the checker is installed, the repaired
caller fails closed. No superproject gitlink change is needed.

## Acceptance and SRE follow-through

The new operator-only, mixed-finding and waiver controls were checked against
unfixed sources and failed. The refused-publication reconciliation regression
also failed against unfixed reconciliation: it stopped for no progress instead
of recording the preservation failure. Updated focused tests pass, including
real offline Git remotes proving rejected publication retains the prior head,
an unrelated-file evasion is refused, valid fixes publish, the remote lease
rejects competing heads, and the publisher refreshes a stale base.

Validation recorded in this worker:

- The final focused gate-status, closer-dispatch and REMLABEL-01 slice passed
  all 222 tests, including all 20 focused REMLABEL-01 regressions. Another
  43 existing live-pack and operator-wake tests passed.
- The companion official-record shell suite passed, including six direct-merge
  preflight cases. The existing warning/idempotency slice and the ShellCheck
  gate also passed. All transports and merge receipts in these tests are local
  fixtures; no live state or operator labels were changed.
- `npm run lint` passed with zero errors (147 warnings).
- `npm run typecheck:contracts` and the offline byte-equivalence walkthrough
  passed. `git diff --check` passed.
- The full `npm test` attempt hit its 900-second bound. The large remediation
  module also hit bounded attempts of 180 and 120 seconds. These runs did not
  complete; they are not evidence of a green whole-repository suite.
- `test/watcher-claim-loop.test.mjs` hit both its 180-second bound and an
  isolated 300-second bound. A final 180-second retry also timed out, with
  `kill EPERM` during runner cleanup. No completed per-test results were
  reported; claim-loop validation remains unverified. No baseline attribution
  is claimed.

After both repairs merge and deploy, the SRE session verifies:

1. The next live-pack bump with a `live_pack_cross_edit` finding waits for
   `live-pack-edit-approved` instead of being reverted.
2. No PR is closed as empty after a remediation round in which the remediator
   emptied it; publication is refused and the previous head remains.
