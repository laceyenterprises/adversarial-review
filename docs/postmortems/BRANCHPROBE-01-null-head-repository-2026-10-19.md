# BRANCHPROBE-01 — transient null head repository abandoned a live PR

Incident date: 2026-10-19. Status: repair prepared; deployment and host
acceptance pending. Examples and identities in this report are synthetic.
Production observations below were supplied with the ticket; the repair did
not inspect or change live state.

## Reported impact

An open PR was recorded as `no-dispatch / abandoned-pr-closed /
live-head-branch-missing`, and the closer deleted its pending lease. A direct
branch read at the same time returned the PR's exact head SHA. The watcher log
contained eight occurrences across seven PRs. The host also reported GitHub API
rate-limit lock timeouts and slow CLI reads lasting 50–80 seconds. This pressure
is incident context, not proof of which API mechanism produced each null value.

Revalidation on a later pass could recover the record, but the false terminal
classification temporarily left the open PR without a closer owner.

## Cause

The pre-launch live probe treated `headRepository: null` in a PR response as
proof that the branch was deleted. That shortcut skipped the existing bounded
`git ls-remote --exit-code --heads` confirmation. A null repository can be a
transient metadata read, so the PR response alone was insufficient evidence.

The sibling confirmation path already distinguished exit code 2 (no matching
ref) from transport/authentication failures. However, an unknown branch result
could fall through to dispatch, and a successful but empty response was also
interpreted as missing. Both needed explicit unknown handling for this repair.
The sibling-site search found this null-repository shortcut only in the closer.
The initial memory search returned no matching records. An expanded search
including lifecycle declarations found historical identity-resolution deadlocks
and merge-authority incidents. Their relevant lesson is to repair transient
read handling without weakening exact-head review or merge authorization. Local
runbooks and the supplied liveness history also informed this repair.

## Repair

Null head repository metadata uses the existing Git probe with the base
repository URL as its fallback. An identified fork still uses its own URL.
A fork identified by `isCrossRepository` with no head repository stays unknown;
the base repository cannot prove deletion of its head ref. A matching ref
permits normal dispatch. Only Git exit code 2 confirms deletion
and retains the existing abandoned record behavior. Errors, exhausted timeouts
and empty successful output leave `headBranchExists: null`.

For an open PR with unknown branch existence, the closer writes the existing
`dispatch-deferred-transient` state with reason `live-head-branch-unknown`,
releases its unlaunched pending lease and requests a short retry (30 seconds,
on the next normal poll). It preserves the launch budget, suppresses merge-agent
fallback, and records the probe error for diagnosis. A moved head still requests
a fresh review binding before dispatch. No worker is claimed to exist while
confirmation is pending. Merged and closed PR handling remains authoritative.
No new configuration, merge gate, CI check or override label is introduced.

## Regression coverage and acceptance

`test/msm-04-single-route.test.mjs` exercises synthetic null-repository PR
responses with an existing ref, confirmed missing ref, authentication failure,
exhausted timeout and empty output. It verifies the base URL and exact ref,
noninteractive bounded Git reads, durable outcomes, pending lease release,
repeated deferrals without consuming retry budget, and successful dispatch after
recovery. Existing fork, transient retry and merged/closed behavior remain covered.
An unidentified fork test verifies that the base repository cannot establish
fork deletion. The existing handoff smoke also verifies null-metadata confirmation and recovery.

After normal deployment, observe closer passes for open PRs whose branches
exist. None should produce `live-head-branch-missing`; unreadable confirmation
should produce `live-head-branch-unknown` and recover on a later poll. A truly
deleted branch should still be abandoned only after Git confirms no matching
ref. Host verification remains pending and is not claimed by the offline tests.
