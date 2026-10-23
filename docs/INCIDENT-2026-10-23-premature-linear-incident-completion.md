# LAC-2092: review completion wrote incident Done

Source proof and offline regression evidence only. Deployment adoption and
behavioral acceptance remain pending with the operator. LAC-2089 is operator
owned and held In Progress; this work does not authorize changing its state.

## Producer proof

The source is `reviewer.mjs`'s post-review `recordReviewCompleted` call, through
`src/adapters/operator/linear-triage/index.mjs`. The old adapter unconditionally
called `syncTriageStatus(subjectRef, 'done')`, resolved the team's Done state,
and called `linear.updateIssue`. Review findings and PR lifecycle were not
acceptance inputs.

This attribution uses the producer log, not just matching timestamps.
Read-only inspection of the operator's retained
`~/Library/Logs/adversarial-watcher.log` found:

- Lines 28654–28656: reviewer queues
  `laceyenterprises__agent-os-pr-9047-2026-10-23T19-56-32-327Z`, then
  `[linear-triage] Linear LAC-2089 -> "Done"`, then
  `[reviewer] Done: laceyenterprises/agent-os#9047`.
- The preceding reviewer attestation identifies head
  `ebcb6a47fbc3c0582d2bff27cb8b42a6e33fbf2f`, `comment-only`,
  `findings_count=2`.
- The buffered stderr for `[reviewer:9047]` names the same head, ticket and
  first-pass identity; line 28686 says
  `[reviewer] DEBUG: updating Linear ticket LAC-2089; critical=false`.
  Stdout/stderr are buffered separately, so their interleaving is not a
  wall-clock ordering proof. The explicit successful adapter write identifies
  this producer.

Linear `stateHistory`, read through the connector, independently records
In Review → Done at `2026-10-23T19:56:33.634Z`, then operator reopening at
`20:06:28.377Z`. The rescue's `9047-owner-in-progress.json` records the queued
review at `19:56:32.327Z`, remediation claim at `19:58:23.283Z` and spawn at
`19:58:54.758Z`. The claim is later than Done; dispatch completion or the
remediator's later reply cannot explain the earlier transition.

The exact `9047-native-remediation-reply.json` says `outcome: partial`, two
nonblocking fixes published at `2bef8f7cc61c9caaedc7fa157950b6e1e7479a0e`,
`pending-ci`, and `reReview.requested: false`. `9047-current.json` still shows
OPEN on that head, with current-head CI beginning at `20:01:00Z`. This bounds
publication without inventing an exact push timestamp. These artifacts live
under `/private/tmp/os-rescue-20261023-191355`; the regression fixture retains
the review body, exact native reply and chronology, excluding runtime credentials
and process dumps.

## Guard and ownership

The shared Linear writer protects completed/canceled workflow types and
configured terminal aliases. It reads incident/severity labels on the actual
Linear issue, with a constrained leading SEV title fallback for unlabeled manual
issues such as LAC-2089. It also preserves an incident owner's terminal state
against stale progress updates. The adapter does not read acceptance from PR
labels, review text, source pushes, dispatch success or merges.

Native hardening closure has its own recorded `closure_evidence` and
`closure_policy_receipts` owner. This adapter has no existing exact binding from
a manually filed Linear issue to that native incident. Introducing a second
closure evaluator or scanning arbitrary ticket mentions would create another
authority. The guard therefore leaves incident terminal writes to their existing
owner, including when native closure is already accepted. It does not invent a
new acceptance flag or permit caller-supplied acceptance to bypass the hold.

Ordinary feature-ticket review-to-Done behavior and critical-review comments
continue. A deliberately held incident sync is settled, allowing the existing
terminal PR mirror and durable pending-triage queue to converge. The remediation
and merge loops and their gates are unchanged.

## Validation and acceptance boundary

The deterministic incident fixture exercises the production adapter entry
points, native chronology, renamed labeled incidents, custom terminal states,
stale reopening, metadata failures, critical comments and ordinary features.
It also drains a real pending merged-PR triage record while preserving In
Progress. Against the original writer, six protection/retry tests fail and the
non-incident regression passes; all seven pass with the guard.

The source fix requires normal cross-model review and hosted gates. After
deployment, the operator must verify adoption by both watcher and reviewer,
observe the guard on a natural incident sync, and separately check ordinary
ticket convergence. Offline fixtures and PR publication do not prove deployed
behavior or authorize closing LAC-2092 or LAC-2089.

HCP memory searches for premature Linear incident completion and for the narrowed
adapter scope were available and returned no records. Linear `get_agent_context`
was attempted and returned `Tool get_agent_context not found`; unavailable field
notes were not treated as evidence of no prior incidents. The supplied hardening
contracts informed sibling-writer inspection: all adapter state writes share
`setLinearState`; no config key, merge classifier, terminal-PR guard or claim CAS
changes are needed.
