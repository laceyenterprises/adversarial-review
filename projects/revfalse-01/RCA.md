# REVFALSE-01 / LAC-1893: bounded evidence assessment

Status: confirmed factual finding defect; pipeline RCA remains unproved.
Assessment date: 2026-10-08. Repository inspected at
`f93ec0c0771bc813a8e397d9d9706f4e650aad68` in the assigned worker tree.
No runtime, prompt, cap, quota, label, or merge behavior changes are proposed.

## Confirmed evidence (dispatch supplied, not independently rerun)

Searchlight #40 received three exact-head Gemini reviews alleging that
`_harness_endpoints` retains frontier authorities when adding LiteLLM:

| Review time | Reviewed head | Workspace blob |
| --- | --- | --- |
| 14:46 | `d57be4dc042d365b1b6c6a44b16e820b12d5692f` | `f0e976c9db2b8cd3b5e5b6cdbf9fbc2f1a28f205` |
| 17:14 | `6a6714cd8c2b8b6497fa438d393200bca96c9c51` | `f0e976c9db2b8cd3b5e5b6cdbf9fbc2f1a28f205` |
| 18:23 | `6bc59bcba3cf125bec38169cfb210c3d427022ee` | `1d7f83c36d4c19a433354c80bdf84b5def65cdfd` |

The final review ID is `PRR_kwDOU95ets8AAAABRYHWkw`. Successor
`0200404e3f00c313ba9025fcba7eb65627722639` has the final row's blob.
The supplied full function starts at line 1553 and assigns
`authorities = {(target.hostname, port)}` at line 1578. This replaces the
initial set. LiteLLM mode requires its URL and selects only that URL's key.
Thus the alleged append/retain behavior contradicts the supplied source.
Confidence: high, conditional on the dispatch's immutable-source attribution.
The dispatch reports six DNS-stubbed authority cases passing on each of four
heads (24 cases); those results were not rerun here and do not prove what the
reviewer saw.

## Three bounded read groups

1. Workspace/branch identity, repository instructions, local artifact and
   historical-scar discovery. The workspace was clean on
   `codex-revfalse-01/LAC-1893`. No incident-specific retained input artifacts
   or July 26 false-positive-remediation scar were located in this repository.
   No memory reader was available in the exposed tool catalog. The supplied
   description says that scar is closed; its full content was unavailable and
   has not been inferred from unrelated July 26 references. No foreign tree,
   production state, or credential store was traversed.
2. Reviewer orchestration, diff fetch, workspace construction and relevant
   runbooks (`docs/RUNBOOK-reviewer-workspace.md` and
   `docs/RUNBOOK-antigravity-gemini-reviewer.md`).
3. Prompt/context assembly, staged prompt context, and local validation and
   publication interfaces. These are current repository contracts, not proof
   of the version deployed during the incident.

## Input construction findings

`src/reviewer.mjs` fetches a diff using `reviewerHeadSha`, then builds a
read-only snapshot from the default checkout. Its snapshot call does not pass
`expectedHeadSha`. The workspace runbook explicitly describes the snapshot
as neither the PR head nor necessarily its merge base. Consequently, having
an exact reviewed head does not establish that a filesystem lookup reads
that head's full function. This is a documented architecture property, not
an established cause of this incident.

`src/reviewer-diff-fetch.mjs::fetchPRDiff` keys cached bytes by the supplied
head, but its uncached primary fetch uses `gh pr diff` for the mutable PR.
This exposes a possible head-binding race to investigate separately. No
incident diff bytes, fetch timing, cache provenance or deployed-version
evidence was available to demonstrate that this race occurred. No change is
justified by this incident alone.

`src/reviewer-prompt.mjs::buildReviewerPrompt` frames the supplied diff after
the stage prompt and extra context. `buildReviewerExtraContext` adds linked
spec context, advisory findings, hardening context, PR stated intent and
qualified exact-head dispute evidence; slim mode uses a narrower context
path. `src/prompt-context.mjs::formatPrIntentContext` limits the PR body to
8192 bytes. Dispute context requires matching head, reservation, comment
identity, author and body hash. A stale-head dispute refused without posting
cannot be assumed to have reached the prompt. Middle-stage instructions
prioritize prior blockers, but do not by themselves prove prior-finding
injection. Antigravity instructions permit at most one targeted checkout
lookup. Runtime selection, stage, slim selection and any chunk/elision path
for these three reviews remain unknown.

For EACH of the three reviews, the following are unavailable in this worker:
the exact submitted prompt/diff bytes, full context and test-result text,
snapshot identity and lookup transcript, runtime/model/stage selections,
chunk/elision metadata, and prior-finding content actually delivered. Neither
full-function availability nor author-test availability can be established.
Correct complete input misread by the model, missing/stale input, and prompt
contamination remain competing unproved hypotheses. Repeated prose does not
select among them. Confidence in a specific pipeline or model RCA: low.

## Governed follow-up and closure gates

The native review-artifact custodian should preserve and provide the three
existing input envelopes and runtime transcripts through an authorized
read-only evidence handoff, keyed by the heads/review ID above. Include exact
prompt/diff bytes or their immutable artifact references and hashes, fetched
PR head/base and fetch/cache timestamps, snapshot head, stage/runtime/model,
context selections, author test evidence and elision/chunk records. Obtain
the closed July 26 scar through the native memory owner in the same handoff.
This is a concrete evidence request, not authorization to rerun reviews or
providers, reset caps, or expand this worker's repository scope.

Compare the retained inputs offline against the supplied immutable function
and independently evaluate test-evidence presence. If a deterministic
binding, omission or contamination defect is reproduced, open a narrowly
scoped regression-backed fix and inspect sibling fetch/context paths. If
complete correct input is demonstrated, classify a model factual reasoning
failure and propose an offline recorded-fixture evaluation through normal
operator governance. No source fix is claimed by this report.

This report requires normal independent cross-model convergence and CI
before merge. It carries no deployed/loaded-source claim or qualified natural
production-review evidence. Any later runtime fix separately requires its
reviewed commit, deployment/loaded-version proof, and qualified natural review
evidence without an unauthorized canary. Paul retains reviewer-cap
disposition. Searchlight review/merge, remaining native CI, current-head
convergence and deployment gates are not waived; this RCA authorizes none of
them. The dispatch reports a five-cycle cap notice at 18:44:40 and three CI
jobs in progress, not current live state.

## Validation and retained-work disposition

`npm run lint` passed with zero errors and 153 warnings;
`npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed. Markdown whitespace
validation passed. Validation commands unset DATABASE_URL and known
Postgres/production DSN variables without printing their values.

The full `npm test` run was bounded to 120 seconds and stopped early after
output included host config reads outside this workspace and `gh api`
HTTP 404 diagnostics. These diagnostics do not alone establish a live
network request, but the run cannot be certified offline from this evidence.
The stopped runner exited nonzero and reported `ENOTEMPTY` cleaning its
temporary sandbox. No retry or baseline investigation was attempted.
Per the dispatch's stop-on-failure instruction, this RCA is retained locally,
uncommitted; no push, PR, merge, deployment or success signal occurred.
Validation isolation must be resolved before a governed publication attempt.
