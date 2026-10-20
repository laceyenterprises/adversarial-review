# LAC-2072: owner-proof contract drift blocked ORPHANACTION-01 CI

On 2026-10-20, [PR #1405](https://github.com/laceyenterprises/adversarial-review/pull/1405)
remained open because both full-suite Node 22/26 lanes failed at
`7e71fc4f84d100c2beec6193568fe24690a20612` in
[Actions run 39406499219](https://github.com/laceyenterprises/adversarial-review/actions/runs/39406499219).
This is the SEV3 repair for [LAC-2072](https://linear.app/laceyenterprises/issue/LAC-2072).

## Evidence and cause

Both downloaded CI job logs (Node 22 job `118573591862`, Node 26 job
`118573591650`) identify the same four failing cases in
`test/watcher-ama-live-review-retry.test.mjs`, originally at lines
83/118/157/192. Each complete-result deep equality omitted
`ownerProofFacts.reviewCycleExhausted: false` and
`ownerProofFacts.commentOnlyFinalRoundCompleted: false`.
Each lane reported 11,459 tests: 11,407 passed, four failed and 48 skipped.
The focused offline reproduction on that unchanged head passed the reviewer
alias case and failed these four cases with exactly those additional fields.

ORPHANACTION-01 added both fields to the real producer in
`src/ama-closure-orchestration.mjs`. Its consumer in
`src/ama/orphan-watchdog.mjs` uses strict boolean terminal facts to choose
hammer dispatch when another review is already closed. The producer correctly
emits explicit false values on ordinary heads, including after live-review
lookup retries fail. The four older full-result assertions had not been
updated with that additive contract.

The prior remediation comment records 66 passing `remorphan-01` tests and
explicitly says the full local suite was not run. That suite injects
`ownerProofFacts` into recovery and exercises the consumer; it does not call
the watcher producer or compare its complete result. Its green result could
therefore coexist with these four failing dependent assertions. Lint,
typechecking and the research-domain demo also do not compare this runtime
object. The managed slow test step had been deferred to CI, which caught the
drift. CI protected the merge boundary; remorphan-only validation was
insufficient evidence for the shared watcher contract.

## Repair and boundaries

All four sibling assertions now include both false fields, retaining complete
result equality, canonical Gemini/Codex routing, authoritative Request changes
precedence, bounded retry counts and the empty-verdict fail-closed result.
A producer matrix covers all four true/false combinations independently.
Consumer regressions cover all combinations, absent facts and string values:
a stale Comment-only review with false, absent or non-boolean facts still
requests review of the current head; either strict true terminal fact selects
the hammer. A refused closer remains refused even with terminal facts.

Production routing and merge code are unchanged. The existing holdReason
normalization, explicit-reason precedence, durable refunded/spent evidence,
and optional ledger-summary guard from `7e71fc4` remain intact. The tests use
synthetic roots and injected transports through the repository offline runner.
No CI job, trigger, gate, config key or loader schema is added. Existing
current-head verdict/provenance checks, strict finding remediation, live
ownership fences, lease/CAS protection and retry budgets remain authoritative;
terminal routing facts grant no merge authority.

Before editing, read-only inspection found no matching closer lease,
closer/merge-agent dispatch record or pending/in-progress remediation job at
the deployed review root. The prior remediation job was completed with
`reReview.suppressed: comment-only-final-round`; worker enumeration showed
this LAC-2072 rescue as the only matching provisioned worker. These are
point-in-time observations, rechecked before publication. HCP memory searches
for the symptom and dependent contract returned available with no matches;
the local follow-up/AMA runbooks and registered contract context supplied the
safety constraints. No live service, deploy tree, quota pin or review database
was mutated. Publication updates the existing PR branch and leaves merging
to closure after exact-head required CI is green, without another review
request solely for the Comment-only remediation.

## Validation

- Eight focused watcher/orphan/final-round suites passed: 161 tests, no
  failures or skips, including both changed suites and final-close recovery.
- The initial nine-suite run reached its 180-second bound in the unchanged
  `watcher-claim-loop` suite and reported `kill EPERM` during cleanup. That
  bounded attempt was followed by a separate 600-second-bounded run: all
  125 claim-loop tests passed in 456 seconds. Total focused coverage is
  286 passing tests, no failures or skips.
- Repository lint passed with zero errors and 147 existing warnings;
  changed-test ESLint (including its fix pass), contract typechecking and
  the offline byte-equivalence demo passed. No formatter script is configured.
- Full offline `npm test` passed on Node 26.10.0: 11,467 tests,
  11,461 passed, zero failures/cancellations, six skipped; runner duration
  809.49 seconds (835.00 seconds including the bounded wrapper).
- `git diff --check` passed. Required exact-head GitHub CI remains the merge
  gate after publication; no local result substitutes for that gate.

## Subsequent watcher profiling failure

The later remediation head `3dda4563b5813499a97e8c2d7a01f21ca3025aee`
failed both Node lanes in
[run 39431624502](https://github.com/laceyenterprises/adversarial-review/actions/runs/39431624502).
Both failures were the existing posted-review profiling assertion in
`test/watcher-closure-latency.test.mjs`: six adapter calls instead of four.
This was a separate fixture contract drift, not another owner-proof failure.
The synthetic adapter in `test/helpers/posted-review-profile.mjs` identified
every unsupported command as `read`, while the client caches unsupported
capabilities by the concrete invoked command. Returning `requested: args[0]`
restores the fixture's contract and the original four-call assertion.

Hammer reproduced and repaired that failure without changing production
routing or weakening the assertion. During closure,
[PR #1408](https://github.com/laceyenterprises/adversarial-review/pull/1408)
landed the same repair on `main` at
`4d86210ae1207b1d28170039fc6cf7d5c0c1334d`. The conflict rebase preserves
that repair and its explanatory comments, dropping the duplicate fixture
commit. The explicit hold-reason precedence fix and both directions of its
classifier coverage remain in this PR. Full-suite validation of any earlier
head does not certify this rebased head; its required GitHub checks must pass
before merge.
