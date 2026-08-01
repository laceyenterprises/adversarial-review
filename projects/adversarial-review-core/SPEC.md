---
status: active
---

# Adversarial Review Core (ARC) — SPEC

## 1. Why this spec exists

Adversarial review works — and is load-bearing for the whole fleet — but it is
a GitHub-PR + CLI-spawn monolith. `watcher.mjs` (10,112 lines) hardcodes
`domainId: 'code-pr'` at ~12 sites; `reviewer.mjs` (4,946 lines) hardcodes its
prompt set and spawns claude/codex/gemini/agy CLIs directly, duplicating the
worker-pool's model resolution, auth handling, and CLI discovery; merge
authority (`src/ama/*`, ~10k lines) is distributed across cooperating actors
with implicit state and generates a steady stream of SEVs (phantom
die-before-merge, identity head-pin, ceiling+head-move deadlock, LHA premature
cutover). The declared kernel/adapter/domain architecture
(`tools/adversarial-review/docs/ARCH-adversarial-review-adapter-architecture.md`)
exists but production bypasses most of it.

ARC executes the operator-approved v2 design
(adversarial-review PRs #609 SPEC-adversarial-review-v2-app-architecture,
#610 SPEC-merge-authority-v2): finish the domain abstraction, route all agent
invocation through the OS worker pool behind a hybrid runtime with automatic
failover/resume, redesign merge authority as an event-sourced state machine
cut over in shadow mode, and make adversarial-review the **reference app** of
the Agent OS app paradigm. It supersedes the parked
`adversarial-review-adapter-refactor` (ARA, 2/18) pack and builds on the
landed AOM (orchestration-mode switch) and ARR (outage resilience) packs.

The 2026-08-01 SDK cutover audit proved the pack is not yet safe to treat as
"done". The SDK and hybrid-mode pieces now exist in Agent OS and
adversarial-review consumes the latest submodule, but production still selects
`cli-direct` for the `code-pr` domains, `orchestrationMode=agentos` still
falls to `agent-os-hq`, remediation still owns detached CLI spawns, clean
comment-only reviews can still produce misleading critical follow-up state,
alert delivery is failing to the local alert bus, branch-protection enforcement
is warning rather than closing the loop, and review dispatch/no-progress
latency is visible only after the operator reads logs. ARC-25..32 are the
cutover-readiness extension that converts those audit findings into the
remaining dispatchable work.

### First observable win

**Win 1 — hybrid runtime status (ARC-07/ARC-09):**

```text
$ node src/cli.mjs runtime status
mode: os            since: 2026-07-17T09:12:04Z
probe: healthy      (healthz ok, dispatch p95 412ms, sse live)
last failover: 2026-07-16T22:41:10Z -> local (3 probe failures)
last resume:   2026-07-17T09:12:04Z -> os    (6 healthy probes / 5m)
runs (24h): os=41 local=7   reconciled-on-resume: 2 adopted, 0 duplicated
fallback canary: PASS 2026-07-17T06:00:12Z (local fixture review, 94s)
```

**Win 2 — two-stage pipeline verdict rollup on a PR (ARC-13):**

```text
## Adversarial review — pipeline rollup (rev 4f2c9a1)
| stage         | reviewer role          | verdict         | round |
|---------------|------------------------|-----------------|-------|
| code-quality  | code-quality-reviewer  | comment-only    | 1/2   |
| security      | security-reviewer      | request-changes | 1/3   |
pipeline: BLOCKED at security — 2 blocking findings routed to remediation
```

**Win 3 — MA-v2 shadow divergence report (ARC-16):**

```text
$ node src/cli.mjs finalization shadow-report --days 7
shadowed finalizations: 23   agree: 21   diverge: 2
  #612 v1=merged          v2=wait(checks: required check missing)  [v1 defect: AR#550 class]
  #618 v1=hammer-dispatch v2=finalize-now (verdict@head clean)     [triage open]
verdict: NOT promotable (1 open divergence)
```

**Win 4 — SDK cutover readiness gate (ARC-32):**

```text
$ hq adversarial sdk-cutover check --repo laceyenterprises/agent-os --pr 4562
runtime: hybrid-sdk       reviewer: agent-runtime   remediation: agent-runtime
fallback: ready           standalone drill: pass     duplicate dispatches: 0
alerts: ready             sink: agent-gateway        last_delivery: 2026-08-01T14:07:02Z
branch gate: required     context: agent-os/adversarial-gate
dispatch p95: 12s         no-progress stale PRs: 0
verdict fidelity: pass    comment-only followups: 0 critical / 0 blocking
cutover: READY
```

## 2. Scope

**In:**
- v1 snapshot tag + maintenance branch; AMA freeze declaration (bug-fix-only).
- De-hardcoding domain/prompt-set wiring; multi-domain watcher loop; a second
  production domain (`code-pr-security`).
- AgentRuntime port: `os-dispatch` (app-contract dispatch, decision-only /
  branch-push completion shapes) as default; `local` spawn as first-class
  fallback; health router with automatic failover AND automatic resume;
  idempotency-key reconcile; fallback canary.
- Kernel pipeline contract (ordered stages, per-stage panels, aggregation
  policy — sequential two-stage now, parallel-capable contract).
- Role registry (config-owned reviewer/remediator roster; identity binding
  moved into comms adapter).
- Finalization port + merge-authority v2 (event-sourced fold, shadow-mode
  cutover per PR #610).
- Monolith decomposition (watcher → scheduler + kernel effects) with an
  import-boundary lint gate.
- Four OS platform surfaces (agent-os repo): adjudicate-merge app surface,
  app-facing ledger notes API, attestation read surface, app-sdk hybrid mode.
- SDK cutover-readiness extension: runtime default flip behind a hard
  readiness gate, remediator port unification, verdict/follow-up fidelity,
  durable alert sink, branch-protection repair, dispatch/no-progress SLOs,
  operator retrigger recovery, and one command that proves cutover readiness.

**Out:** see §5 Non-goals.

## 3. Phases and tickets

### Phase 0 — Snapshot and freeze

**ARC-01 — v1 snapshot, maintenance branch, AMA freeze marker.** Tag the
adversarial-review submodule HEAD as `v1-working-snapshot`, cut
`v1-maintenance`, record the fixture-e2e baseline (all existing domain fixture
tests green at the tag), and add a FREEZE note to `src/ama/` and
`docs/SPEC-merge-authority-v2.md` cross-reference stating v1 merge authority
is bug-fix-only. Tests: baseline fixture suite green at tag; freeze note lint
(grep gate) present.

### Phase 1 — De-hardcode (unlocks multiple reviewer types)

**ARC-02 — Thread promptSet from domain config.** Replace
`REVIEWER_PROMPT_SET`/`REMEDIATOR_PROMPT_SET` constants (`reviewer.mjs:1554`,
`follow-up-remediation.mjs:65`) with the domain's declared `promptSet`,
threaded through kernel `prompt-stage.mjs` (param already exists). Tests:
code-pr fixture parity (byte-identical prompts for code-pr); research-finding
fixture selects its own set; unknown promptSet fails loud.

**ARC-03 — De-hardcode domainId; watcher iterates the domain registry.**
Remove the ~12 hardcoded `domainId: 'code-pr'` sites in `watcher.mjs` and the
`identity-shapes.mjs` fallback; the watcher enumerates `domains/*.json` and
pumps each registered domain. code-pr remains the only registered production
domain after this ticket. Tests: code-pr behavior parity on fixtures;
two-domain fixture run proves per-domain adapter isolation.

**ARC-04 — Security review domain.** Add `domains/code-pr-security.json` +
`prompts/code-pr-security/` (reviewer+remediator, first/middle/last) with a
security-review rubric; registered behind a config gate, default off. Tests:
fixture e2e (review → remediation → re-review → converge) on the new domain;
prompt-set selection assertions.

### Phase 2 — Agent runtime port and hybrid failover

**ARC-05 — AgentRuntime port + local runtime implementation.** Define the
port (`run(request) → handle{await,cancel,reattach}`, structured
`RunResult`) in kernel contracts; implement `local` runtime as a refactor of
`cli-direct` (process-group isolation, forbidden-fallback stripping, failure
classification, run records) behind the port, including a local admission
layer (existing memory-pressure + quota gates + per-run caps). Tests: port
contract typecheck; local runtime fixture spawn/cancel/reattach; admission
refusal paths.

**ARC-06 — os-dispatch runtime implementation.** Implement the port against
the app-contract endpoint (`/v1/dispatch`, `dispatch_status`), reviews as
`task-kind review` + `completion-shape decision-only` with the verdict
returned as a structured artifact (`ReviewArtifact` schemaVersion 2);
remediation as `branch-push`. Builds on AOM's `agent-os-hq` seam. Tests:
stub-endpoint round-trip returning a verdict artifact; artifact schema
validation; dispatch idempotency key propagation.

**ARC-07 — Health router: automatic failover + automatic resume.** Probe
(healthz + dispatch-acceptance latency p95 + SSE liveness); OS-HEALTHY →
LOCAL-FALLBACK on k=3 consecutive failures or one hard contract error;
LOCAL-FALLBACK → OS on m=6 healthy probes across ≥5 minutes (hysteresis);
runs finish in the mode they started; on resume, reconcile idempotency keys
via `dispatch_status` (adopt, never re-issue); every transition emits
operator notice + audit row + telemetry event. Tests: state-machine unit
tests (flap resistance, hard-error fast path); reconcile adopts
accepted-but-unobserved dispatch in fixture; audit rows written.

**ARC-08 — Unify remediation dispatch through the port.** Collapse the two
forked remediation paths (`follow-up-remediation.mjs` self-spawn vs
legacy-hq-dispatch) into port calls; role/worker-class selection moves to the
role registry default (`remediator`). Tests: remediation fixture e2e via
both runtimes; forked-path code deleted (grep gate).

**ARC-09 — Fallback canary + failover drill.** Daily scheduled synthetic
review through the `local` runtime on a fixture domain, alerting on failure;
a drill script that kills OS endpoints, asserts failover, restores, asserts
resume + zero duplicate dispatches. Implements Win 1 (`runtime status`).
Tests: canary run in CI against fixtures; drill script in a sandboxed
fixture harness.

**ARC-10 — Delete bespoke harness code.** Remove `spawnClaude` /
`spawnCodexReview` / `spawnGeminiReview` / `spawnAgyReview` families and both
copies of model detection/token parsing (`reviewer.mjs`,
`adapters/reviewer-runtime/cli-direct`); reviewer.mjs shrinks to
prompt-assembly + artifact emission invoked by the runtimes. Tests: fixture
parity for review outputs; dead-code grep gate; line-count ratchet on
reviewer.mjs.

### Phase 3 — Pipeline, roles, finalization

**ARC-11 — Kernel pipeline contract.** Stages/panels/aggregation
(`unanimous-clean | any-blocking-blocks | quorum(n) | weighted`),
per-stage round budgets + subject-level ceiling, re-review = failed stage +
downstream, verdicts pinned to `revisionRef`; `SubjectState.pipeline[]` with
deprecated `latestVerdict` alias. Tests: contract typecheck; budget/ceiling
unit matrix; stage-invalidation on revision advance.

**ARC-12 — Role registry + comms identity binding.** `roles.registry` config
(role → promptSet/workerClass/taskKind/completionShape),
never-review-own-builder-class constraint; per-role bot identity moves from
`subject/github-pr/routing.mjs` into comms-adapter delivery config. Tests:
registry validation (unknown worker class fails at load against
hq-published class list); routing constraint fixtures; identity binding
delivery fixtures.

**ARC-13 — Sequential two-stage pipeline live.** `code-pr` domain gains
`pipeline: [code-quality, security]` behind a config gate; rollup comment
(Win 2); downstream re-review semantics proven. Tests: fixture e2e both
stages; remediation from stage-2 findings re-runs stage 2 only at same rev;
gate-off preserves v1 single-stage behavior.

**ARC-14 — Finalization port.** `evaluate(subjectState) →
FinalizationDecision` / `execute(decision)` contract; trivial implementations
for non-code domains (mark-terminal/archive); v1 AMA wrapped UNCHANGED behind
the port for code-pr (freeze holds — wrapper only, no behavior change).
Tests: port typecheck; trivial-impl fixtures; v1-wrapper parity fixtures.

**ARC-15 — MA-v2 finalization ledger + eligibility fold.** Append-only
per-subject event ledger (app store), pure `eligible(fold(events), policy)`
per PR #610 §2–3: revision_advanced ordinary event, provenance-carrying
facts, strict-mode/exhaustion-closes/all-comments policies as explicit
inputs, attestation consume-without-producer = config-validation error.
Tests: fold determinism property tests; replay-resume equivalence; the six
v1 failure classes as regression fixtures (each must produce a safe decision).

**ARC-16 — MA-v2 shadow mode + divergence telemetry.** v2 ingests live
events, logs decisions; (v1 action, v2 decision) pairs recorded; divergence
report CLI (Win 3); bidirectional triage doc. Tests: shadow harness on
recorded v1 traces; divergence classifier fixtures.

**ARC-17 — MA-v2 leased executor + promotion runbook.** Single leased
executor per subject; idempotent execute with re-fold guard; merge via
adjudicate surface (ARC-20) with github-adapter `pr-merge` local fallback;
promotion gate + one-flag rollback runbook. Ships **gated off** — promotion
is an operator action after the shadow gate clears. Tests: lease contention;
re-fold discard on world-move; execute idempotency; kill-switch fail-closed
audit.

### Phase 4 — Decomposition

**ARC-18 — Watcher decomposition.** `watcher.mjs` reduces to scheduler loop +
kernel effect execution; inline GitHub mechanics (fast-merge diff-shape, live
label/head reads, timeline scrape) move behind subject/comms adapters.
Tests: full fixture e2e parity; line-count ratchet (<2,000); no direct
GitHub/API imports outside adapters (lint).

**ARC-19 — Fold remaining monoliths + import-boundary gate.** Fold
`follow-up-remediation.mjs`/`follow-up-merge-agent.mjs` remnants into kernel
effects + adapters; add CI lint: kernel imports nothing from layers 3–5,
adapters never import review vocabulary upward. Tests: boundary lint red/green
fixtures; all v1 e2e fixtures pass unmodified.

### OS platform surfaces (agent-os repo)

**ARC-20 — Adjudicate-merge app surface (GAP-1).** Expose merge adjudication
(`hq adjudicate merge` semantics) through a sanctioned app surface
(app-contract workflow action wired to a real backend, or HCP route —
implementer picks with a short ADR), fail-closed, audited, idempotent.
Tests: surface contract tests; denied-without-entitlement; idempotent repeat.

**ARC-21 — App-facing ledger notes API (GAP-2).** Minimal append-only
notes/events write surface for registered apps (app-contract endpoint),
schema-validated, quota-bounded, with local-queue-and-flush client semantics
documented. Tests: endpoint contract tests; quota refusal; replay dedupe.

**ARC-22 — Attestation read surface (GAP-3).** Sanctioned read API for
reviewed/produced attestations replacing direct ledger SQLite reads
(adversarial-review's `session-ledger-read-adapter.mjs` is the target
consumer). Tests: contract tests; parity fixtures against direct-read
results.

**ARC-23 — app-sdk hybrid mode (GAP-4).** `mode: hybrid` in Node+Python SDKs
(probe/failover/resume semantics matching ARC-07), real SSE `on()` in
agent-os mode, packaging so external repos can consume the Node SDK. Tests:
SDK contract tests both languages; hybrid-mode state machine unit tests.

**ARC-24 — Consume published app-sdk; delete vendored fork.**
adversarial-review swaps `src/app-contract-dispatch.mjs` for the published
SDK (dep of ARC-23) inside the os-dispatch runtime; vendored client deleted.
Tests: os-dispatch fixtures green on SDK client; fork-file absence gate.

### Phase 5 — SDK cutover readiness extension

**ARC-25 — Runtime default cutover gate.** Replace the remaining
`cli-direct` production reviewer default with `agent-runtime` only behind a
truthful readiness gate: domain config, `orchestrationMode=agentos`, runtime
status, canary, and the `ADVERSARIAL_REVIEWER_RUNTIME` kill switch all agree.
The gate must refuse full cutover when hybrid fallback is degraded, and it must
record why. Tests: runtime-selection unit matrix; code-pr/code-pr-security
domain fixtures; settle smoke for agent-runtime; kill-switch rollback fixture.

**ARC-26 — Remediation AgentRuntime parity.** Finish the ARC-08 promise for
every remediator path, including the extracted Claude Code leaf and the Codex
and Gemini spawns still in `follow-up-remediation.mjs`: remediation requests go
through AgentRuntime branch-push handles with local fallback, preserving reply
landing pads, commit trailers, round accounting, OAuth stripping, and
reattach/cancel behavior. Tests: branch-push fixture through OS stub and local
runtime; grep gate proving direct `spawnDetachedCli` is absent from remediation
surfaces; v1 parity fixtures for budgets and replies.

**ARC-27 — Verdict and follow-up fidelity.** Make comment-only or approved
reviews with zero blocking findings settle cleanly: they must not create
critical follow-up jobs, critical Linear flags, high-priority recommended
actions, or misleading "critical review findings" prompt text. Blocking
findings still open remediation under the same strict posture. Tests:
comment-only/findings_count=0 fixture; request-changes/blocking fixture;
Linear triage adapter fixture; regression for current clean review on
`agent-os#4562`.

**ARC-28 — Alert sink durability.** Replace single-shot local HTTP alert
delivery with a durable, observable alert sink: delivery uses the Agent OS alert
bus config, records success/failure receipts, retries or queues locally when
`127.0.0.1:18799` is unavailable, and exposes a health/readiness signal that
fails before a page is silently lost. Tests: unavailable bus queues receipt;
recovered bus drains exactly once; config precedence for
`agent_gateway.alert_bus_url`; no-progress and hammer-cap alerts share the
same sink.

**ARC-29 — Branch-protection closeout.** Turn `agent-os/adversarial-gate`
warnings into an operator-closeable contract: audit all watched repos, apply or
prepare the required branch-protection context where credentials allow it,
persist forbidden/missing evidence per repo, and make autonomous merge refuse
the protected path when the configured domain requires branch protection but
the gate is not actually required. Tests: `check-branch-protection --json`;
missing/forbidden fixtures; AMA eligibility refusal; runbook for repos needing
manual GitHub admin action.

**ARC-30 — Dispatch no-progress and latency SLO.** Add first-class dispatch
acceptance latency and watcher no-progress SLOs for adversarial review:
receipt-to-spawn timing is recorded from HQ, p95 feeds the hybrid-router probe,
open pending PRs cannot sit past the SLO without a durable alert, and
post-merge/main-catchup wake hints reduce the several-minute idle window.
Tests: seeded dispatch ledger p95; watcher no-progress alert receipt;
main-catchup wake hint fixture; drain-status remains read-only and bounded.

**ARC-31 — Operator final re-review recovery.** Provide one audited operator
surface for "review this exact head now" that clears stale terminal state,
honors current-head idempotency, can intentionally bypass hard review ceiling
once, refuses active reviewers unless explicitly cancelled, and never requires
manual budget hacks or SQLite edits. Tests: hard-ceiling bypass fixture;
active-review refusal; stale follow-up stop and requeue fixture; audit ledger
idempotency.

**ARC-32 — End-to-end cutover drill and readiness report.** Ship the final
operator command and report that proves ARC can cut over: runtime default,
SDK/hybrid fallback, remediation branch-push, alert delivery, branch
protection, dispatch SLO, verdict fidelity, standalone fallback drill, and
live clean-PR closure are all checked in one bounded run. Tests: fixture drill;
JSON report schema; failure matrix for every ARC-25..31 gate; runbook update
declaring full SDK cutover blocked until this command returns READY.

## 4. Acceptance criteria

1. v1 tagged + maintenance branch exists; AMA freeze note in place (ARC-01).
2. Prompt set + domainId are domain-config-driven; zero hardcoded
   `'code-pr'` in orchestration paths (ARC-02, ARC-03).
3. A security-review domain reviews a fixture subject end-to-end with its own
   prompts (ARC-04).
4. Reviews and remediations dispatch through the OS by default and return
   structured artifacts; bespoke CLI spawn families deleted (ARC-05, ARC-06,
   ARC-08, ARC-10).
5. Killing OS endpoints fails the pipeline over automatically; restoring
   them resumes automatically with zero duplicated dispatches; `runtime
   status` reports mode/probe/canary truthfully (ARC-07, ARC-09).
6. Two-stage sequential pipeline (code-quality → security) converges on a
   fixture PR with correct budgets and downstream re-review (ARC-11..13).
7. v1 merge authority runs unchanged behind the finalization port; MA-v2
   produces shadow decisions and a divergence report; executor ships gated
   off with promotion runbook (ARC-14..17).
8. watcher.mjs < 2,000 lines; import-boundary lint enforced in CI; all v1
   fixtures pass unmodified (ARC-18, ARC-19).
9. All four OS surfaces live with contract tests; adversarial-review consumes
   the published SDK and the attestation surface instead of internal reaches
   (ARC-20..24).
10. `code-pr` and `code-pr-security` select the SDK-backed `agent-runtime`
    only when the hybrid fallback and status gate are healthy, with a fast
    operator kill switch back to standalone local mode (ARC-25).
11. All remediation worker dispatch goes through AgentRuntime branch-push
    handles; direct detached CLI spawns are absent from remediation surfaces
    (ARC-26).
12. Clean `Comment only` or `Approved` reviews with zero blocking findings do
    not generate critical jobs, critical Linear flags, or misleading follow-up
    prompts (ARC-27).
13. Watcher, hammer, freshness, and no-progress alerts have durable receipts
    and retry/queue semantics when the alert bus is unavailable (ARC-28).
14. Watched repos either require the resolved adversarial gate in branch
    protection or carry explicit forbidden/missing evidence that blocks
    autonomous merge where policy requires the gate (ARC-29).
15. Dispatch acceptance latency and watcher no-progress have SLO metrics,
    durable alerts, and wake hints; a clean reviewed PR cannot sit silently
    behind an idle loop (ARC-30).
16. Operators can request a final current-head re-review through one audited
    surface without budget hacks or state-file edits (ARC-31).
17. `hq adversarial sdk-cutover check` returns READY only when SDK operation,
    standalone fallback, observability, branch gate, verdict fidelity, and
    dispatch latency all pass (ARC-32).

## 5. Non-goals

- Changing review semantics (verdict grammar, reply schema, risk budgets).
- Promoting MA-v2 to executing authority (operator action post-shadow-gate,
  outside this pack).
- Parallel reviewer panels in production (contract supports; not enabled).
- Multi-host review fleets; non-GitHub subject domains beyond fixtures +
  the security domain.
- Rewriting ARR's watchdog/canary work or AOM's mode switch (built upon, not
  replaced).
- Making GitHub branch-protection changes without repo-admin credentials; the
  pack must produce exact commands/evidence for manual closeout where the token
  is forbidden.
- Promoting full SDK cutover before ARC-32 returns READY on the deploy host.

## 6. Risks and mitigations

- **Refactoring a live SEV-prone system.** Mitigation: every phase
  config-gated with v1 default until its gate passes (ARC-01 baseline;
  parity fixtures in ARC-02/03/10/14/18).
- **Dispatch-path latency regression for reviews.** Mitigation: ARC-07
  probes measure dispatch p95 continuously; local fallback is one failover
  away; if p95 exceeds operator tolerance, pursue a pool fast-lane before
  retreating (tracked in ARC-06 evidence).
- **Resume double-dispatch.** Mitigation: idempotency-key reconcile designed
  and drill-tested (ARC-07, ARC-09).
- **MA-v2 diverges unsafely.** Mitigation: shadow-only until operator
  promotion; six v1 failure classes as regression fixtures (ARC-15);
  fail-closed `escalate` on fold errors.
- **Platform gaps stall app tickets.** Mitigation: consumption tickets
  depend on surface tickets in the DAG; interim shims are explicitly
  named `os-shim-*` and removed by ARC-24/ARC-17.
- **Two registries drift (role registry vs worker classes).** Mitigation:
  ARC-12 validates role worker classes against hq-published class lists at
  config load.
- **Cutover silently regresses to the wrong runtime.** Mitigation: ARC-25
  makes runtime selection a tested matrix and keeps the env kill switch as a
  fast standalone fallback.
- **Alerts fail exactly when the pipeline is stuck.** Mitigation: ARC-28
  persists alert receipts and queues delivery until the bus recovers.
- **Clean reviews still produce noisy or blocking follow-up work.**
  Mitigation: ARC-27 ties criticality to structured blocking findings and
  findings counts, not the existence of any review body.
- **No-progress becomes a log-only symptom.** Mitigation: ARC-30 moves
  receipt-to-spawn latency and no-progress into SLO metrics and durable alerts.

## 7. Out-of-band dependencies

- adversarial-review PRs #609 and #610 (design specs) merged before ARC-05+
  dispatch (Phase 0–1 tickets do not depend on them).
- Operator keeps the hourly ARC drive loop running (session `d98ff59a`).
- app-contract endpoint bootstrap bearer provisioned for app_id
  `adversarial-review` on the build host (exists today; verify before
  ARC-06).
- Linear OAuth must be reauthenticated before minting LAC issues for
  ARC-25..32; the repo plan remains authoritative until the mapping sidecar is
  extended.

## 8. Ownership

Author + all ticket workers: **claude-code** (operator override 2026-07-16 —
"I want this as a claude-code author build pack", confirmed claude-code
workers for every ticket; supersedes the codex-default standing rule for this
pack). Adversarial review routes `[claude-code]` PRs to the codex reviewer
family, so no self-review occurs.

Cutover-readiness extension ARC-25..32: **codex** by ticket-level override
(operator follow-up 2026-08-01 after the SDK readiness audit). These tickets are
RCA/rescue work on the existing ARC pack, not a new TLA.

## 9. Boundaries

| New surface | Lives in | Reads from | Writes to |
|---|---|---|---|
| AgentRuntime port + runtimes | adversarial-review `src/kernel` + `src/adapters/agent-runtime/` | domain config, role registry | run records (app store) |
| Health router | adversarial-review `src/adapters/agent-runtime/router` | app-contract healthz/SSE | audit rows, operator notices |
| Pipeline contract | adversarial-review `src/kernel` | domain config | SubjectState (app store) |
| Role registry | adversarial-review config | hq worker-class list (validation) | — |
| Finalization port + MA-v2 | adversarial-review `src/kernel` + `src/finalization/` | verdicts, checks, attestations | finalization ledger (app store), merges via ARC-20 surface |
| Adjudicate surface | agent-os `platform/app-contract-endpoint` or `modules/hq-control-plane` | worker-pool adjudicate lib | merge execution, audit |
| Ledger notes API | agent-os `platform/app-contract-endpoint` | app registry | session-ledger notes |
| Attestation read surface | agent-os `platform/` (implementer ADR) | session ledger | — |
| app-sdk hybrid | agent-os `platform/app-sdk` | endpoint | — |
| SDK cutover gate | adversarial-review runtime adapters + agent-os app-sdk | domain config, runtime status, canary | readiness report, audit rows |
| Durable alert sink | adversarial-review alert delivery + Agent OS alert bus | CFG, gateway receipts | alert receipts/outbox |
| Dispatch SLO | worker-pool HQ + adversarial-review watcher | dispatch ledger, review DB | SLO metrics, alert receipts |

## 10. Naming notes

- TLA: **ARC** (Adversarial Review Core). call_sign `ARC`.
- Slug: `adversarial-review-core` (code, paths, HQ project id).
- Humans say "ARC" / "the v2 refactor". The submodule app keeps its repo name
  `adversarial-review`; "core"/"kernel" refers to layer 1 of the v2
  architecture.
- Supersedes: `adversarial-review-adapter-refactor` (ARA — marked superseded
  in this PR). Builds on: AOM, ARR. Companion design PRs:
  adversarial-review #609, #610.
