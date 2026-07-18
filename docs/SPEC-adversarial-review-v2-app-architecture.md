# SPEC — Adversarial Review v2: Harness-Agnostic Orchestration App

**Status:** Draft v0.1 — for operator review. Nothing in this document is
authorized for implementation until the operator approves the phase plan.
**Companion:** [`SPEC-merge-authority-v2.md`](SPEC-merge-authority-v2.md)
(ground-up finalization redesign; referenced by Phase 3 here).
**Baseline snapshot:** v1 = the submodule state at the commit this spec lands
on top of. Phase 0 tags it before any structural change.

---

## 1. Purpose

Adversarial Review v2 refactors the review/remediation/convergence system from
a GitHub-PR + CLI-spawn monolith into a **harness-agnostic orchestration app**
that:

1. Orchestrates any agent defined by the Agent OS worker-class / foundry
   substrate (reviewers, remediators, closers) instead of hand-rolling CLI
   spawns per model.
2. Reviews any *subject* (code PRs first; research findings, specs, incident
   reports later) through the existing domain/adapter architecture, made real.
3. Drives Agent OS exclusively through its agreed app interfaces — and serves
   as the **reference implementation of the app paradigm** for future apps
   (e.g. Finch).
4. Survives OS outages: the core convergence loop is **OS-optional by
   construction**, with automatic failover to a local runtime and automatic
   resume when the OS returns to sustained health.

### Non-goals

- Rewriting review semantics (verdict grammar, remediation-reply schema,
  risk-class budgets). v1 semantics carry forward unless a phase explicitly
  changes them.
- Porting current merge-authority behavior into the new finalization port.
  Merge authority is redesigned from first principles in the companion spec
  and cut over via shadow mode; v1 AMA is frozen (bug-fix-only) until then.
- Multi-host review fleets. Single-host operation is assumed throughout.

---

## 2. Design principles

1. **App, not module.** v2 is an OS *consumer*: it registers via the app
   contract, dispatches workers through sanctioned surfaces, and owns its own
   state. Where a sanctioned surface is missing, we build the surface in the
   platform (§9) rather than reaching into OS internals.
2. **The OS owns harness knowledge.** Which binary runs a reviewer, which
   models it may use, how it authenticates, what tools it gets — that is
   worker-classes.json + `HarnessProfile` + foundry territory. v2 must contain
   **zero** model-name conditionals and zero CLI-discovery logic in its
   orchestration path. (v1 violates this in `reviewer.mjs`,
   `follow-up-remediation.mjs`, and a second duplicated copy inside
   `adapters/reviewer-runtime/cli-direct/`.)
3. **Kernel purity.** The kernel is deterministic orchestration logic: state
   machines, budgets, aggregation policy, contracts. It performs no I/O and
   names no concrete system (GitHub, gemini, hq, Linear). This is already the
   declared rule in `ARCH-adversarial-review-adapter-architecture.md`; v2
   makes it enforced rather than aspirational.
4. **Structured artifacts are the truth.** A review's verdict is a structured
   artifact returned by the reviewer run — not markdown scraped back off the
   comms channel. Posting to comms (PR review, Slack thread) is a delivery
   side-effect. (v1 already parses reviewer stdout; v2 formalizes the artifact
   contract and aligns it with the OS `decision-only`/`artifact` completion
   shapes.)
5. **OS-optional core.** Every OS dependency declares a degraded-mode
   behavior. The app never wedges because the OS is down; it degrades loudly
   and recovers automatically (§6).
6. **Strangler, not rewrite.** v1 keeps running production behavior at every
   phase boundary. Each phase is independently shippable, config-gated, and
   reversible.

---

## 3. Architecture: five layers

Dependencies point toward lower layers: a layer may import contracts from any
lower layer, but lower layers never import higher-layer implementations. Layer
5 is the composition root: it constructs infrastructure-backed implementations
and injects them behind lower-layer ports. This keeps SDKs and delivery clients
at the edge without preventing layers 3 and 4 from sharing foundational ports.

```text
┌────────────────────────────────────────────────────────────┐
│ 5. Composition + OS    app-sdk · runtime implementations · │
│    integration         github-adapter · HCP/SSE              │
├────────────────────────────────────────────────────────────┤
│ 4. Domain adapters     subject · comms · operator ·        │
│                        finalization (NEW port)             │
├────────────────────────────────────────────────────────────┤
│ 3. Agent runtime port  opaque runs · hybrid routing policy   │
├────────────────────────────────────────────────────────────┤
│ 2. Foundation          role registry · CredentialsProvider  │
├────────────────────────────────────────────────────────────┤
│ 1. Kernel              pipeline state machine · budgets ·  │
│                        verdict aggregation · contracts     │
└────────────────────────────────────────────────────────────┘
```

The daemon (today `watcher.mjs`) becomes a thin scheduler: enumerate
registered domains → pump each subject through the kernel state machine →
kernel emits *effects* (run reviewer, post verdict, dispatch remediation,
finalize) → effects execute through layers 3–5.

---

## 4. Kernel contracts

### 4.1 Review pipeline: stages and panels

The single-verdict model is replaced by a **pipeline**:

```
ReviewPipeline := Stage[]            (ordered; later stages gate on earlier)
Stage          := { id, panel: ReviewerRole[], aggregation: AggregationPolicy,
                    roundBudgetByRisk: { low, medium, high, critical } }
AggregationPolicy := unanimous-clean | any-blocking-blocks | quorum(n) | weighted
```

- **v2.0 configuration:** `stages = [code-review]`, panel size 1 — behaviorally
  identical to v1.
- **Sequential multi-reviewer** (operator-directed near-term goal):
  `stages = [code-quality, security]`. A stage runs only when all prior stages
  are clean at the current revision.
- **Parallel reviewers** (future): panel size > 1 within a stage; verdicts
  aggregate per `AggregationPolicy`. The contract supports this from day one;
  no kernel change is needed to enable it later.

Rules pinned now:

- **Budgets are per-stage**, with a **subject-level remediation ceiling**
  (default: sum of stage budgets, capped) so multi-stage pipelines do not
  multiply hammer cycles.
- **Re-review after remediation re-runs the entire pipeline from the first
  stage.** A remediation commit advances the revision, so every prior verdict,
  including an upstream clean verdict, applies only to the old revision. No
  stage may treat that verdict as review evidence for the new head.
- Every verdict is pinned to the **revision it reviewed**
  (`verdict.revisionRef`, the GitHub `commit_id` in the code-pr domain — never
  inferred from logs or current head). Any revision advance invalidates all
  pipeline stages policy-side and restarts evaluation at the first stage; see
  the merge-authority spec for finalization-side head-move handling.

### 4.2 SubjectState (extended)

`SubjectState` (today `src/kernel/contracts.d.ts`) gains:

- `pipeline: { stageId, stageIndex, panelVerdicts: Verdict[] }[]` — replaces
  the single `latestVerdict` (kept as a deprecated alias during migration,
  resolving to the newest verdict of the furthest-progressed stage that has
  evidence pinned to the subject's current revision). Stale stage verdicts are
  excluded from active-stage resolution; when pipeline history exists but all
  of it is stale, the alias resolves to no verdict rather than falling back to
  stale legacy evidence.
- `runtimeMode: 'os' | 'local'` on each recorded agent run (audit, §6.5).

Lifecycle states are unchanged. The kernel remains the only writer of
lifecycle transitions.

### 4.3 Verdict and remediation-reply contracts

Both carry forward from `src/kernel/verdict.mjs` and
`src/kernel/remediation-reply.mjs` with one structural change: the canonical
verdict source becomes the **reviewer run artifact** (JSON, schema below), and
markdown parsing is demoted to a fallback for local-mode CLI reviewers that
cannot emit artifacts.

```
ReviewArtifact := {
  kind: 'adversarial-review-verdict', schemaVersion: 2,
  domainId, subjectExternalId, revisionRef,
  stageId, reviewerRole, reviewerRunRef,
  verdict: { kind, summary, blockingFindings[], nonBlockingFindings[] },
  body: string                    // rendered markdown for comms delivery
}
```

Operator policies preserved verbatim from v1 (these are standing directives,
not implementation details): strict-mode semantics (non-blocking findings
block autonomous finalization), hammer-always-closes-on-exhaustion, and
final-remediation-addresses-all-comments-before-merge.

---

## 5. Role registry

A config-owned roster replacing both the hardcoded reviewer enum in
`config.yaml` (`roles.reviewer` enum of five harness names) and the
GitHub-fused `reviewerRouting` in `domains/code-pr.json`.

```yaml
roles:
  registry:
    code-quality-reviewer:
      promptSet: code-pr                # prompts/<set>/reviewer.{first,middle,last}.md
      workerClass: gemini               # OS worker class or foundry persona id
      taskKind: review
      completionShape: decision-only
      priority: 10                      # lower first; ties/omissions keep order
    security-reviewer:
      promptSet: code-pr-security
      workerClass: claude-code
      taskKind: review
      completionShape: decision-only
      priority: 20
    remediator:
      promptSet: code-pr
      workerClass: codex
      taskKind: remediation
      completionShape: branch-push
  routing:
    # builder-class exclusions only (an agent never reviews its own class).
    # Identity/token binding for posting is comms-adapter concern, NOT here.
    never-review-own-builder-class: true
```

- A role names a **worker class or foundry persona** — never a binary, model
  id, or CLI path. Model resolution stays in the OS (allowlists,
  `defaultModel`, per-dispatch overrides).
- The v1 rule "reviewer must differ from builder class" survives as a routing
  constraint evaluated by the kernel against `SubjectState.builderClass`.
- Per-reviewer GitHub bot identity (`botTokenEnv` in v1 routing) moves into
  the comms adapter's delivery config, keyed by role id. The kernel and role
  registry never see tokens.
- A foundational `CredentialsProvider` port supplies scoped, short-lived
  credentials by capability (for example `branch-push` or `comms-delivery`).
  Layer 5 injects its production secret-store implementation into both the
  local runtime and comms adapters. Callers receive only the minimum credential
  material for one operation; values are neither persisted in run records nor
  exposed to the kernel or role registry.

---

## 6. Agent runtime port and hybrid failover

### 6.1 The port

One interface, replacing the process-altitude "reviewer runtime" axis:

```
AgentRuntime.run(request) → AgentRunHandle<AppArtifact = JsonObject>
request := { role, promptSet, promptStage, subjectContent, workspaceRef,
             idempotencyKey, budget, timeoutMs }
AgentRunHandle<AppArtifact> := { runRef, mode: 'os'|'local',
                    await(): RunResult<AppArtifact>, cancel(), reattach() }
RunResult<AppArtifact> := { status: completed|failed|timeout|cancelled,
               artifact?: AppArtifact,
               failureClass?, usage? }
```

`AppArtifact` is an opaque JSON object at this boundary. The domain adapter
validates and decodes it into `ReviewArtifact`, `RemediationReply`, or another
domain type before handing it to the kernel.

Two Layer 5 implementations are injected into the Layer 3 router:

**`os-dispatch` (primary, Layer 5).** Dispatches through the app contract
(`/v1/dispatch` via the real `@agent-os/app-sdk` — the vendored fork in
`src/app-contract-dispatch.mjs` is deleted). Reviews dispatch with
`--task-kind review --completion-shape decision-only`; the verdict comes back
through the artifact-handoff surface. Remediation dispatches with
`--completion-shape branch-push`. The app inherits admission, entitlements,
model allowlists, sandboxing, token budgets, and ledger telemetry from the
worker pool — all of the machinery `reviewer.mjs` currently reimplements.

**`local` (fallback, first-class, Layer 5).** Direct process spawn, descended from
today's `cli-direct` path: process-group isolation, forbidden-fallback env
stripping, failure classification, cancellation, reattach-after-crash, atomic
run records under `data/reviewer-runs/`. Because local mode bypasses OS
admission and budget enforcement, it keeps **its own conservative admission
layer**: the existing memory-pressure gates, quota-exhaustion detection, and
a local per-run token/time cap. Local mode is not a test shim — it is the
production lifeline mode and is exercised continuously (§6.4).
For a role whose completion requires an external write, such as the
remediator's `branch-push`, it requests that capability from the injected
Layer 2 `CredentialsProvider` immediately before spawn and passes the scoped
credential only to that child process.

### 6.2 Health router — automatic failover, automatic resume

Operator-decided policy: **failover and resume are both automatic.**

```
probe := healthz(app-contract endpoint)
       ∧ dispatch-acceptance latency ≤ threshold (rolling p95)
       ∧ SSE stream liveness
state machine:  OS-HEALTHY → (k consecutive probe failures, or a server-side
                or transport contract failure on a live dispatch)
                → LOCAL-FALLBACK
                LOCAL-FALLBACK → (m consecutive healthy probes across ≥ w
                minutes; hysteresis prevents flap) → OS-RESUMING → OS-HEALTHY
```

Request-level 4xx responses caused by an invalid subject or malformed dispatch
payload fail only that subject run. They do not count as health-probe failures
and do not change the system-wide router state.

Defaults (config-gated, operator-tunable): `k=3` failed probes at 30s cadence
or a single fail-closed server-side or transport dispatch rejection; resume
hysteresis `m=6` healthy probes over `w=5` minutes.

### 6.3 In-flight semantics across transitions

- **A responsive run finishes in the mode it started.** No mid-run migration.
  OS runs must emit a heartbeat or observable `dispatch_status` progress within
  a short, separately configured `osRunLivenessTimeoutMs` (default 90s). When
  that deadline expires during `LOCAL-FALLBACK`, the router attempts
  cancellation, marks the OS `runRef` superseded durably, and reissues the run
  locally without waiting for the model execution timeout. Cancellation is
  best-effort; active-run validation below is the correctness backstop.
- **Idempotency keys prevent double work across the boundary.**
  `idempotencyKey = (domainId, subjectExternalId, revisionRef, stageId,
  reviewerRole, round)`. On resume, before dispatching anything, the router
  reconciles: for every key it may have handed to the OS pre-failover, query
  `dispatch_status`; an accepted-but-unobserved dispatch is adopted, not
  re-issued. If a transport failure leaves acceptance unknowable and policy
  starts a local replacement, the durable active-run record is moved to the
  local `runRef` first, superseding any delayed OS completion. The app-contract
  endpoint's `(app_id, request_id)` idempotency is the server-side backstop.
- **Only the active run may deliver an artifact.** Before an artifact handoff
  mutates pipeline state, the receiving surface atomically compares its
  `runRef` with the kernel's durable active-run record for
  `(domainId, subjectExternalId, revisionRef, stageId, reviewerRole, round)`.
  A handoff from a cancelled, orphaned, or superseded OS run is acknowledged
  and discarded with an audit event; it must not append `panelVerdicts` or
  trigger a state transition. The same compare-and-set makes repeated handoff
  delivery idempotent.
- **Local results are durable regardless of OS state.** The app's own store
  (`reviews.db`) remains the system of record for subject state; ledger
  enrichment is best-effort (§9).

### 6.4 Keeping the fallback honest

A fallback that only runs during disasters rots. v2 schedules a **fallback
canary**: a low-rate synthetic review (fixture domain, `fixture-stub`-style
subject) through the `local` runtime on a daily cadence, alerting on failure.
Mode-transition drills piggyback on this canary rather than requiring OS
outages.

### 6.5 Audit

Every mode transition emits: an operator notice through the operator surface,
a structured audit row in the app store, and (best-effort) an app-contract
telemetry event. Every recorded agent run carries `runtimeMode` so review
provenance is inspectable after the fact.

---

## 7. Domain adapters

The four existing axes stay, with the boundary made real:

- **Subject channel** — owns discovery, content fetch, revision refs,
  workspace prep, and the *live-state reads the watcher currently does
  inline* (labels, head SHA, timeline). `watcher.mjs`'s inline GitHub logic
  moves behind `adapters/subject/github-pr/`.
- **Comms channel** — owns verdict/reply/notice delivery **and identity**
  (which bot posts as which role). Delivery is idempotent by delivery key
  (existing design, kept).
- **Operator surface** — label controls, Linear triage, pause/retrigger
  escapes. Unchanged contract; implementations move out of the watcher body.
- **Finalization port (new fifth axis)** — `evaluate(subjectState) →
  FinalizationDecision` and `execute(decision)`. The code-pr implementation is
  **merge-authority v2** (companion spec), run in shadow mode against frozen
  v1 until promoted. Other domains get trivial implementations (mark-terminal,
  archive, publish).

Domain config (`domains/<id>.json`) gains `pipeline` (stage list referencing
role-registry ids) and `finalization` (port implementation name), and its
existing `promptSet`/`riskClasses` fields become the *only* source of those
values — the `REVIEWER_PROMPT_SET`/`REMEDIATOR_PROMPT_SET` constants and the
~12 hardcoded `domainId: 'code-pr'` sites in `watcher.mjs` are removed in
Phase 1.

---

## 8. What generalizes: the app paradigm half

These components are deliberately review-agnostic and constitute the reusable
"how to build an OS app" layer (target consumers: Finch and successors):

| Component | Review-specific? | Notes |
|---|---|---|
| App registration + bootstrap token handling | no | thin wrapper over app-sdk `connect` |
| Hybrid runtime router (§6.2–6.4) | no | candidate for upstreaming into app-sdk as `mode: hybrid` |
| Idempotent dispatch + reconcile-on-resume | no | keyed dispatch + `dispatch_status` adoption |
| Local admission layer (memory/quota caps) | no | any app spawning local processes needs this |
| Degraded-mode dependency table (§9) | pattern | every app should publish one |
| Kernel/adapter/domain layering | pattern | the shape, not the code |

Rule of thumb enforced in review: code in layers 3 and 5 must not import
review vocabulary (verdict, finding, remediation). If it needs to, it belongs
in layers 1–2 or 4.

---

## 9. OS surface dependency table and platform work-list

Every OS dependency, its sanctioned surface, and its degraded-mode behavior.
"Gap" rows are new platform work this app forces; each is small, separable,
and useful beyond this app.

| Need | Sanctioned surface today | Degraded mode (OS down) | Gap / platform work |
|---|---|---|---|
| Spawn reviewer/remediator | app-contract `/v1/dispatch` (app-sdk) | local runtime (§6.1) | — |
| Structured run output | `decision-only`/`artifact` completion shape + artifact handoff | local stdout artifact | verify review task-kind end-to-end (Phase 2 gate) |
| GitHub reads/writes | `modules/github-adapter` CLI (already adopted) | same (adapter is OS-daemon-independent) | — |
| Observe dispatch state | app-contract SSE + `dispatch_status`; HCP reads | local run records | — |
| **Merge execution** | **none** (`hq adjudicate merge` is shell-only) | github-adapter `pr-merge` | **GAP-1: adjudicate-merge app surface** (HCP route or app-contract workflow action) |
| **Ledger notes/events (write)** | **none** (loopback-internal only) | queue locally, flush on resume | **GAP-2: app-facing ledger notes API** |
| Worker identity / attestations | direct ledger SQLite read (unsanctioned) | policy-declared bypass + audit | **GAP-3: attestation read surface** (replaces `session-ledger-read-adapter.mjs` direct reads) |
| SDK hybrid mode | app-sdk is agent-os/standalone only | — | **GAP-4: upstream `mode: hybrid` + real SSE `on()` into app-sdk**; delete the vendored client fork |

Until a GAP surface ships, the interim is an explicitly-marked shim module
(one file, named `os-shim-<gap>.mjs`) so the debt is greppable and the removal
is mechanical.

---

## 10. Migration plan

Each phase: config-gated, independently shippable, v1 behavior is the default
until the phase's acceptance gate passes, rollback = flip the gate off.

**Phase 0 — snapshot (hours).** Tag submodule + parent pointer as
`v1-working-snapshot`; cut `v1-maintenance` branch for emergency fixes. No
long-lived fork: all v2 work lands on main behind gates.
*Gate:* tags exist; fixture e2e suite green on the tag.

**Phase 1 — de-hardcode (days).** Thread `promptSet` and `domainId` from
domain config through reviewer, remediator, and watcher. Watcher iterates
registered domains (code-pr remains the only registered one). Add
`domains/code-pr-security.json` + security prompt set as the proof.
*Gate:* code-pr behavior byte-identical (fixture diff); a security-domain
review runs end-to-end on a fixture subject.
*Note:* this alone fixes the known reviewer-hallucination mode where doc/spec
PRs are reviewed with code-pr prompts.

**Phase 2 — agent runtime port + hybrid router (the core).** Implement the
port; `os-dispatch` becomes the default for reviewer AND remediation
(unifying the two forked remediation paths); `local` mode is the descendant
of cli-direct; health router per §6.2. Delete `reviewer.mjs`'s four spawn
families and both copies of model detection once os-dispatch + local cover
them.
*Gate:* (a) review verdict round-trips through dispatch artifact handoff on a
real PR; (b) kill the OS daemons in a drill — pipeline fails over, reviews a
PR locally, resumes automatically when daemons return, with zero duplicate
dispatches (idempotency reconcile proven).

**Phase 3 — pipeline, role registry, finalization port.** Kernel pipeline
contract (§4.1), role registry (§5), sequential `[code-quality, security]`
stages live. Finalization port lands with merge-authority v2 in **shadow
mode** (companion spec §5); GAP-1/GAP-3 platform work happens here.
*Gate:* two-stage sequential review converges on a real PR within budget;
MA-v2 shadow decisions match frozen-v1 outcomes for N days (divergences
triaged, not assumed wrong — v1 is the buggy one).

**Phase 4 — decompose the monoliths.** `watcher.mjs` reduces to the scheduler
loop; `follow-up-remediation.mjs` / `follow-up-merge-agent.mjs` fold into
kernel effects + adapters; `code-pr` is just a domain. Mechanical by this
point.
*Gate:* line-count and import-boundary lint (kernel imports nothing from
layers 3–5); all v1 e2e fixtures pass unmodified.

### Sequencing note

Phases 1 and 2 are independent and can proceed in parallel workstreams.
Phase 3 depends on both. The merge-authority v2 *design* (companion spec) can
be reviewed immediately; its implementation starts in Phase 3.

---

## 11. Risks

- **Refactoring a SEV-generating system while it runs.** Mitigated by the
  gate-per-phase structure and by never making v2 the default before its
  drill passes. The riskiest window is Phase 2's dispatch cutover; the local
  runtime IS the rollback.
- **Dispatch-path latency for reviews.** The pool's admission/lease path is
  heavier than a direct spawn. Measure in Phase 2; if review latency regresses
  past operator tolerance, pursue a priority/fast lane in the pool rather
  than retreating to bespoke spawns.
- **Resume-mode double work.** The reconcile-on-resume protocol (§6.3) is the
  designed control; the Phase 2 drill explicitly tests it.
- **Platform gaps stall the app.** Each GAP has a shim fallback so app
  progress never blocks on platform sequencing; shims are tracked debt.
- **Two registries drift** (role registry vs worker-classes). The role
  registry stores only worker-class *names*, validated against
  `hq`-published class lists at config load; it never duplicates class
  attributes.
