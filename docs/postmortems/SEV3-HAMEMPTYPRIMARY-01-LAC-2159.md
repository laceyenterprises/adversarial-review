# SEV3 — conflict-only HAM rewrite loses the reviewed author boundary

Tracking: LAC-2159 / HAMEMPTYPRIMARY-01. Status: source repair; deployment and
organic acceptance pending. Impact: closure liveness loss; the primary-change
gate refused merge. No evidence of a merge-gate bypass.

## Incident evidence

The dispatch reports adversarial-review PR #1723: comment-only review with no
findings on `e09a7ffa97814e7728ac393fe820353020e2c070`, followed by the single
HAM-classified commit `33699374b3b36b5d5edf129c44786c25cffe58a5`. Both Node
jobs succeeded on the replacement and GitHub reported it mergeable. The
deployed checker refused `primary-change-unknown`, detail `empty primary
change`: `primaryHead` and `mergeBase` were both
`2c53409a7663e1414e5641fdf91f2dd75d4d58a3`; `primaryFiles` was empty and
`post-merge-verify.json` remained in `finalFiles`. Independent inspection
reported the same sole substitution around SEVDOCS-335 in both commits.
HAM reported no merge attempt and lease release.

These are supplied observations, not fresh live probes. This repair neither
reads nor operates on that PR's branch, credentials, leases or production state.

## Source cause and related repairs

`fetchPrimaryChangeHistory` deliberately protects the first HAM commit's first
parent. That includes all author commits still in current history. When a
conflict-only rewrite relabels/collapses the author commit as HAM directly above
main, this parent is main itself. Comparing main to that parent yields no
primary patch. Surviving text and successful CI cannot recover the lost
authorship boundary. The checker correctly fails closed.

The conflict procedure instructed intent preservation but had no executable
proof that its replay retained author messages/identity before publication.
The offline fixture produces a real adjacent-context Git rebase conflict,
resolves it, then demonstrates that amending only its message to HAM reproduces
the empty-primary refusal despite identical trees.
The supplied evidence identifies the resulting history shape, not the exact
live rewrite command. This RCA does not attribute an unretained amend or squash
invocation to the incident worker.

LAC-2134 (`a27ed013`) concerns reviewed-parent comparisons for *authorized
reversals*. Current source still requires authenticated finding/citation and
patch evidence. A no-finding review supplies no reversal authorization.
`primaryChangeExactReviewEvidence` also handles missing reversal citations,
not an empty primary range. Neither is an appropriate fallback here.

`fetchHammerHeadRange` also has an existing authenticated branch-activity
route: exact head repository/ref, a complete contiguous before/after chain,
trusted fleet actors and verified commit identities. That route can establish
review currency across a rewrite; it does not reconstruct the missing primary
patch or waive `checkPrimaryChange`. Preserve that range route, rather than
turning its identity proof into a new empty-primary authorization.

LAC-2097's [recurrence RCA](LAC-2097-closer-convergence-recurrence.md) requires
preserving eligible exact heads through unrelated base advances and refreshing
validation on real rewrites. It does not authorize converting author source
into HAM source. Its base policy, retry bounds and provenance remain unchanged.

## Repair and boundaries

Appendix D now captures the local source and fetched base immediately before
rebase. When the source equals the immutable dispatch reviewed head, a bounded
local proof runs before publication. Replay must be a linear one-to-one series
above the captured base, preserving each original author name/email/message.
The first original commit must be an identifiable non-HAM primary. Exact ordered
text additions/removals, path headers and mode headers must match per commit.
Only index blob hashes, hunk coordinates and surrounding base context are
excluded. Whitespace and changed bytes are not normalized.

Use ordinary Git rebase, retaining the author commits, and put actual subsequent
HAM work in separate commits. Never amend/squash the primary into HAM. Unknown,
opaque/binary, empty or unavailable patch evidence, changed content, nonlinear
history, lost commits or reclassification stops this conflict-only procedure
before publication. This proof deliberately does not accept general semantic
conflict resolution, generated-output changes or remediation as patch-equivalent;
those need the existing remediation/full-range validation path. A source head
already changed by remediation retains that existing path.

The proof is local publication evidence, not a review carry-forward receipt or
merge authorization. No trusted anchor is accepted from a commit trailer.
Existing source-ref CAS, branch lineage, all-findings strictness, required
checks, CI-cost mode, primary-preservation evaluator, lease custody and
authenticated audit/range checks remain independent and fail closed. No
configuration, CI job, trigger, runtime service or persistent store changes.

## Source validation versus activation

`test/conflict-primary.test.mjs` covers a real resolved Git conflict, identical
text reclassified HAM, actual reversal, an anchor differing from the dispatch
head, and missing/unreadable patch evidence. Existing rebase, publication,
primary-change, closer and prompt suites remain regression references.

Source validation results are recorded in the repair PR. A passing offline
fixture or merged source does not establish deployment or recovery of #1723.

After ordinary review, CI, merge and deployment, the deployment owner should
observe a naturally occurring conflict-only replay retaining a distinct author
primary, its exact published head, fresh required checks, authenticated audit
range, primary-change verdict and matching lease release/normal merge outcome.
Retain deployed source identity with those observations. Do not manufacture
traffic, rewrite the incident branch, clear leases or request production
credentials for acceptance. Until that organic evidence exists, runtime
acceptance remains pending under LAC-2159.

## Historical evidence searched

HCP symptom search returned identity/merge-governance scars: identity is not
authorization, and producer provenance should be repaired without weakening
consumers. A subsequent conflict-publication/empty-primary search was available
and returned no records. Injected terminal-PR, strict finding and custody scars
remain applicable. Sibling API publication already refuses rebased ancestry and
retains the CAS Git route; no duplicate merge classifier or evidence bypass
was introduced.
