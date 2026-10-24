# LAC-2101: terminal remediation lacked preservation evidence

On 2026-10-24 the native closers stopped after remediation on agent-os
[#9084](https://github.com/laceyenterprises/agent-os/pull/9084),
[#9097](https://github.com/laceyenterprises/agent-os/pull/9097), and
[#9110](https://github.com/laceyenterprises/agent-os/pull/9110).
The observed impact was stalled delivery, with no demonstrated unsafe merge or
runtime outage. Saved inputs were
`/private/tmp/os-rescue-20261024-1030/{9084,9097,9110}-start.json` and the ticket's
native closeout timestamps. Minimal review excerpts and observed failures are
retained in `test/fixtures/lac-2101-preservation.json`. Tests model protected
patches with synthetic Git objects; they do not claim to replay the complete
native repositories or certify any historical/live merge.

## Causes and policy decisions

**9084, 08:19:14Z:** `primary-change-unknown`, opaque changed
`platform/app-sdk/node/agent-os-app-sdk-0.4.0.tgz`. Review required canonical schema
repair and SDK/package regeneration; saved closeout described parity checks.
Those checks were evidence of intent, not reproducibility authority. The original
package declaration rule intentionally required an unchanged author-head command.
The author head predated that opt-in. Repeating the close could not manufacture
it. This was a missing supported evidence path, not a reason to trust a
closer-authored declaration, a CI status, or archive-content normalization.

The fix supplies owner consent scoped to repo/PR/primary/head/base/path/blob and a
retained authoritative finding, followed by an independent exact-blob rebuild.
Only a fixed offline npm-pack recipe runs, with lifecycle scripts disabled and
no branch generator. This supports the npm archive class without opening an
arbitrary command registry. Sources still pass their own preservation checks.
Receipt-only packing materializes package subtrees, allowing unrelated repository
gitlinks while still refusing symlinks/submodules inside a package. Mixed
receipt/declaration candidates retain whole-tree refusal. It does not register
receipts, mutate queues, or execute any native PR code here.

**9097, 08:55:53Z:** `primary-change-reverted` on
`modules/worker-pool/state-machines.json`. The saved authoritative finding's File
was `modules/worker-pool/post-merge-verify.json`; its Lines was
`3-3; modules/worker-pool/state-machines.json:3-3`. The old matcher compared only
File to the reverted path and parsed a single path's ranges. Thus it could verify
the first JSON repair but reject the second even though the finding explicitly
cited it. Literal brace notation is another representation of the same location
set. This was an implementation gap. The fix carries path/range pairs through
current, rebased and immutable-original authorization using the shared evaluator.
History identity advances to `reversalprov-v4`, so cached failures proving the
original HAM snapshot recompute once without an operator purge. It does not infer authority from prose, transfer ranges between files, enlarge
ranges, or relax HAM identity/content/currency proofs. Advisory findings still
cannot authorize reversals when strict remediation is disabled.

**9110:** saved closeout identified base README lines 3759–3760 outside the cited
reviewed 3762–3765 range, with no merge-base generated-block declaration. The
rescue restored the source paragraph boundary. A generated filename or adjacent
finding cannot authorize uncited prose changes. That refusal was intended policy
at the incident head. Current REVERSALBLANK-01 already ignores pure blank-only
units; this patch does not undo or broaden that policy, and cannot promise that
the syntactic gate detects every Markdown paragraph change.

A separate bounded proof bug was found: generated-block collection compared the
regenerated block but did not compare surrounding bytes. A generator could erode
a paragraph boundary while supplying a valid block proof. Collection now requires
byte-identical surrounding content, including separators and markers. It rejects
proof from such a generator; it does not authorize or repair native README prose.

## Validation and residual scope

Offline fixtures cover the exact secondary citation, brace alternatives,
wrong-file/range/kind/identity/content refusals, unchanged legacy manifests,
owner registration and exact npm archive reproduction, stale or misbound receipts,
foreign/superseded reviews, archive tamper/deletion, command rejection, unsafe
receipt files, strict-policy opt-out, and generator boundary erosion. Existing
line parser cases continue to protect explanatory numbers and diff-line indices.
No config schema, CI topology, merge cap, reviewer loop, dispatch or terminal-PR
policy changed. Hardening memory searches were available and returned no matches;
Linear shared notes were unavailable (tool returned not found).

Residual gaps are explicit: fixing the native state renderer to retain all source
paragraph boundaries requires agent-os scope and is not included. Whole-README
semantic Markdown preservation and non-npm/custom legacy build recipes remain
unsupported by this receipt. Rebased historical reviews whose ancestry cannot be
verified remain refused; historical saved parity logs alone are insufficient.
Native deployment, owner registration and live acceptance are operator follow-up,
not asserted recovery of these three PRs. No live PR edits, queue changes, probes,
service restarts or agent-os workspace changes were performed.

Worker validation on 2026-10-24: lint passed with zero errors (148 existing
warnings); contract typecheck and the offline research-finding byte-equivalence
demo passed. The six preservation/context/rebase/store/generated-index suites
passed, and the final isolated receipt/boundary run passed all 19 cases.
The native OS sandbox is unavailable in this worker; existing sandbox tests
verify fail-closed behavior and skip native execution.

The full `npm test` run is **not green**: at its 900-second bound it reported
14,101 passed, three failed, one cancelled, eight skipped. Failures were the
existing declared-archive proof case under load, the cancellation test's denied
`ps` invocation, and an unrelated PostgreSQL query-plan fixture; the unrelated
hamclose-ownership case was cancelled. Isolated archive positives pass; earlier
saved rescue evidence (`1492-closeout.md`) records the same full-load archive
failure. The `ps` failure and a separate existing clone-error-text assertion were
reproduced against unchanged `origin/main` in this worker. New receipt positives
also hit the short fixture build deadline during concurrent runs; after those
runs ended the complete new-case run passed. These observations do not claim a
green full suite, native sandbox availability, or production recovery.
