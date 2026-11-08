# SEV2 source RCA: late review escaped terminal audit (LAC-2162)

**Impact:** lacey-projects #54 merged with an outstanding non-blocking artwork
finding; the changed eyebrow color remained. Severity describes a merge-gate
failure with a visible product defect. This is an offline source RCA, not a
runtime inspection or a claim of deployed recovery.

**Provided timeline (UTC):**

| Time | Evidence |
| --- | --- |
| 01:27:18 | Terminal audit cited `PRR_kwDORuLkis8AAAABWptG8A`, reviewed head prefix `a757cb4904c5`, zero findings. |
| 01:32:13 | Review `PRR_kwDORuLkis8AAAABWqhqTA` on validated head `54c42505f6244bb789a6694437112ea262a9ce18` added the artwork finding. |
| 01:52:15 | Hammer merged that exact head without accounting for the finding. |

**Root cause:** both selection and final proof matching had gaps.
`bin/ama-check.mjs::buildReviewState` selected the latest routed-family review
only on `--reviewed-sha`, retaining the dispatch head even when a newer
applicable review existed on the validated head. Its findings could therefore
remain known-zero. Separately, `bin/hammer-merge.sh`'s final live gate supplied
`verdict: 'settled-success'` and `leaseHeld: true` after the upstream predicate,
and fetched no reviews. A same-head new review could not invalidate that
predicate. `--match-head-commit` fenced source movement but could not detect
changed review evidence. A matching authenticated head audit and valid range
proved content validation, not that a later review's findings were considered.

**Offline reproduction:** the new `ama-check` regression against the CLI and
eligibility module from `ffeb1d5244dbc00de51c57a94d81f6eb4f5f5de0` fails because the result
remains eligible after adding the exact-head non-blocking finding. Synthetic
fixtures preserve the provided review IDs, times and exact validated SHA; the
unknown suffix of the old SHA is padded, and review prose is synthetic.
The final-gate replay executes the production embedded JavaScript with only
I/O stubbed. Green checks, a matching head and the existing lease still refuse
the late review after the fix.

**Correction:** select current routed-family findings through
`latestAuthoritativeReviewInAncestry`. Reuse that selector per authoritative
family to compare applicable review head/body at authenticated audit publication
with current evidence. Changed evidence invalidates terminal authority in the
initial predicate, the hammer's final gate and daemon audit reuse. Distinct
families cannot erase each other's findings. Repeated identical same-head
bodies retain proof; inapplicable reviews retain canonical rules. Unknown
ancestry or missing evidence grants no authority. Existing finding coverage,
merge predicates, CI classification and lease fencing remain in force.

**Regression coverage:** `test/hamlateaudit-01.test.mjs`,
`test/ama-check.test.mjs`, `test/ama-daemon-merge.test.mjs`, and
`test/daemon-ham-terminal-remediation-remerge.test.mjs` cover the late finding,
same-count changed detail, identical repeat, untrusted/pending/discarded-branch
reviews, independent families, unknown evidence, current finding selection,
the final gate and daemon lease release without merge.

No merged PR, artwork, runtime audit, review store or lease was changed. This
source PR adds no review request, merge authority, configuration or CI job.
