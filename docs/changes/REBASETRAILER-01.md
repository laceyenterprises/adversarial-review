# REBASETRAILER-01 — A head produced by a non-closer rebase is classified by who produced the head

## Summary

A non-closer can rebase a closer-touched branch in place, replaying the
closer's commit onto a new base. The replayed tip keeps the closer's author and
its `Closed-By: hammer` trailer, but git writes the rebaser as committer. The
watcher's local-git classifier read only the trailer, so it called the rebased
head closer-authored and suppressed the review refresh (`closer-commit-trailer`).
The hammer retry series used the authenticated attestation proof and called the
same head non-closer. The gate waited on `pending (stale-review-head)`. Nothing
reviewed the head until an operator retriggered by hand.

The rule is now one fact with one classifier:

- **The head commit's producer decides.** `isTerminalCloserCommitIdentity`
  (through `closerCommitReplayedByOtherProducer`) rejects a trailered commit
  when its committer has no linked login and its committer email is neither the
  author's nor a closer's GitHub noreply address. Local git now reads the
  author and committer emails, and so does the remote commit probe. Unknown
  emails keep the earlier rule. `proveCloserOnlyHeadDelta` walks the range with
  the same classifier, so a range containing any non-closer commit is
  non-closer.
- **The hammer series reads the same decision.** `resetHammerSeriesForNonCloserHead`
  takes `headProducer`, which is the shared classifier's result for the live
  head, and refuses with `closer-produced-head` for a head it calls
  closer-produced. If the classifier cannot be read, the cap stays.
- **The gate and the refresh agree.** The watcher shares one memoized classifier
  read per poll between the refresh and the gate. For a posted review on an
  older head whose live head the classifier calls closer-produced, the gate
  reports `pending (closer-produced-head)`: the closer validates the head under
  MSM and no re-review is pending. The gate still never reports success for an
  unreviewed head. A non-closer head keeps `pending (stale-review-head)`, and
  its refresh runs.

## Interface changes

- `head-closer-commit-suppression.mjs`: new export
  `closerCommitReplayedByOtherProducer(commit)`. Locally read commits carry
  `author.email` / `committer.email`. A replayed result carries
  `producer: 'replayed-by-non-closer'`.
- `resetHammerSeriesForNonCloserHead(..., { headProducer })`: new optional input
  and the new refusal reason `closer-produced-head`.
- `projectAdversarialGateStatus` / `pickAdversarialGateStatus`: new optional
  `closerProducedHead` input and the new pending reason `closer-produced-head`.
- No new CI check, gate, ratchet, guard, label or config key.

## Verification

All runs were offline under the netguard environment, each through
`node test/run-tests.mjs <file>`:

- `test/rebasetrailer-01.test.mjs` (new, 6 tests: a real temp-git closer push,
  a non-closer rebase replaying it, a mixed range, the gate, the series reset):
  pass.
- `test/watcher-claim-loop.test.mjs`: 171 pass, including the two new
  REBASETRAILER-01 poll scenarios.
- `test/closerproof-01.test.mjs` (8): pass.
- Other suites, all pass: `head-closer-local-git-daemon-robust` (30),
  `watcher-auto-refresh-stale-posted-review` (47), `adversarial-gate-status`
  (102), `ama-hammer-retry-cap` (281), `noowner-01` (125),
  `closer-authored-stale` (23), `smv` (11), `watcher-fast-merge` (20) and the
  closure-orchestration suites.
- `npm run lint` (0 errors), `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` pass.

The SEV3 report is in agent-os:
`docs/postmortems/SEV3-a-rebased-closer-commit-trailer-suppressed-the-re-review-the-gate-was-waiting-for-2026-11-12.md`.
