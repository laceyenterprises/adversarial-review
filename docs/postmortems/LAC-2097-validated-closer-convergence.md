# LAC-2097: validated closers chase unrelated base advances

Status: source fix proposed for ordinary cross-model PR review. Publication and
offline tests do not establish deployment or resolution of the live incident.

## Evidence and impact

The operator captured `/private/tmp/os-rescue-20261024-000725` during
2026-10-24 00:07–00:17 UTC. Its `9048-progress-start.json` shows a validated
closer queued behind another merger and preparing to revalidate after an
unrelated main advance. `9055-progress-start.json` records release for CI,
reacquisition contention, six addressed findings and preserved author/HAM
patches. `9058-progress-start.json` records a successful server rebase returning
the old head, subsequent patch-equivalence proof, exact-head green CI and another
base-containment wait. `1474-progress-start.json` independently records repeated
patch-equivalent rebases and the same asynchronous response race in this repo.
These are captured observations, not evidence that every base advance was
disjoint or that every affected repository had non-strict protection.

The three older core closers were canceled canonically before operator takeover;
`terminal-owner-proof.json` records that boundary. `published-source-inspection.json`
records the operator's source checks. This implementation reads that evidence
only. It does not change rescue owners, production leases, queue/store state,
other PRs, service configuration or provider/role selection.

## Root cause

Three interacting causes are supported by the captured evidence and source:

1. LEASEFAIR-01 deliberately releases the shared lane during the first CI wait
   and reacquires through daemon priority/FIFO. That allows other valid work to
   advance main. It is necessary fairness, not a lease failure.
2. `ham_base_touches_pr_files validated-head` deliberately required the complete
   fetched base in the exact validated head, regardless of file overlap or
   protection strictness. Initial verification, post-wait retry selection and
   the final merge-click boundary all used that mode. The separate live GitHub
   gate already allowed non-strict MERGEABLE/BEHIND heads, so a green eligibility
   decision could still cause an unnecessary source rewrite and CI restart.
   The prompt and runbooks explicitly reinforced the stronger containment rule.
3. `ham_update_branch_with_retries` treated a successful GraphQL mutation's
   `headRefOid` as its completed result. GitHub can return the CAS input head
   while the rebase publishes asynchronously. The next snapshot then looked
   like a foreign push, or repeated BEHIND reads caused another mutation.
   That prematurely escaped LEASEFAIR-02's single serialized retry into another
   worker validation/publication cycle. Strict protection legitimately needs a
   new head after advancement; changing only the overlap conditional cannot fix
   that response race.

A further code-derived edge compounds the loop: queue reacquisition can outlast
the absolute CI deadline, but the old path still started its rebase before the
next wait checked expiry. It could mutate the source and restart CI despite
having no remaining time to validate the result. A deterministic expired-queue
fixture covers this edge; the captured progress files alone do not prove its
frequency in the incident.

No evidence here authorizes carrying old-head CI to a rewritten head, waiving
source findings, disabling strict protection, bypassing CAS or preempting a live
holder. A patch-equivalent series is provenance evidence, not an exact-head test
result.

## Corrected contract

Initial mandatory rebase behavior remains. After that, both verification and
the post-CI/final-click boundaries use one base-policy helper:

| Base/head relationship | Decision |
| --- | --- |
| Current base is contained in the exact head | Retain head; live gates still apply |
| Missing base, explicitly non-strict protection, disjoint paths | Retain head and its exact-head CI |
| GitHub reports CONFLICTING, including directory/file conflicts | Rebase/conflict procedure; never infer safety from disjoint names |
| Overlapping paths, including either side of a rename | Rebase/revalidate, even if GitHub says CLEAN |
| Missing base under strict or unreadable protection | Rebase/revalidate |
| Unreadable fetch/diff/ancestry | Require rebase; no inferred disjointness |

The exact head/base merge-base anchors the post-wait comparison. One required
in-run rebase retains the reacquired lease through fresh CI and rebuilt
audit/range/predicate authority. The existing absolute CI deadline and single
retry bound remain. Reacquisition, overlap probing and pre-mutation base capture
recheck remaining CI patience before a retry mutation; expiry preserves the
previously validated source head and releases. A ready unchanged non-strict
head may still merge after a longer queue wait when the base policy and fresh
live gate pass; no new CI window is needed. Further base movement requiring
rebase refuses; unrelated
non-strict movement does not cause another mutation. Normal GitHub merge still
enforces live protection with `--match-head-commit`; no admin/auto-merge path is
introduced.

Successful update-branch calls are never repeated just to settle visibility.
Snapshot reads use the existing retry cap and 5/10-second backoff. For a known
new mutation result, only that exact SHA is accepted; old snapshots are polled,
and third heads refuse. If the acknowledgement contains the old SHA, a later
candidate must prove complete ordered full-tree replay onto the base fetched
before the CAS. The proof bounds linear series to 256 commits, preserves every
intermediate tree (including author and HAM commits, binary data, whitespace and
modes), and allows no dropped/extra commits or generated-file exceptions.
It only writes Git objects, leaving refs, index and checkout untouched. Missing
objects, conflicts, incompatible Git support or mismatched trees fail closed.
An equivalent arbitrary source alteration cannot inherit the hammer's authority.

Only after proof does the closer attest the pushed edge and synchronize the
exact scratch head. Required checks must run on that head. Fresh publication,
range validation, original findings, primary-change provenance and the full
eligibility predicate remain required. Visibility exhaustion reports
`rebase-head-timeout`; unproven candidates report `rebase-result-unproven`.
Both release the lease. A known mutation-result edge still precedes snapshot or
scratch-sync failures so that recovery retains genuine publication provenance.

## Offline regression evidence

- `test/validated-closer-queue.test.mjs` and the clean sandbox smoke use disposable
  Git repositories and the production lease queue. Two validated author/HAM
  heads queue behind a holder, release/rejoin for CI, and drain across unrelated
  advances before and between merges. Daemon priority still wins between them.
  Both source heads remain unchanged; author intent and HAM repairs survive both
  squash merges; holders and waiters are empty afterward. Strict/unknown policy
  and pending CI refuse the same stale-base head. A second strict queue run
  drains both PRs with exactly one required rebase each; old-head green evidence
  and pending new-head checks refuse before new-head green acceptance.
- `test/hammer-self-rebase.test.mjs` executes rendered verify/publish/merge
  phases against synthetic GitHub boundaries. It covers non-strict disjoint
  retention, strict disjoint and overlapping rebases, one shared CI deadline,
  exact-head pending/red checks, range/predicate failures, foreign head races,
  conflicts, cancellation holds, terminal PRs and lease cleanup. Original blocking
  and non-blocking finding claims survive retry reconstruction. Expired queue
  reacquisition cannot mutate the head or restart CI. Old-head acknowledgement plus stale snapshots
  converge without repeating the CAS; invalid candidates and visibility expiry
  cannot attest provenance or merge.
- `test/rebase-result.test.mjs` exercises full-tree replay on a clean overlapping
  base and rejects dropped remediation, extra commits, whitespace, binary and
  mode changes, nonlinear history, wrong bases, missing objects, conflicts and
  oversized histories.
- Existing lease fairness, cancellation, terminal-owner and smoke suites remain
  part of validation. All fixtures are offline and require no GitHub token,
  live lifecycle operations, provider calls or optional agent-os checkout.

Validation on 2026-10-24:

- Lint: zero errors (existing warnings); contract typecheck and the research-finding
  byte-equivalence demo passed.
- Rendered shellcheck: no new findings versus the branch baseline (three existing
  verify-head diagnostics, zero merge diagnostics). The requested
  `scripts/test-shellcheck-gate.sh` does not exist in this repository; rendered
  scripts were checked directly because unrendered placeholders are shell syntax.
- The 253-test focused run passed 252 and caught only the prompt byte budget.
  The prompt was tightened below 60 KiB; its final contract rerun passed 50/50.
  The protocol suite passed 33/33 after updating its rename-aware diff assertion.
  Additional deadline, ready-head queue-delay and disjoint-conflict cases passed;
  replay/queue fixtures passed 13/13. The clean smoke and lease/cancellation
  regressions passed in the focused runs.
- The full offline suite reached its 900-second runner bound: 13,583 tests,
  13,565 passed, nine failed, one canceled, eight skipped. Two failures were the
  prompt-size and old diff-argument assertions corrected above. Seven other
  failures were an unchanged derived-artifact test's `spawnSync ps EPERM` and
  six unchanged native-PostgreSQL fixtures unable to allocate host shared memory
  (`shmget: No space left on device`). An unchanged hamclose-ownership suite was
  canceled with a pending promise. Those files match `origin/main`; no host
  resource, PostgreSQL configuration or unrelated test was changed. The outer
  command exited 142; its test group was gone before its private sandbox was
  removed. This is not a claim of a green full-suite run.

See the PR acceptance evidence for final rerun and managed publication results. HCP memory searches
for the convergence symptom and then asynchronous old-head/provenance scope
returned no records. Linear shared field-note lookup was unavailable
(`get_agent_context` not found); this is unavailable evidence, not a clean bill
of history. Injected contract scars and local runbooks informed the safety bar.
No config keys, strict loaders, CI runners/triggers or durable store shapes change.

## Deployment acceptance (not performed by this worker)

After normal review/merge and the normal deployment owner installs this revision,
record the deployed revision and the version used to render new closer scripts.
Do not replace an active closer's rendered scripts or seize its lease. Observe
naturally scheduled non-strict disjoint queued closes: original validated heads
should merge without rebase/CI restart despite unrelated advances. Separately
observe a required strict/overlap rebase: one serialized retry, fresh exact-head
green checks and rebuilt audit/predicate must precede the normal CAS merge.
If an old-head acknowledgement occurs, retain the proof artifact and pushed
edge, then the new-head check/audit evidence. Verify terminal release and absence
of orphan waiters through normal owner receipts. Existing cancellation and
conflict handling remain canonical. No live mutation is needed to manufacture
these acceptance observations, and source publication alone closes none of them.
