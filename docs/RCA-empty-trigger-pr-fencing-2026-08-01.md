# RCA: Empty Trigger PR Was Mergeable as ARC Implementation Work

Date: 2026-08-01

Issue: https://github.com/laceyenterprises/adversarial-review/issues/739

Trigger PR: https://github.com/laceyenterprises/adversarial-review/pull/736

Real ARC-13 implementation PR: https://github.com/laceyenterprises/adversarial-review/pull/634

Related Agent OS report: https://github.com/laceyenterprises/agent-os/pull/4586

## Summary

During the August 1 adversarial-review cutover audit, PR #736 appeared in the
normal GitHub PR surface as ARC-13 implementation work:
`[claude-code] ARC-13: Sequential two-stage pipeline live`.

Authenticated PR inspection showed that #736 was actually an empty trigger PR:

- zero changed files
- zero additions and zero deletions
- one commit titled `Trigger PR for ARC-13 testing`
- commit body `Worker-Class: gemini`

The real ARC-13 implementation had already merged as PR #634 on 2026-07-18.
PR #736 was later merged on 2026-08-01 despite carrying no implementation diff.

## Impact

The PR surface gave operators and automation a false implementation signal. A
zero-diff trigger artifact looked like live ARC work, which made it plausible
to treat the PR as readiness evidence during a cutover audit.

For adversarial review, this is high-risk even when the direct code impact is
zero: the app is the merge gate for the rest of the Agent OS pipeline, and
review/merge confidence depends on PR identity being truthful. Empty trigger
artifacts must not be able to masquerade as implementation, final review, or
cutover completion evidence.

## Mechanism

The trigger PR reused implementation-shaped metadata:

- an implementation-style branch name: `gemini-arc-13/ARC-13`
- an implementation-style PR title: `[claude-code] ARC-13: Sequential two-stage pipeline live`
- a worker-class commit body: `Worker-Class: gemini`

At the same time, it had no explicit lifecycle marker that told the reviewer,
merge authority, or operator queue that it was only a trigger/test fixture.
Because the artifact was not fenced, it remained eligible to be interpreted
through normal PR readiness surfaces.

## Root Cause

Adversarial-review allowed an empty trigger PR to enter the same queue and
metadata namespace as implementation PRs without a fail-closed classification.

The system had safeguards around malformed worker prefixes and review routing,
but it did not have an equivalent guard for zero-diff trigger artifacts. A PR
with no changed files could still carry a production-looking title and branch
and therefore look like an implementation completion record.

## Contributing Factors

- Trigger/test PR creation reused real project names instead of an explicit
  trigger namespace.
- There was no required label such as `trigger-pr` or `test-fixture` to route
  the PR out of implementation readiness queues.
- Zero changed files did not force a terminal non-implementation state.
- The real implementation PR (#634) and trigger PR (#736) shared enough title
  text to invite confusion during later audit.

## Detection Gap

The mismatch was caught manually during the Agent OS SDK cutover audit by
checking authenticated PR metadata: changed-files count, commit headline/body,
and relation to the already-merged real ARC-13 PR.

There was no automated assertion that a zero-diff PR with implementation-shaped
metadata must be fenced before it can satisfy review, finalization, or merge
expectations.

## Containment

The issue is now tracked in #739. The incident report in Agent OS #4586 records
the cross-repo audit evidence and links the false ARC-13 signal back to this
repo.

Because #736 already merged, the immediate containment is documentary and
preventive: future trigger artifacts must be unmistakable and excluded from
normal implementation queues before they can be opened or reviewed.

## Corrective Actions

1. Add a fail-closed classifier for zero-diff PRs in the watcher/reviewer
   admission path.
2. Require an explicit trigger/test lifecycle marker for any intentional
   zero-diff PR.
3. Exclude trigger/test PRs from implementation completion, final-review, and
   merge-readiness queues unless a dedicated fixture workflow is evaluating
   that class.
4. Prevent trigger PR titles and branches from reusing implementation-shaped
   project titles without a trigger prefix.
5. Add a regression covering an empty ARC-shaped trigger PR so #736 cannot
   recur silently.

## Exit Criteria

This RCA is closed only when:

- #739 has a code fix and regression test, not only this document.
- A zero-diff ARC-shaped PR is classified as trigger/test or terminally
  non-implementation before review/merge readiness.
- Intentional trigger PRs have a distinct lifecycle label or namespace.
- Operator queue/readiness views cannot present trigger PRs as implementation
  completion evidence.
