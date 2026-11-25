# SEV3 — Source authority refused after completed documentation remediation

On November 24, 2026, the closer deferred validation on Agent OS PR 11584
with green required CI and a passing running-pack result. The source check
returned `primary-change-reverted` at base region 357 of
`platform/app-contract-endpoint/src/app_contract_endpoint/server.py`.
Both advisory citations were rejected as `reviewed-parent-patch-differs`.
[PR 11584](https://github.com/laceyenterprises/agent-os/pull/11584)

## Immutable history

- Gemini review `PRR_kwDOR6Em7c8AAAABaJFvTQ` was submitted at `2026-11-24T23:51:52Z`
  on `7c77d686767a0a8cbc5acd30525f9f94a6fcf870`. It requested a ledger SPEC
  update and reported separate registry executor and Mach ctypes advisories.
- The review's base `84e25c92b8ae6c70129b3d0019e17c42577d9483` advanced to
  `211650411951de079a7215d078a469315a971ded`. The two commit pairs
  `b5246fa20289` → `0bf0a67ef341` and `7c77d686767a` → `3ac6ebc144b8`
  have identical full binary patches.
- Completed final follow-up job
  `laceyenterprises__agent-os-pr-11584-2026-11-24T23-52-00-612Z` records
  `307778d79746e057a95081c5407db5756bfcd8c3` as its worker-published head.
  GitHub force-push event `HRFPE_lADOR6Em7c8AAAABiPoPUc8AAAAIqOxe_w`
  records the review head moving to that exact SHA at `2026-11-24T23:59:17Z`
  under the Codex fleet App. The commit's single parent is `3ac6ebc144b8`.
  Its only changes are `docs/SPEC-session-ledger-control-plane.md` and
  `platform/session-ledger/changes/APPCONTRACTLAT-06.md`. Both paths match
  the validated reply for the blocking SPEC finding. This was a bare local
  follow-up publication. The exact-head produced-attestation lookup returned
  `missing-produced-head-attestation`.
  [Remediation publication](https://github.com/laceyenterprises/agent-os/pull/11584#issuecomment-7148058678)
- Native closer launch `lrq_75bf67cd-8ee4-4a5d-b8fa-07938dfadd9b`, run
  `wrun_ad277ee1-4f86-467f-be55-51666866cf7e`, published
  `693f44f6d8452fe28a83127d9abe5252834b81a5` directly on `307778d79746`.
  Its commit cites both advisories from the original Gemini review.
  [Closer commit](https://github.com/laceyenterprises/agent-os/commit/693f44f6d8452fe28a83127d9abe5252834b81a5)

## Replay and remaining refusal

The before replay used the captured source result and reproduced both
`reviewed-parent-patch-differs` rejections. The after replay used the captured
patches and live read-only GitHub commit, tree, review and timeline evidence,
plus the canonical completed job. It verified both documentation paths and
reached the original finding-coverage check. The shared gate still returned
`primary-change-reverted` for the same region, now with
`not-covered-by-cited-finding`.

Gemini cited reviewed line 377, the executor declaration. The protected
insertion includes reviewed lines 374–376, which are the preceding comments.
The closer removed all four lines at that location and rewrote the comment
block beside the instance-level declaration. The citation covers only one
of the four removed lines. The patch data comes from
`11584-final-native-source-result.json` and `11584-closer-final.diff.json`.
`11584-current-full-pr.json` records the current head, review and check context.

LAC-2355 supplies the parent proof and preserves the full-span coverage check.
The incident remains open pending actual source authority and merge. This
implementation did not change PR 11584, request review, deploy, or change
the separate LAC-2354 review-currency work.
[Source contract](../RUNBOOK-ama-closure.md#completed-documentation-remediation-between-review-and-ham-lac-2355)
