# LAC-2202 — Git's conflict footer hid hammer provenance after rebase

Status: source repair with offline regressions; organic recovery unverified.
Contract: `merge.finding-remediation-and-authoritative-terminal`.
Regression refs: `test/lac-2202.test.mjs`,
`test/primary-change-reversal-rebase.test.mjs`,
`test/lanereversal-01.test.mjs`.

## Read-only incident evidence

On 2026-11-16 the deployed `bin/primary-change-context.mjs` diagnostic for
`laceyenterprises/agent-os#10916` at
`79a15c6ea614f37fa2e65ab5616a88b2a6f82b12` returned
`hasHammerCommits: null` and
`untagged hammer launch is outside builder history`.

GitHub commit metadata and the existing dispatch receipt establish:

| Role | SHA |
| --- | --- |
| Reviewed author / original launch | `a30457bdc18d16eb2824bda8561f9cc7718fe058` |
| Original hammer publication | `38136e89c71ac4f8096613424d8bc73d9e71929c` |
| Rebased author | `d41c80eb9cb2649b5cf109fe8e1368ef785aac90` |
| Rebased hammer | `79a15c6ea614f37fa2e65ab5616a88b2a6f82b12` |
| Rebased base | `d9f952c5512804940ce3ee44ddbbe48c034dad05` |

The original review was COMMENTED with four non-blocking findings. The
published final remediation comment reports all four addressed, successful
canonical validation and eight successful exact-head checks, followed by the
primary-change refusal and lease release. Those validation statements are
the published worker's evidence, not an independent replay of CI here.

The current commits were captured into
`test/fixtures/lac-2202/rebased-commits.json` using GitHub's commit metadata.
Both the hammer author and committer resolve to the existing hammer App
identity. The commit contains Worker-Class, Worker-Ticket, Reviewed-Head,
Closed-By and three reversal citations, followed by:

```text
; Conflicts:
;	docs/RUNBOOK-codex-invocation-contracts.md
```

## Cause and comparison

`parseCommitTrailerValues` scans backward and stops at the first non-trailer
line. The conflict path therefore produced an empty trailer set. Primary-change
classification treated the hammer as untagged and required the original
launch SHA within current builder history. Rebasing had rewritten that SHA.
The refusal was conservative but lost supported provenance that was still
present in immutable commit metadata.

[LAC-2141 / agent-os#10120](https://github.com/laceyenterprises/agent-os/pull/10120)
corrected the native salvage producer to emit canonical class/ticket trailers
without claiming finished remediation. It left the consumer unchanged. This
incident has canonical trailers already; fixing salvage cannot recover them.

PRIMARYCHG-01 removed stale no-op launches as an unconditional baseline and
protects the actual first hammer parent's complete primary patch. That
contract remains: recognizing the current tagged hammer selects the rebased
author parent. An old launch record, valid CI, or a published comment alone
cannot establish a replacement primary baseline or waive a reversal.

## Repair and limits

Recognize only the standard terminal Git conflict suffix for `#` and `;`,
then run the existing parser over the preceding message. Repeated citations
survive and conflicting identity claims still disqualify provenance. Arbitrary
prose, mixed markers, missing paths and truly untagged out-of-history launches
retain conservative behavior. No generic trailer search or author-login-only
recovery was added.

The shared parser also feeds reversal and publication consumers. Existing
HAMINTENT, rebase and lane reversal suites exercise those sibling sites; the
new immutable-original reversal case specifically changes the current
message's footer and still rejects changed patch content. Completed history
cache identity advances to v8 so old boolean classifications cannot survive
the parser contract change. Partial object checkpoints retain their raw
messages and require no rewrite.

HCP memory searches for the initial symptom, the conflict-footer cause and
cache invalidation completed with no returned records. The injected contract history,
PRIMARYCHG-01 incident report and LAC-2141 PR supplied historical context.
HCP launch-identity reads timed out; no absence inference was made from them.

Production audits, dispatch receipts, leases and branches were not rewritten.
Ordinary reviewed deployment and subsequent gate evaluation own recovery.
The offline fixture uses real commit metadata with synthetic patches and an
isolated launch record; it does not certify the incident's full final tree or
independent reversal authorizations.

## Recurrence on Agent OS #11143

The deployed checkout at `38e32ad6` has #1906 (`c494b0c7`) in its ancestry.
The recorded diagnostic and a fresh read through the native history reader
both report `primary-change-unknown` at `72250e9c`. The native collector
selects the earliest receipt in the persisted PR-scoped dispatch records.

| History point | Git object |
| --- | --- |
| Initial authoritative Gemini review (CLI builder-boundary fallback) | `2367f0151fe85433badb86001d30f6487618bafc` |
| Earliest persisted HAM dispatch, at 12:03:40 UTC | `f4c06bc7927dfa7b532a3592e21cca8a6bfb8e79` |
| First HAM publication, parented by that launch, with no conflict footer | `63cd3e5c5e7cdd28a156b33d700f7e0b75441ee0` |
| Same HAM subject and trailers at the next recorded launch head, after one conflict footer | `13b93672938ff6a89ebe970612951c43784edd2f` |
| Builder remediation and actual first HAM parent in the latest comparison | `19aa526cb45eab79ec61a96a86e90bbe1536c77c` |
| First HAM commit in the latest comparison, after two conflict footers | `89dfa3f394682d6a85d1cf448586b7a184932398` |
| Incident head | `72250e9cd3026fe33f56626786743bbff6e3900c` |

The historical dispatch is diverged from the CLI builder boundary and absent
from the latest comparison. Both later dispatch receipts also refer to earlier
heads. The first current HAM commit has a linked HAM author and committer and
still carries the original `Worker-Class`, `Worker-Ticket`, `Reviewed-Head`
and `Closed-By` trailers. The last rebase appended a second footer for
`projects/worker-pool/SPEC.md`; removing only the last footer left the first
blocking trailer parsing. Using a later launch would not recover that evidence
and would risk moving the protected boundary past earlier closure work.

On the same live inputs, the updated native classification returns
`hasHammerCommits: true`. The full native CLI replay, with scratch-only state
and copies of the actual launch receipts, selects `19aa526c`, reads 29 primary
paths, and returns `ok: true` from the strict primary-change predicate. The
offline comparison fixture also tests refusal for a missing primary patch
and when the first HAM commit lacks supported metadata. Subsequent recovery
requires reviewed source rollout and the ordinary exact-head closure checks.
The scoped HCP memory retry timed out. This investigation used the prior RCA,
the closure runbook and the native GitHub and dispatch evidence above.
