# LAC-2097 recurrence: separate base churn, protection reads and real repairs

Source recurrence fix for normal cross-model review. No deployment or live queue
recovery is claimed. The [original RCA](LAC-2097-validated-closer-convergence.md)
remains the account of the October 24 incident and #1481.

## What the October 27 evidence establishes

Read the reopened Linear issue and its 03:07/03:11 UTC comments, together with
`/private/tmp/os-rescue-20261027-014549`. Its `deploy-source-final.json` records
parent `76d8fe5369d8c403402ac420a4bd232ef296d050` and adversarial-review
`aa02642009cebf1846ab72db287f60c62a4d42b3`. The provisioned dispatch baseline
and the read-only deployed checkout initially both have that review revision;
#1481's merge `ad6019ff23028ea83fb8cac7d163760fc14e3361` is an ancestor.
This establishes source ancestry, not loaded-process identity.

| Evidence | Supported conclusion | Limit |
| --- | --- | --- |
| `9474-native-logs.log`, completed item 31 | The copied `ham_base_touches_pr_files` function equals the dispatch baseline byte for byte, including #1481's non-strict disjoint exception. SHA-256 of that function: `df86aa87bbcc43324639fbcca8d5dfe6df52c114e9f2b580ce17729188eceadb`. | Whole copied scripts have been cleaned; snippets do not identify every byte or the loaded daemon. |
| Same log, items 45–48 | 544 local passes and exact-head green/eligible `016e5208` preceded lease reacquisition and a rebase to `d7edae53`. | Neither greenness nor CLEAN proves a disjoint base. |
| Retained #9477/#9478 prompt files | Both reference the deployed renderer and contain the strictness/overlap contract. Their prompt SHA-256 values are `f3641d496a49b128c416bd72415f983975bf89e91f8e73cb1da20ba242b0ed1f` and `e07eeb1ad07ab8e706c4337efb1da72dad6861a7320c077e35360c2a51bc61ec`. | These are instructions, not retained rendered helper bytes. Do not label them an older helper generation. |
| `agent-os-9452/merge-current.log` | Its 300-second wait expired behind PR #9478, lease `ml_4619506f-024a-40fb-91f2-f96eacd9c50a`, acquired 02:48:35.402Z. | The log does not identify which operation consumed all holder time. `agent-os-9448/merge-owned-final.log` is empty, not a second independent holder trace. |

Read-only GitHub commit/compare reads further distinguish the events:

- [#9474](https://github.com/laceyenterprises/agent-os/pull/9474): the fork is
  `a4aadcf7303568f0fe6efa4b42af342e573bc457`; the retry rebased onto
  `907da203089ba104102def6f561ba72691d507f0`. The base advance intersects
  the PR in worker-pool source/tests, README, walkthrough, state/smoke declarations
  and its postmortem. It includes the same `state-machines.json` and
  `post-merge-verify.json` regions and both sides add `test_transient429.py`.
  This is not a disjoint-path counterexample to #1481. Patch-equivalent output
  does not make the old head valid under the existing overlap rule.
- [#9477](https://github.com/laceyenterprises/agent-os/pull/9477): pushed edges
  `5bbc6526 -> e3b91f51 -> 8ba4f1a8` are retained. The last head's parent is
  `44faf9b0e476b06b6453131b7cc824a8f5452a25`. Its retained snapshot documents
  earlier documentation conflicts and changed-surface revalidation. Comparing the
  old head with the new base gives fork `0d13802c6ebb935cc98fe4b320565b1db446e0b5`
  and overlap in 13 paths, including `decision_recovery.py`, `dispatch.py`,
  their tests, README, walkthrough, state/smoke declarations and SPEC. It also
  is not a disjoint-path counterexample. A new
  pushed-edge comment alone cannot determine which strictness read selected it.
- [#9478](https://github.com/laceyenterprises/agent-os/commit/e89a6cac18157fcb9b7e77f353519a1af736b9d1):
  `e89a6cac` has **parent `f79be81d`**, changes only
  `modules/main-catchup/tests/test_deploy_dirt_provenance.py`, and repairs event
  selection in the shared incident log. It is an ordinary remediation commit,
  not a base-only rebase. The rescue description's interpretation of this edge
  is not supported by the actual commit. No main-catchup tests were run here.

## Reproduced remaining mechanisms

At approximately 05:30–05:38 UTC on October 27, bounded read-only requests using
both the worker identity and the managed Hammer identity returned HTTP 403,
`Resource not accessible by integration`, from
`branches/main/protection/required_status_checks`. The same Hammer identity
successfully read `branches/main`: `name:main`, `protected:false`, commit
`d27e31ffd68597317dc458dceb3aa5dc44f236ec`. A separate GraphQL read returned
`branchProtectionRule:null`; the rules endpoint refused with the plan-level 403.
No credential was printed or changed. These observations establish current
unprotected branch metadata, **not incident-time strictness**. The rescue did
not retain all three closers' strictness responses; assigning every rewrite to
403 would overstate the evidence.

The helper interpreted an unreadable administration endpoint as strict. With
that identity it therefore imposed complete containment even on an unprotected,
disjoint branch. GitHub documents branch metadata protection as covering branch
protections or rulesets in its [branches API](https://docs.github.com/en/rest/branches/branches).
The correction accepts only a successful, identity-bound branch read with a
matching name, full commit SHA and boolean `protected:false`. Protected or
unreadable metadata stays conservative. This changes base-update selection,
not required-check classification, branch-protection enforcement or eligibility.
Malformed successful strictness responses also stay conservative, including
string `"false"`. Raw response/error files remain available in the run directory.

A second source rule unnecessarily required an initial update attempt before
using #1481's retention policy. A lagging BEHIND snapshot could therefore issue
an avoidable CAS even when the exact head already contained the base, or when
non-strict disjoint advancement permitted retaining it. First verification now
uses the same conservative policy as post-wait and final-click verification.
Overlapping paths, including separated hunks, still require rebase/revalidation;
there is no new CLEAN, patch-ID, generated-file or hunk-equivalence exemption.

Finally, the serialized retry previously kept the lane for the full remaining
load-scaled CI window. It now shortens that deadline to at most **120 wall-clock
seconds of retry CI after the rebase settles**. Expiry uses existing pending-head
recovery and releases the exact lease; it does not erase the published head,
repeat the mutation or turn pending checks green. Existing bounded Git/API and
publication operations are additional time, so this is not a claim of a
120-second total critical section or a new cancellation supervisor. Prompt
instructions require optional local validation outside the lease, followed by
verify-head reacquisition and fresh head/base checks before audit publication.

Copied phases now include a source SHA-256 comment to make the next generation
comparison direct. The hash is diagnostic metadata, not a signed proof or merge
permission. Existing running/copied files are never rewritten by this change.

## Convergence and preserved authority

For a finite ready queue and cooperating base writers, non-strict disjoint heads
retain their original source refs and CI and drain in FIFO order. Strict or
path-overlapping heads perform at most one in-run retry rebase; if exact-head CI
finishes inside the shortened window they rebuild range, findings audit and
full predicate authority before normal merge. If it does not, the run terminates
and releases with durable pending-head recovery rather than monopolizing the
lane. No policy can guarantee a merge while required CI remains pending forever
or independent writers continuously invalidate a strict head. These cases have
bounded attempts and waits, not fabricated convergence. A subsequent strict
base change can legitimately require another rebase; this PR does not waive it.

Current-head required checks, source finding dispositions, security verdicts,
primary-change proof, ordered rebase-result proof, head CAS and normal GitHub
merge protection remain independent gates. Async acknowledgements still poll
without a second mutation; only proven publication receives provenance. Tests
refuse old-head green evidence for a rewritten head. No CI rules, config keys,
leases, store shapes, services, flags, live queue rows or active rescue branches
change. No paid validation or admin merge is used.

HOLDERPROOF-01 [#1559](https://github.com/laceyenterprises/adversarial-review/pull/1559)
is merged as `f48a4bd9f25f1b191a6139c9aca4aebf4204a97a`. Its branch-rewrite
receipt writer and recovery contract remain its owner's work; this PR adds no
competing custody receipt. LAC-2093's bounded validator, controller registration,
launch checks, drain evidence and generation-fenced cleanup remain unchanged.
Regression coverage exercises them; an HQ terminal row is still not a drain
receipt. Source propagation and runtime acceptance are separate from both tickets'
source completion.

The HCP symptom search and follow-up searches for protection-read/overlap scope
were available and returned no records. Injected terminal-PR, remediation and
config-parity scars still apply; no config key or strict loader changes here.
Linear's shared field-note tool returned `get_agent_context not found`; that
history is unavailable, not evidence of no earlier incident. Issue/comments,
retained rescue receipts and local runbooks were readable. Sibling merge gates
and CI classification remain their shared implementations; no duplicate
classifier or custody/cancellation implementation was introduced.

## Offline evidence and deployment acceptance

The queue fixture now also runs two author-plus-HAM PRs editing separated hunks
of the same file, under strict and non-strict protection. Both retain the
conservative required rebase, preserve every author's and HAM's changes, and
finish with no holder or waiters. Existing disjoint queues drain with zero
rewrites; strict queues use one rebase each. Rendered-shell cases cover first-pass
retention, fresh exact-head pending/red checks, async old-head responses,
conflicts, foreign heads, predicate/range refusal, shared and shortened deadlines,
cancellation holds and terminal cleanup. Strictness fixtures cover the actual
403/unprotected response pair and protected, wrong, missing and malformed data.
Final changed-surface evidence: 43 rendered closer scenarios passed; all 86
prompt/protocol/generation checks passed; 40 strictness, replay, queue and deadline
checks passed across the focused runs. The initial focused attempt hit its
300-second outer bound; its test owner and group were later confirmed absent.
The final closer run completed inside the repository runner's own bound. The
first attempts caught a stale-BEHIND fixture assumption and prompt byte/wording
regressions; those were corrected without relaxing assertions. The fixed-size
prompt and no-full-suite/no-polling rules remain tested. Lint has zero errors,
contract types and the byte-equivalence demo pass. Rendered Bash syntax passes;
ShellCheck has exactly the baseline's four diagnostics (three SC2034 warnings
and one SC2016 info); `scripts/test-shellcheck-gate.sh` does not exist in this
repo. The required full `npm test` run reached its internal 900-second bound and
exited 1: 15,002 tests, 14,978 passed, two failed, 13 canceled and nine skipped.
`test/derived-artifacts.test.mjs` failed on `spawnSync ps EPERM`;
`test/finalization-queue-routing.test.mjs` expected `lane-transfer-required` but
received `owner-operation-in-flight` in its three-second lock window. Both test
files and their implementations are unchanged against the fetched main. The
remaining cancellations report pending promises at shutdown. This is an
incomplete red full run, not a green suite claim; no unrelated assertion, skip,
host resource or test routing was changed. The command and its test group have
exited. Managed publication and required hosted CI remain separate evidence.

After normal cross-model review, required CI and ordinary merge, the deployment
owner must separately observe a newly rendered procedure's source hash and
its branch-policy response pair, a naturally occurring disjoint queue retaining
heads, and a strict/overlap retry either merging on fresh evidence within its
short CI window or releasing with its pending receipt. Retain canonical controller
drain and matching lease release evidence on organic cancellation/terminality.
Do not manufacture production PRs, force cancellation, replace copied scripts,
clear live leases, start paid runs or change services/flags for acceptance.
