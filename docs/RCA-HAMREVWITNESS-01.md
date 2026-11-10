# HAMREVWITNESS-01: review witness refused before edits

## Finding

With the exact posted review, resolving the plan head to candidate
`783bb8ab21a11381aaefea05a91d03ea20a1383e` fails the predicate
`review.commit_id !== plan.reviewedHead`. That refusal is correct: this review
is on `89d3e4316d09c584b193a1357a7b4e33e0140311`. A valid citation explicitly
using the review's own SHA passes the pre-edit check. The authoritative login
and accepted review state do not fail.

The incident's original plan JSON, invocation and helper revision were not
available in the source checkout or the posted closing status. Therefore the
fixture proves this concrete refusal and the valid-witness counterexample; it
does not prove which head was in the historical invocation. Missing or malformed
plan heads and missing controller pins can produce the same historical reason.
Calling the review itself invalid, or asserting that a particular historical
argument was supplied, would exceed the available evidence. The prior single
reason hid this distinction; the diagnostic added here exposes it on future
invocations.

## Evidence and reproduction

Read-only GitHub retrieval captured the complete REST response for
[review 5835410207](https://github.com/laceyenterprises/agent-os/pull/10491#pullrequestreview-5835410207)
in `test/fixtures/hamrevwitness-01/review.json`. The fixture preserves metadata
and body, including:

- `commit_id`: `89d3e4316d09c584b193a1357a7b4e33e0140311`;
- login: `lacey-claude-reviewer[bot]`;
- state: `CHANGES_REQUESTED`;
- submitted at: `2026-11-10T01:35:05Z`;
- zero blocking cards and six advisory cards, the last two demoted from blocking.

`findings.json` pins the complete `parseReviewFindings` output, including title,
file, lines, problem, significance and recommended fix. It retains all six
advisory identities in order: pending redispatch/direct reuse, mutation-lock
hold, retained unknown payload, hourly scan cost, retry cleanup hold, and
forced teardown. Demotion does not create a blocking citation under the same
ordinal.

The body still says “Two blocking issues remain” in the verdict section.
Consequently `normalizeEffectiveReviewVerdict` returns `request-changes`, while
`parseReviewFindings` marks the empty blocking section unknown with
`verdict-inconsistent`. This independent fail-closed classifier remains intact.
It does not cause the earlier `review-evidence-invalid` return.

`test/hamrevwitness-01.test.mjs` calls the real CLI `main` with an isolated plan
file, frozen review reader and policy reader, and forbidden mutation callbacks.
The controller pin is the dispatched candidate SHA. An omitted plan head fills
from that pin and fails with `review-head-mismatch`; explicitly supplying the
candidate fails identically. Explicitly supplying the review SHA succeeds.
Both environment and command-line pin routes are exercised. Input files remain
byte-identical.

All six advisory findings authorize reviewed coordinates under strict
remediation policy. Non-strict policy defers author-line changes. Out-of-range
edits require correction; invalid kinds, ordinals and absent finding bodies stop.
These are pre-edit results, not a merge authorization or certification that
#10491's outstanding findings were remediated.

## Change and safety boundary

The CLI and checker now emit one first-failure code with the existing terminal
action, reason and exit code. The finite typed codes disclose no submitted SHA,
login, state, path or body. Missing pins still stop before any plan or review
read. Missing reviews, malformed plan/head evidence, mismatched heads,
untrusted reviewers and invalid review states cannot grant edits.

The change neither substitutes candidate heads for reviewed heads nor infers
authority from review text. Final merge provenance, ancestry, supersession,
coverage and exact-head validation remain in their existing owners. No queue,
runtime or review record, PR #10491, or production service was changed. LAC-2178
retains ownership of the independent hosted Linux lock-race failure.

The initial earned-scar search returned no records. A second search for the
narrowed cross-head witness pattern failed with `hcp_unreachable` (timeout);
that evidence was unavailable. Local runbook and sibling primary-change /
review-authority predicates were inspected; their final-merge responsibilities
were preserved.

## Verification

All commands run through the bounded `cwp_dispatch.worker_validation` runner.

- Targeted edit-plan and exact-review fixture suites: 18 passed.
- `npm run lint`: passed, zero errors (152 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- `npm test`: reached the 900-second limit, with 19,150 passed, zero failed,
  four cancelled and 11 skipped. The cancelled files were untouched:
  `ama-hammer-retry-cap`, `watcher-claim-loop`,
  `watcher-reviewer-timeout-handoff`, and `argus-backlog-retirement`.
  Each reported a pending promise after its event loop resolved; the runner
  then reported `ETIMEDOUT`. This broad run is not green. No second broad run
  was made; scoped tests above verify the changed behavior.
