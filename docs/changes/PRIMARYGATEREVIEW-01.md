# PRIMARYGATEREVIEW-01

## Summary

Recognize normalized cross-file moves of protected author code. For an attributable reversal that lacks authorization, request one exact-head review with the reverted regions and removal commits. A clean contextual review supplies verified authorization. A blocking review enters remediation, and a further unverified reversal on the same head follows operator recovery.

## Interface changes

The reviewer prompt can include a **Reverted primary-change regions** section. Merge audit evidence can include a verified `Reversal-Authorized-By` record with the review ID, head and reviewed regions. The existing explicit review-intent store accepts nullable context for this request.

## Verification

Synthetic replay covers moves, lane-provenance failures, silent reverts, one request per head and previously verified citations. Run `node test/run-tests.mjs test/primary-gate-review.test.mjs test/finalclose-01.test.mjs test/lanereversal-01.test.mjs` offline.

Remediation verifies that the prompt uses the reviewed head even when live PR metadata advances. Closer receipt reads reuse the caller's review-state connection when available. The offline replay covers both connection paths and verifies that the caller's connection remains open.

Receipt verification can load independently of review scheduling. The closer only builds review context for full commit SHAs, and scoped history reads expand destination patches only when the protected change contains a possible cross-file insertion. Offline validation covers standalone merge imports, closure receipt reads, and the scoped history budget. The state-machine source projections cover the existing review and closure transitions used by this handoff.

The offline GitHub lifecycle fixture mirrors the new review-state export so the watcher can load in the lifecycle tests. The fixture rejects any attempt to queue a primary reversal review from those tests. Run `node test/run-tests.mjs test/github-api.test.mjs` to replay the affected tests. Lint reported zero errors, the contract typecheck passed, the walkthrough produced three byte-stable deliveries, and the data-model validator checked 104 catalog entries.
Targeted Hammer validation passed all 283 tests across `test/github-api.test.mjs`, `test/primary-gate-review.test.mjs`, and `test/watcher-claim-loop.test.mjs`.
