# PRIMARYGATEREVIEW-01

## Summary

Recognize normalized cross-file moves of protected author code. For an attributable reversal that lacks authorization, request one exact-head review with the reverted regions and removal commits. A clean contextual review supplies verified authorization. A blocking review enters remediation, and a further unverified reversal on the same head follows operator recovery.

## Interface changes

The reviewer prompt can include a **Reverted primary-change regions** section. Merge audit evidence can include a verified `Reversal-Authorized-By` record with the review ID, head and reviewed regions. The existing explicit review-intent store accepts nullable context for this request.

## Verification

Synthetic replay covers moves, lane-provenance failures, silent reverts, one request per head and previously verified citations. Run `node test/run-tests.mjs test/primary-gate-review.test.mjs test/finalclose-01.test.mjs test/lanereversal-01.test.mjs` offline.
