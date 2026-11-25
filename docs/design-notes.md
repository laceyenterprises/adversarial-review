# Design notes

## Why this works — the design notes worth reading

The review loop is intentionally boring in its boundaries. The
opinionated parts are:

**1. The builder is never the reviewer by default.** Routing is by PR-title
prefix (internal worker classes) for the GitHub-PR domain, and by
`domains/<id>.json` wiring for other domains. The routing table is a flat enum,
not a heuristic, because heuristic routing would re-introduce same-model review
under load. Operators can deliberately pin the first-pass reviewer with
`ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=codex|claude|gemini`; that pin overrides
the Gemini default layer except for the Gemini-on-Gemini hard guard. When unset,
the base opposite-agent route is Codex PRs to Claude, Claude Code PRs to Codex,
Clio PRs to Claude because Clio dispatches Codex-family writers, and
Gemini-family PRs to Codex. `grok.reviewer.mode` controls the enabled Grok reviewer
lane: `off` leaves automatic routes alone, `fallback` covers a quota-capped
reviewer after the Gemini layer or a grounded provider, and `always-on` retains
the previous Grok base-route replacement. Its default is `always-on`; both
`grok.enabled` and `grok.reviewer.enabled` still default to false and must be
true. The environment override is `AGENT_OS_GROK_REVIEWER_MODE`. Invalid modes
fail closed. Explicit reviewer pins outrank automatic selection, and the
same-family and per-head exclusion guards always apply. Provider fallback tries
the cross-model primary, Gemini, Grok, then the last resort; Grok requires known
xai grounding evidence. The companion OS schema change must land before a host
sets this key.

The Gemini spawn-quota retry route also applies Grok row fallback before
provider grounding, using the existing row's quota evidence for the primary it
would replace. Always-on Grok records that replaced primary and can bypass its
quota hold; a row already attributed to Grok retains its hold. The
`reviewer-roster` text and JSON output use both reviewer modes and the Grok lane
enablement switches, including a Grok row with its default routes and eligibility.

`reviewer.gemini.mode=always-on` then routes Codex,
Claude Code, and Clio first-pass reviews to Gemini by default through the same
effective route helper used by the watcher and operator surfaces. Gemini never reviews Gemini-built
PRs; those stay on Codex even under a Gemini pin. Invalid override values fail
at watcher startup with a `FATAL config` log line, and same-family override pins
are stamped into the posted review body as an explicit waiver of the default
cross-model guarantee. The waiver is audit-only: it does not change the merge
gate or require an extra human approval by itself.

When a provider is *grounded* — a hard 429/`exhausted` probe state, or the AFH
soft-grounding verdict (`afhGrounding` on `hq fleet quota status --json`, which
catches a flapping provider the hard gate misses) — the assigned reviewer cannot
spawn at all, so `src/afh-reviewer-fallback.mjs` walks an ordered fallback:
current reviewer → the per-tag cross-model primary → Gemini → Grok (when its
mode and lane flags permit) → Claude, skipping
candidates that would violate the builder-family refusal. Both Claude accounts
are refused for Claude-family builds, including last-resort fallback.
Quota-triggered worker-class fallback also enforces family refusal without a
same-family last resort; it holds when no eligible reviewer is available. A
`[claude-code]` PR uses Gemini during a Codex outage when Gemini is eligible and
available; if Gemini is also grounded or disabled, review dispatch holds until
an eligible cross-model reviewer recovers. Pre-model GitHub budget exhaustion
exits with a typed deferral, releases the claim and credential slot, and queues
the same reviewer for the bucket reset
without charging an attempt. An alternate selected by these existing fallback
rules can run before that reset. Fallback is stateless and
per attempt, so it auto-reverts the moment the provider recovers — there is
nothing to un-pin. Every failure of the quota read (missing `hq`, non-zero exit,
timeout, unparseable JSON, absent verdict) fails open to the configured
primary/Gemini route with a degraded-read breadcrumb; it never blocks a tick.
Set `ADVERSARIAL_AFH_REVIEWER_FALLBACK=0` to disable the provider-grounding hop.

REVIEWERFLOOR-01 separately binds personal Claude reviewers to the effective
Anthropic reserve floor from `hq fleet quota status --json`. Fresh measured
weekly capacity at or below that floor selects corporate-first Codex when
the builder family permits it, then enabled and available Gemini. A `[codex]`
PR therefore uses Gemini or holds for eligible capacity. Ready corporate Claude
remains independent when account routing is enabled. Under AFH rollback,
selection deliberately skips Claude account proposals and conservatively treats
Claude as personal for this floor, even if spawn could acquire a corporate
pool account. Stale or unknown floor evidence adds no refusal, and
protected operational roles retain their existing exemptions. Reviewer pins
and the AFH hop rollback do not waive a measured floor. The watcher log and
review pass/run `afhReviewerFallback` record the reason and percentages.
After deployment SRE should observe an organic floor crossing and recovery;
offline tests do not establish that live receipt. Lifecycle states, claim
ownership and smoke commands remain unchanged.

The producer exposes one `anthropic-oauth` reserve for all personal `claude-code`
pool accounts; reviewer selection applies it to every such account. Independent
personal-account reserves require a producer projection keyed by account ID.
`remainingPct` is the effective threshold; `weeklyMeasurement.percentRemaining`
is the measured capacity. The reviewer-only `<=` comparison deliberately ignores
dispatch `protectedClasses` exemptions and short-window `active`/`paused` flags.
The stable reason is `personal-anthropic-reserve-floor`; current percentages
remain in structured `reserveFloor` metadata and diagnostic text.

A floor hold with no eligible alternative emits a transition-only
`reviewer-route DEFERRED` warning. After 15 minutes of continuous observations,
the watcher emits one error-level `reviewer-reserve-floor SUSTAINED_HOLD` health
signal per PR, re-armed by recovery or a different quota hold. Tracking is
process-local and resets on watcher restart; existing pipeline freshness paging
remains responsible for operator pages. SRE should inspect reserve capacity and
Gemini eligibility; do not waive builder-family refusals.

When Claude account selection reports a hold, AFH skips Claude as a fallback
candidate, including when corporate account evidence is unknown or stale. Unknown
evidence alone does not trigger a switch away from an assigned Claude reviewer;
its spawn preflight retains the account hold. Worker-class fallback requires an
explicit admitted Claude account, including on legacy quota projections without
account evidence. A hold discovered at final spawn admission releases the claim
and refunds any spill reservation before another candidate runs. Reviewer quota preflight uses only
the selected reviewer's account: a corporate Claude selection cannot change
Gemini's Google quota check. Both Claude accounts resolve the governed model from
the canonical `claude-reviewer` role; the selected broker provider binds token
mints and renewals to the account.

Wait, depth and burst spill routes also check their selected credit-capable
account before charging spill capacity. An unreadable probe keeps that account
held and asks AFH for the eligible declared alternate. The final pool route
controls capacity, deduplication and claim attribution. If the selected account
later fails the same preflight at launch, the exact unstarted claim returns to
pending on ordinary cascade backoff. See the [queue-depth runbook](RUNBOOK-review-queue-depth-failover.md).

HOSTOBSDENIAL-01 retains safe host-read refusal classes and fixed detail:
entitlement-denied names host.observations.read. Entitlement denials and
not-found registries remain non-retryable reviewer-configuration-error faults
and never permit seed fallback or infrastructure auto-recovery. Timeouts and
outages permit seed selection for the six supported classes; unresolved
classes retain the original retryable refusal. Sync diagnostics never satisfy
readiness or suppress an async refresh.

REMODELFALLBACK-02 requires `RegistryUnavailableError.retryable === true` and
`category === 'infrastructure'` before selecting a seed default, including the
secondary non-blocking Codex read. The host-observation classifier normalizes
`entitlement_denied`, `not_entitled`, and HTTP 401/403 to the existing
non-retryable entitlement refusal naming `host.observations.read`. Unpinned
resolution preserves `reviewer-configuration-error` and `modelSource=unresolved`
without a seed warning. Timeout, unavailable and 5xx failures retain seed
selection, warning throttling and existing retry bounds. Valid explicit pins
retain precedence and allowlist validation, returning `modelSource=env-pin`
even after a refused read; readiness defers a pinned refusal to class selection,
so an unrelated pin cannot supply an unpinned class's seed default.

After normal deployment, the build manager reads an organic run's
`[worker-model] <class> model=<model> modelSource=registry` selection message
or `[reviewer-harness] <harness> model=<model> modelSource=registry; effort=<effort> source=<source>`.
For review records, the corresponding durable field is
`metadata_json.reviewerExecution.modelSource`; local remediation records use
`remediationWorker.modelSource`. Expect `registry` with the grant present and
no explicit pin. These are consumer receipts after deployment; offline tests
and PR publication do not establish live adoption. No service restart, grant
change or synthetic live run is part of this change.

GitHub lifecycle polling revalidates PRs with REST ETags. Closer reads may
use positive reserve capacity while routine polling defers. Typed rate-limit
evidence survives daemon and hammer subprocess boundaries; long cached holds
confirm with the sending token through the proxy-aware `gh` transport.
Scope-local failures defer even when disk state is absent or healthy. Existing
lifecycle states, merge authority and smoke commands are unchanged. See the
[GitHub rate-limit state contract](data-model/github-rate-limit-state.md)
for cache validity, credential attribution, and deficit alerts.

REGISTRYSESSION-02: each process that resolves governed reviewer, closer or
remediation models owns its registry readiness. The shared
`ensureWorkerRegistryReady()` helper asynchronously registers an app session and
prefetches `worker_registry` before synchronous selection, reusing a fresh
60-second snapshot and refreshing on expiry. Reviewer subprocesses, security
review children, quota grounding/readers, account and fallback routing, watcher
polls and follow-up consumers use this boundary independently. Library callers
can inject `ensureWorkerRegistryReadyImpl` through their existing options; the
default remains the production prefetch. Readiness precedes governed model
selection while lease/cooldown checks retain their order, and local remediation
rechecks shutdown after its awaited refresh before spawning. A transport
outage permits the immutable packaged worker-model seed for its six reviewer and
remediator classes (REMODELFALLBACK-01), with allowlist validation and a visible
warning limited to once per class per 60 seconds. A readable registry missing a
class fails closed, so a retired class cannot return through the seed. Pins
remain allowlist-checked, including during outages. Unresolved classes retain
retryable `reviewer-model-unresolved`, without OAuth paging; closer model faults
propagate before pool selection under automatic and pinned account policies.
Antigravity display-token substitution records `runtime-display-token` rather
than registry/seed provenance. Readiness returns availability; per-class selection
after claim owns infrastructure requeue. Synchronous resolution performs no
physical request and reads no host filesystem fallback. Corporate governance, existing bounded
infrastructure backoff and merge authority are unchanged. Offline coverage:
`test/worker-registry-entrypoints.test.mjs`, `test/registry-model-session.test.mjs`,
`test/standalone-reviewer-execution.test.mjs` and
`test/dispatch-read-client.test.mjs`. After normal deployment, SRE observes
organic reviewer/security routing and quota grounding with registry provenance
or visible seed warnings, and a corporate Claude review completing. Publication alone does not establish this receipt; the existing smoke
command is unchanged.

Codex reviewer routes also prefer corporate capacity, including spills and all
fallbacks. Fresh measured quota and a serving broker admit the selected account;
corporate exhaustion or explicit broker unavailability permits independently
admitted personal capacity. Unknown or stale corporate evidence holds. Typed
corporate quota exhaustion records a bounded account cooldown before releasing
capacity. Every Codex spawn logs `codex_account=corporate|primary`; the claimed
account also selects quota preflight and broker token minting/renewal. See
[account routing](CCX-04-corporate-review-fallback.md).

**2. The reviewer prompt is adversarial, not consultative.** The standard
reviewer prompt explicitly tells the model: *"You did NOT write this code.
Your job is to find problems. Do NOT summarize. Do NOT praise."* Full
text is in [`docs/internal/SPEC-original.md`](internal/SPEC-original.md)
and `prompts/code-pr/reviewer.first.md`. Sycophancy is the failure mode
this prompt is built to defeat.

**3. Verdicts are parsed, not interpreted.** `src/kernel/verdict.mjs`
extracts a `Comment only` / `Request changes` decision from a structured
markdown body. Anything else is a parser failure, not a soft signal.
This is what makes the loop a *gate* rather than a suggestion.

**4. Remediation replies are validated against a contract.** The
remediation worker's reply must be a JSON object with `addressed[]`,
`pushback[]`, `blockers[]`, and `reReview`. `src/kernel/remediation-reply.mjs`
rejects malformed replies before the loop advances. This is what makes
remediation idempotent — the worker can re-run and the kernel can tell
whether progress was made.

**5. Round budgets are per-risk-class.** Low-risk subjects get one round
to converge; critical-risk subjects get more. The final round uses a
*lenient* prompt that escalates only substantive, evidence-bearing
findings as blocking — so the loop terminates predictably instead of
chasing diminishing returns. Spec-touch findings (contract drift)
remain blocking even on the lenient round, because silent drift is the
class of failure that round budgets are *not* designed to forgive.
Follow-up priority is derived from the structured blocking-findings
section and verdict, not from security-related keywords that may appear
in summary or non-blocking prose. A stated `Request changes` is always
critical even when its blocking section contradicts it; unknown or
unparseable blocking state also fails safe as critical.

**6. Delivery is byte-stable and idempotent.** Every reviewer verdict
and remediation reply is written as a JSONL record with a stable
delivery key (`domainId` + `subjectExternalId` + `revisionRef` + `round` +
`kind`). Retries are content-identical. This is what makes the loop
durable through daemon bounces, network blips, and crashed workers.

**7. Failure is loud, not graceful.** A malformed PR title does not
silently fall back to "same-model review" — the watcher posts a comment,
writes a terminal failure record, and refuses to start. A reviewer
output that lacks a `## Verdict` section throws, not warns. The
philosophy is that the cost of a missed quality gate is higher than the
cost of an explicit, recoverable failure.

A reply that echoes the output template is not a review either
(REVIEWVALID-01). Before anything is posted, `src/kernel/review-reply.mjs`
checks the raw reply of every direct reviewer model and every oversized-diff
chunk. Hosted `agent-os-hq` artifacts first shed their model preamble and an
optional whole-reply Markdown fence. Validation still precedes lossy section
trimming. Direct reviews and individual chunks can drop up to three non-empty
lines of plain prose totaling at most 400 characters immediately before
`## Summary` when all five required sections are present in order and pass
validation. Headings, fences, placeholders and verdict terms disqualify the
preamble. The reviewer logs only `droppedPreambleBytes` for a removed preamble. The
final posting body is validated too. Validation, sanitization and finding parsing
share fence handling: headings and finding cards inside examples are not review
sections or actionable findings, and examples remain intact in the posted body.
It rejects a reply if:

- at least two fields of a finding card are whole-value template placeholders
  (`<Title>`, `<path>`, `<range>`, `<one paragraph>`, `<text>`; the list is
  derived from the prompts' `Output requirements:` block), or an entire Summary
  or Suggested fixes body is `<text>`. Fenced code and arbitrary prose labels
  are excluded from placeholder detection;
- any text other than the optional `## Adversarial Review …` header comes
  before the first required heading;
- a required heading outside fenced code appears twice;
- `## Verdict` is not the last section, or anything follows its verdict line;
- the effective verdict is `Request changes` but no blocking finding is listed
  (`request-changes-without-findings`, REVIEWVERDICTEMPTY-01). Non-blocking
  findings alone do not satisfy this rule. `Comment only` and `Approved`
  remain valid with no findings.

A chunk rejected for its output is retried once with the same prompt and
timeout plan. Earlier chunks are kept, and each rejection has its own forensic
dump. A rejection that reaches the watcher carries a `[reviewer-output]` tag.
The watcher retries it on the bounded `reviewer-output` path and records the reason in
`failure_message`. It is never posted and never stored as a verdict. As
defence in depth, `parseReviewFindings` uses the same corroboration rule: a
section with at least two whole-value known placeholders in one finding card
(title, file, lines, problem, impact or fix; case-insensitive) reads as `unknown` with
`malformed: 'template-placeholder'`. The rescue classifier then reports
`malformed-review` and the closer refuses, so neither treats a placeholder as
an addressable finding. Markup titles such as `<path>`, `<text>` and
`<AuthProvider>`, and virtual paths such as `<stdin>`, remain addressable
findings when they lack corroborating placeholder fields.

**7a. But refusing is not the same as dropping.** The reviewer is resolved
from the worker-class prefix in the PR title, and a dependency bot cannot
produce one — so for a while those PRs were written to a *terminal*
`unroutable-bot-author` row: no reviewer, no retry, no escalation.
`adversarial-review#909` and `#910` sat that way for 14 hours, and `#909` was a
major bump of the native driver behind `reviews.db` itself. Nothing had failed;
nothing could route them. They were not rejected, they were dropped.

ASR-04 changed the disposition: a PR that the security-surface classifier
(`src/security-surface-classifier.mjs`) flags is **enqueued** to the Argus
security queue (`data/argus-security-jobs/`) instead. The row carries
`review_status='argus-security-queued'`, which is deliberately *not* terminal —
the watcher revisits it every tick so a new head re-enqueues, and the adversarial
gate reports `pending` rather than `success`, because an unanswered security
question is not an approval. Two boundaries hold that in place:

- a **human** PR with a bad title prefix is still terminal-`malformed`; that
  finding is accurate and the author can act on it, and blurring it into the bot
  branch would destroy the distinction the bot branch exists to make;
- a **manifest-touching human** PR is enqueued *additively* — the manifest
  trigger routes on the file, not the author, and the normal adversarial code
  review still runs alongside the security review.

`ADVERSARIAL_ARGUS_SECURITY_ROUTE=0` rolls the whole route back to the
pre-ASR-04 terminal behaviour (loudly — every such write logs
`ARGUS_ROUTE_DISABLED`). `npm run argus:backfill` recovers rows already stranded
in the old status; open rows also self-heal on the next watcher tick.

Existing immutable file releases use the [LAC-2117 provenance contract](RUNBOOK-argus-artifact-provenance.md).
The collector verifies base-established producer identity and exact merged
artifacts through the Agent OS rubric. Model caches bind the current base/head,
artifact digests and deterministic findings; only CI-only changes reuse model
work. This changes no queue states or lifecycle/smoke declarations. Historical
completed results are retained; adoption requires a normal new reviewed head.

The Argus drain reserves a shared Gemini identity before spawning its review
child when Gemini is enabled. A structured child outcome penalizes that identity
only for a recorded Gemini failure other than quota exhaustion or identity
unavailability. Claude/Codex failures and errors before model execution release
the reservation cleanly; a child that exits without a usable outcome retains
the conservative failed-lease handling.

A narrow dependency-bot auto-adjudication path handles simple non-major,
non-native manifest bumps without waiting for a separate Argus worker; `0.x`
minor bumps are treated as major for this policy and route to verification. It
records the exact dependency inputs, hands the exact head to clean merge
authority, and leaves the Argus job pending when CI has not reached a terminal
green/red answer yet so the next watcher tick can retry instead of completing a
job that never merged.

For the seam diagram and the kernel/adapter contract details, read
[`docs/ARCH-adversarial-review-adapter-architecture.md`](ARCH-adversarial-review-adapter-architecture.md).

---

## How the pluggability works

The kernel does not know whether the reviewed subject is a GitHub PR, a
markdown file, a design memo, a Slack thread, a policy change, a
generated research finding, or anything else. A domain config wires four
pieces together:

- `domains/<id>.json` chooses the adapters, the reviewer runtime, the
  prompt set, and the per-risk-class round budgets.
- A **subject-channel** adapter discovers the subject, reads its content,
  prepares remediation workspaces, records remediation commits, and
  finalizes terminal state.
- A **comms-channel** adapter posts reviewer verdicts, remediation
  replies, and operator notices with stable delivery keys.
- An **operator-surface** adapter syncs external triage state (e.g.
  Linear issues) or records human override events.

The reference implementation for a non-PR domain is `research-finding`.
It uses:

- `domains/research-finding.json`
- `prompts/research-finding/reviewer.first.md`
- `prompts/research-finding/reviewer.middle.md`
- `prompts/research-finding/reviewer.last.md`
- `prompts/research-finding/remediator.first.md`
- `prompts/research-finding/remediator.middle.md`
- `prompts/research-finding/remediator.last.md`
- `src/adapters/subject/markdown-file/index.mjs`
- `src/adapters/comms/slack-thread/index.mjs`
- `src/adapters/operator/linear-triage/index.mjs`

Adding your own domain is "new domain config + new adapters where the
existing ones don't fit + new prompt set + new fixture test." It does
**not** require changes under `src/kernel/`. If you find yourself wanting
to change the kernel to make your domain fit, pause and ask whether
you're exposing a true shared need or leaking adapter behavior in. Either
answer is fine, but it's worth the pause.

The full worked walkthrough is in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## Adding a domain

Start with [`CONTRIBUTING.md`](../CONTRIBUTING.md). It walks through the
`research-finding` domain file-by-file and shows how to add your own
subject adapter, comms adapter, prompt set, fixtures, and byte-
equivalence assertions without changing the kernel.

If you hit a place where the kernel doesn't fit your domain, open an
issue with the case before patching the kernel — there's a good chance
the right answer is a small kernel extension, but it should be a
deliberate one.

---

## A note on internal vocabulary

A few terms in the docs and prompts (Clio, the `[claude-code]` /
`[codex]` / `[clio-agent]` worker classes) are names from the
maintainer's operating substrate. None of them are required to use this
project. If you see one and wonder what it means, the decoder ring is
[`GLOSSARY.md`](../GLOSSARY.md).

---

Apache-2.0 was chosen over MIT because adversarial review is the kind of
work where an explicit patent grant matters: someone, somewhere, will
have a patent on "automated cross-model code review" before long, and a
permissive-but-grant-bearing license is the cleanest answer.
