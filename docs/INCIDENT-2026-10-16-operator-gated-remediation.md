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

## Repair and remaining integration

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

The direct script caller is outside this repository. Completing the consistency
fix requires an authorized companion change in `agent-os`:

- `scripts/build-pack-official-record-bump.sh`: call the shared live-pack check
  immediately before the direct admin merge and hold on refusal.
- `scripts/build-pack-official-record-bump.test.sh`: add offline tests proving
  the merge call is absent on refusal and remains exact-head on success.

Run the existing
`modules/worker-pool/test/test-build-pack-official-record-bump-warning.sh`
slice as well; its already-landed/no-PR validation path must remain intact.
No superproject gitlink change is needed.

## Acceptance and SRE follow-through

The new operator-only, mixed-finding and waiver controls were checked against
unfixed sources and failed. The refused-publication reconciliation regression
also failed against unfixed reconciliation: it stopped for no progress instead
of recording the preservation failure. Updated focused tests pass, including
real offline Git remotes proving rejected publication retains the prior head,
an unrelated-file evasion is refused, valid fixes publish, the remote lease
rejects competing heads, and the publisher refreshes a stale base.

Validation recorded in this worker:

- All 20 focused REMLABEL-01 regressions passed.
- The gate-status, closer-dispatch and initial operator-finding slice passed
  all 206 tests; the final operator-finding slice also passed all six tests.
- `npm run lint` passed with zero errors (147 warnings).
- `npm run typecheck:contracts` and the offline byte-equivalence walkthrough
  passed. `git diff --check` passed.
- The full `npm test` attempt hit its 900-second bound. The large remediation
  module also hit bounded attempts of 180 and 120 seconds. These runs did not
  complete; they are not evidence of a green whole-repository suite.
- `test/watcher-claim-loop.test.mjs` hit both its 180-second bound and an
  isolated 300-second bound. No completed per-test results were reported;
  claim-loop validation remains unverified. No baseline attribution is claimed.

After both repairs merge and deploy, the SRE session verifies:

1. The next live-pack bump with a `live_pack_cross_edit` finding waits for
   `live-pack-edit-approved` instead of being reverted.
2. No PR is closed as empty after a remediation round in which the remediator
   emptied it; publication is refused and the previous head remains.
