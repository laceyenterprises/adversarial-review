/**
 * Target contract surface for the auto-remediation kernel boundary.
 * Runtime modules only bind a subset of these shapes today; the
 * governing intent and rollout status are documented in
 * docs/SPEC-adversarial-review-auto-remediation.md.
 */
export type IsoTimestamp = string;

/**
 * Minimal JSON value/object aliases. The AgentRuntime port hands the app
 * artifact back as an opaque JSON object at the runtime boundary; the domain
 * adapter decodes it into a domain type (`Verdict`, `RemediationReply`, …)
 * before the kernel sees it.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export type PromptStage = 'first' | 'middle' | 'last';

export type ReviewVerdictKind = 'request-changes' | 'comment-only' | 'approved' | 'unknown';

export interface BlockingFinding {
  title?: string;
  file?: string;
  lines?: string;
  problem?: string;
}

export interface Verdict {
  kind: ReviewVerdictKind;
  body: string;
  summary?: string;
  blockingFindings?: readonly BlockingFinding[];
  observedAt?: IsoTimestamp;
  /**
   * Pipeline (§4.1): the revision this verdict reviewed — the GitHub
   * `commit_id` in the code-pr domain, never inferred from logs or current
   * head. A verdict is valid review evidence for a stage ONLY while its
   * `revisionRef` equals the subject's current `revisionRef`; any revision
   * advance invalidates it (see `stageVerdictAppliesToRevision`). Optional so
   * legacy single-verdict `SubjectState`s keep parsing; a verdict with no
   * `revisionRef` is treated as applying to no revision (fails safe toward
   * re-review).
   */
  revisionRef?: string;
  /** Pipeline: the stage that produced this verdict (panel attribution). */
  stageId?: string;
  /** Pipeline: the panel reviewer role that produced this verdict. */
  reviewerRoleId?: string;
}

export interface RemediationReplyAddressed {
  title?: string;
  finding: string;
  action: string;
  files?: readonly string[];
}

export interface RemediationReplyNonBlocking {
  title?: string;
  finding: string;
  action: string;
  files?: readonly string[];
}

export interface RemediationReplyPushback {
  title?: string;
  finding: string;
  reasoning: string;
}

export interface RemediationReplyBlocker {
  title?: string;
  finding: string;
  reasoning?: string;
  needsHumanInput?: string;
}

export interface RemediationReplyOperationalBlocker {
  title?: string;
  finding: string;
  reasoning?: string;
  needsHumanInput?: string;
}

export interface RemediationReply {
  kind: 'adversarial-review-remediation-reply';
  schemaVersion: 1;
  jobId: string;
  outcome: 'completed' | 'blocked' | 'partial';
  summary: string;
  validation: readonly string[];
  addressed?: readonly RemediationReplyAddressed[];
  pushback?: readonly RemediationReplyPushback[];
  // Non-blocking review findings that the worker chose to fix in this
  // round. Same per-entry shape as addressed[] but NOT counted toward
  // the blocking-coverage check; rendered in its own PR-comment section.
  nonBlocking?: readonly RemediationReplyNonBlocking[];
  // Legacy string blockers remain valid under schemaVersion 1 so older
  // persisted replies still parse during reconciliation. New producer
  // code should prefer structured RemediationReplyBlocker objects.
  blockers: readonly (string | RemediationReplyBlocker)[];
  // Operational blockers describe git/process failures (for example
  // branch contamination or stale PR head), not adversarial-review
  // findings. They do not count toward per-finding coverage.
  operationalBlockers?: readonly RemediationReplyOperationalBlocker[];
  reReview: {
    requested: boolean;
    reason?: string | null;
  };
}

export interface SubjectRef {
  domainId: string;
  subjectExternalId: string;
  revisionRef: string;
  linearTicketId?: string | null;
  labels?: readonly (string | { name?: string | null })[];
  ticketPipelinePaused?: boolean;
}

export type SubjectLifecycleState =
  | 'pending-review'
  | 'review-in-progress'
  | 'reviewed'
  | 'remediation-pending'
  | 'remediation-in-progress'
  | 'awaiting-rereview'
  | 'halted'
  | 'finalized'
  | 'terminal';

// ---------------------------------------------------------------------------
// Review pipeline contract (v2 app architecture §4.1–4.2)
//
// The single-verdict assumption is replaced by an ordered `Stage[]`. Each stage
// runs a `panel` of reviewer roles and folds their verdicts through an
// `AggregationPolicy`. Later stages gate on earlier ones: a stage runs only
// when every prior stage is clean at the current revision. Panel size 1 with
// `unanimous-clean` is behaviorally identical to the v1 single reviewer, so the
// contract enables sequential stages now and parallel panels later with no
// kernel rework. Only the contract + pure kernel logic land here (ARC-11);
// production two-stage enablement is ARC-13.
// ---------------------------------------------------------------------------

/**
 * How a stage folds its panel's verdicts into a single stage decision.
 * - `unanimous-clean`  — the stage is clean only when EVERY panel role is
 *   clean; any non-clean (blocking or indeterminate) role withholds the pass.
 * - `any-blocking-blocks` — the stage blocks as soon as ANY role blocks;
 *   indeterminate roles do not withhold the pass once every role has reported.
 * - `quorum`           — the stage is clean once `quorum` roles are clean; it
 *   blocks once a clean quorum is arithmetically unreachable.
 * - `weighted`         — clean once the summed `weights` of clean roles reach
 *   `threshold`; blocks once the reachable clean weight can no longer reach it.
 */
export type AggregationPolicyKind =
  | 'unanimous-clean'
  | 'any-blocking-blocks'
  | 'quorum'
  | 'weighted';

export interface AggregationPolicy {
  kind: AggregationPolicyKind;
  /** `quorum` policy: number of clean panel verdicts required to pass. */
  quorum?: number;
  /** `weighted` policy: per-role clean weight, keyed by `ReviewerRole.id`. */
  weights?: { [roleId: string]: number };
  /** `weighted` policy: summed clean weight required to pass. */
  threshold?: number;
}

/** Per-risk-class round budget for a single stage (one round = one review). */
export type RoundBudgetByRisk = { readonly [K in RiskClass]: number };

/**
 * A reviewer seat in a stage's panel. `id` is the registry role id (stable,
 * used for verdict attribution and `weighted` aggregation); `model` is the
 * optional harness/worker-class hint the runtime spawns.
 */
export interface ReviewerRole {
  id: string;
  model?: string;
}

/**
 * One ordered stage of the review pipeline. `panel` is the set of reviewer
 * roles that weigh in; `aggregation` folds their verdicts; `roundBudgetByRisk`
 * caps remediation rounds for THIS stage per the subject's risk class.
 */
export interface Stage {
  id: string;
  panel: readonly ReviewerRole[];
  aggregation: AggregationPolicy;
  roundBudgetByRisk: RoundBudgetByRisk;
}

/** An ordered review pipeline; later stages gate on earlier stages. */
export type ReviewPipeline = readonly Stage[];

// ---------------------------------------------------------------------------
// Role registry (v2 app architecture §5, ARC-12). A config-owned roster of
// reviewer / remediator roles that replaces the hardcoded `roles.reviewer`
// enum and the GitHub-fused `reviewerRouting` in `domains/code-pr.json`.
//
// A role names a WORKER CLASS or FOUNDRY PERSONA — never a binary, model id,
// CLI path, or token. Model resolution stays in the OS; per-role GitHub bot
// identity lives in the comms adapter's delivery config keyed by role id (see
// `adapters/comms/github-pr-comments/delivery-identity.mjs`). The kernel and
// the registry never see tokens. The v1 "reviewer must differ from builder
// class" rule survives as the `never-review-own-builder-class` routing
// constraint, evaluated kernel-side against `SubjectState.builderClass`
// (see `kernel/role-routing.mjs`).
// ---------------------------------------------------------------------------

/** What a role's agent run produces. */
export type RoleTaskKind = 'review' | 'remediation';

/**
 * The completion shape a role's dispatch expects: `decision-only` returns a
 * structured verdict artifact (reviews); `branch-push` writes a branch
 * (remediation).
 */
export type RoleCompletionShape = 'decision-only' | 'branch-push';

/**
 * One registry role. Exactly one of `workerClass` / `persona` is set:
 * `workerClass` is an OS worker-class name validated at load against the
 * hq-published class list; `persona` is a foundry persona id. No token, model
 * id, or CLI path ever appears here. Optional `priority` controls reviewer
 * fallback precedence: lower numbers run earlier, while equal or omitted
 * priorities preserve registry order.
 */
export interface RoleDefinition {
  id: string;
  promptSet: string;
  workerClass?: string;
  persona?: string;
  taskKind: RoleTaskKind;
  completionShape: RoleCompletionShape;
  priority?: number;
}

/** Registry routing constraints (builder-class exclusions only). */
export interface RoleRoutingPolicy {
  neverReviewOwnBuilderClass: boolean;
}

/** The loaded, validated role registry. */
export interface RoleRegistry {
  roles: { readonly [roleId: string]: RoleDefinition };
  routing: RoleRoutingPolicy;
}

/** The folded disposition of a single verdict or an aggregated stage. */
export type PipelineDisposition = 'clean' | 'blocking' | 'pending';

/**
 * Recorded evaluation of one stage against the subject's verdict history.
 * `panelVerdicts` holds every verdict observed for this stage (pinned to the
 * revision each reviewed); `stageIndex` is the stage's 0-based position in the
 * pipeline. Replaces the single `latestVerdict` on `SubjectState`.
 */
export interface StageState {
  stageId: string;
  stageIndex: number;
  panelVerdicts: readonly Verdict[];
}

/**
 * The subject-level remediation budget resolved from the pipeline and risk
 * class. `perStage` is each stage's round budget; `ceiling` is the capped
 * subject-level total so multi-stage pipelines do not multiply hammer cycles.
 */
export interface RemediationBudgetPlan {
  riskClass: RiskClass;
  perStage: readonly { stageId: string; roundBudget: number }[];
  ceiling: number;
  ceilingSource: 'sum-capped' | 'override';
}

export interface SubjectState {
  ref: SubjectRef;
  lifecycle: SubjectLifecycleState;
  title?: string;
  authorRef?: string;
  builderClass?: string;
  labels?: readonly string[];
  updatedAt?: IsoTimestamp;
  headSha?: string;
  riskClass?: RiskClass;
  currentRound: number;
  completedRemediationRounds: number;
  maxRemediationRounds: number;
  /**
   * Pipeline (§4.2): per-stage verdict history. Optional so legacy
   * single-verdict states keep parsing during migration; when present it is
   * the source of truth and `latestVerdict` is the deprecated alias below.
   */
  pipeline?: readonly StageState[];
  /**
   * @deprecated Superseded by `pipeline[]`. Kept as a compatibility alias that
   * resolves to the newest current-revision verdict of the active stage (see
   * `resolveLatestVerdict`). A populated pipeline with only stale verdicts
   * resolves to no verdict. New code should read `pipeline[]`.
   */
  latestVerdict?: Verdict;
  latestRemediationReply?: RemediationReply;
  terminal: boolean;
  observedAt: IsoTimestamp;
  haltReason?: string;
}

export interface SubjectContent {
  ref: SubjectRef;
  representation: string;
  contextFiles?: readonly string[];
  observedAt: IsoTimestamp;
}

export interface SubjectContext {
  domainId: string;
  subjectExternalId?: string;
  revisionRef?: string | null;
  repo?: string;
  prNumber?: number;
  reviewerModel?: string;
  botTokenEnv?: string;
  linearTicketId?: string | null;
  builderTag?: string;
  reviewerHeadSha?: string | null;
  reviewAttemptNumber?: number;
  completedRemediationRounds?: number;
  maxRemediationRounds?: number;
  reviewerSessionUuid?: string;
  agentRoleKind?: 'reviewer' | 'remediator';
  labels?: readonly (string | { name?: string | null })[];
  ticketPipelinePaused?: boolean;
  crossModelReviewWaived?: boolean;
  crossModelReviewWaiverReason?: string | null;
}

export interface RemediationWorkspace {
  ref: SubjectRef;
  workspacePath: string;
  instructions?: readonly string[];
  preparedAt: IsoTimestamp;
}

export interface RemediationCommitMetadata {
  ref: SubjectRef;
  commitExternalId: string;
  revisionRef: string;
  parentRevisionRef?: string;
  summary?: string;
  authorRef?: string;
  committedAt: IsoTimestamp;
  changedPaths?: readonly string[];
  validation?: readonly string[];
}

export interface SubjectChannelAdapter {
  discoverSubjects(): Promise<readonly SubjectRef[]>;
  fetchState(ref: SubjectRef): Promise<SubjectState>;
  fetchContent(ref: SubjectRef): Promise<SubjectContent>;
  prepareRemediationWorkspace(ref: SubjectRef, jobId: string): Promise<RemediationWorkspace>;
  recordRemediationCommit(ref: SubjectRef, commit: RemediationCommitMetadata): Promise<SubjectState>;
  finalizeSubject(ref: SubjectRef): Promise<SubjectState>;
  isTerminal(ref: SubjectRef): Promise<boolean>;
}

export type DeliveryKind = 'review' | 'remediation-reply' | 'operator-notice';

export interface DeliveryKey {
  domainId: string;
  subjectExternalId: string;
  revisionRef: string;
  round: number;
  kind: DeliveryKind;
  noticeRef?: string;
}

export interface DeliveryReceipt {
  key: DeliveryKey;
  deliveryExternalId: string;
  deliveredAt: IsoTimestamp;
}

export interface DeliveryRecord extends DeliveryReceipt {
  attemptedAt: IsoTimestamp;
  delivered: boolean;
  failureReason?: string;
}

export interface CommsChannelAdapter {
  postReview(verdict: Verdict, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>;
  postRemediationReply(reply: RemediationReply, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>;
  postOperatorNotice(event: OperatorEvent, body: string, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>;
  lookupExistingDeliveries(deliveryKey: DeliveryKey): Promise<readonly DeliveryRecord[]>;
}

export type OperatorEventType =
  | 'force-rereview'
  | 'operator-approved'
  | 'halted'
  | 'raised-round-cap';

export interface OperatorEvent {
  type: OperatorEventType;
  subjectRef: SubjectRef;
  revisionRef: string;
  eventExternalId?: string;
  actorRef?: string;
  observedAt: IsoTimestamp;
  reason?: string;
  roundCap?: number;
}

export interface OperatorOverrideSet {
  subjectRef: SubjectRef;
  expectedRevisionRef: string;
  observedRevisionRef: string;
  forceRereview: boolean;
  operatorApproved: boolean;
  halted: boolean;
  raisedRoundCap?: number;
  events: readonly OperatorEvent[];
  observedAt: IsoTimestamp;
}

export type TriageStatus =
  | 'pending-review'
  | 'in-review'
  | 'changes-requested'
  | 'remediation-running'
  | 'awaiting-rereview'
  | 'approved'
  | 'halted'
  | 'finalized';

export interface ReviewerEngagementAttempt {
  subjectRef: SubjectRef;
  revisionRef: string;
  attemptNumber: number;
  reviewerClass: string;
  stage: PromptStage;
  verdict?: Verdict;
  startedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
}

export interface OperatorControls {
  observeOverrides(subjectRef: SubjectRef, currentRevisionRef: string): Promise<OperatorOverrideSet>;
}

export interface OperatorTriageSync {
  syncTriageStatus(subjectRef: SubjectRef, status: TriageStatus): Promise<void>;
  recordReviewerEngagement(subjectRef: SubjectRef, attempt: ReviewerEngagementAttempt): Promise<void>;
}

export interface OperatorSurfaceAdapter extends OperatorControls, OperatorTriageSync {}

export type ReviewerFailureClass =
  | 'cascade'
  | 'reviewer-timeout'
  | 'reviewer-output'
  | 'rate-limit'
  | 'queue-back-pressure'
  | 'forbidden-fallback'
  | 'oauth-broken'
  | 'daemon-bounce'
  | 'lease-expired'
  | 'launchctl-bootstrap'
  | 'local-admission-refused'
  | 'bug'
  | 'unknown';

export type AgentFailureClass =
  | Exclude<ReviewerFailureClass, 'reviewer-timeout'>
  | 'timeout';

export interface AdapterCapabilities {
  processGroupIsolation: boolean;
  daemonBounceSafe: boolean;
  heartbeatPersisted: boolean;
  leaseManaged: boolean;
  oauthStripEnforced: boolean;
}

export interface ReviewerRunRequest {
  model: 'claude' | 'codex' | string;
  prompt: string;
  subjectContext: SubjectContext;
  timeoutMs: number;
  sessionUuid: string;
  forbiddenFallbacks: readonly string[];
  tokenBudget?: number | string | null;
}

export interface ReviewerRunResult {
  ok: boolean;
  reviewBody: string | null;
  failureClass: ReviewerFailureClass | null;
  stderrTail: string | null;
  stdoutTail: string | null;
  exitCode: number | null;
  signal: string | null;
  pgid: number | null;
  spawnedAt: IsoTimestamp;
  reattachToken: string | null;
}

export interface RemediatorRunRequest {
  model: 'claude-code' | 'codex' | string;
  prompt: string;
  subjectContext: SubjectContext;
  timeoutMs: number;
  sessionUuid: string;
  forbiddenFallbacks: readonly string[];
  tokenBudget?: number | string | null;
  workspacePath?: string;
}

export interface RemediatorRunResult {
  ok: boolean;
  remediationBody: string | null;
  failureClass: ReviewerFailureClass | null;
  stderrTail: string | null;
  stdoutTail: string | null;
  exitCode: number | null;
  signal: string | null;
  pgid: number | null;
  spawnedAt: IsoTimestamp;
  reattachToken: string | null;
}

export type ReviewerRunState =
  | 'spawned'
  | 'heartbeating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ReviewerRunRecord {
  sessionUuid: string;
  domain: string;
  runtime: string;
  state: ReviewerRunState;
  pgid: number | null;
  spawnedAt: IsoTimestamp;
  lastHeartbeatAt: IsoTimestamp | null;
  reattachToken: string | null;
}

export interface ReviewerRuntimeAdapter {
  spawnReviewer(req: ReviewerRunRequest): Promise<ReviewerRunResult>;
  spawnRemediator(req: RemediatorRunRequest): Promise<RemediatorRunResult>;
  cancel(sessionUuid: string): Promise<void>;
  reattach(record: ReviewerRunRecord): Promise<ReviewerRunResult>;
  describe(): { id: string; modelFamily: string; capabilities: AdapterCapabilities };
}

// ---------------------------------------------------------------------------
// AgentRuntime port (v2 app architecture §6.1)
//
// The altitude fix: `ReviewerRuntimeAdapter` above abstracts *process
// supervision of a monolith* — which never captured "which agent runs". The
// AgentRuntime port abstracts the agent run itself. Two Layer-5 impls plug in
// behind it: `os-dispatch` (primary, through the app contract) and `local`
// (the first-class outage-lifeline descended from cli-direct). Only the
// `local` impl ships in ARC-05; the watcher is wired to the port in ARC-06/07.
// ---------------------------------------------------------------------------

export type RuntimeMode = 'os' | 'local';

export type AgentRunStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

export type AgentRoleKind = 'reviewer' | 'remediator';

/**
 * The agent role to run. `model` is the harness/worker-class string the local
 * runtime spawns (`claude`, `codex`, `gemini`, …); `forbiddenFallbacks` are the
 * additive OAuth-strip aliases beyond the canonical set (see the local
 * runtime's env-strip enforcement).
 */
export interface AgentRole {
  id: string;
  kind: AgentRoleKind;
  model: string;
  forbiddenFallbacks?: readonly string[];
}

/**
 * Per-run token/time cap the caller requests. The local runtime's admission
 * layer refuses any request whose requested budget exceeds the conservative
 * local cap, because local mode bypasses OS admission and budget enforcement.
 */
export interface AgentRunBudget {
  maxTokens?: number | null;
  maxWallMs?: number | null;
}

/**
 * A prepared workspace for a write-capable role (e.g. the remediator's
 * `branch-push`). Reviewers run without a workspace.
 */
export interface WorkspaceRef {
  workspacePath: string;
  revisionRef?: string;
}

export interface AgentUsage {
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  total?: number | null;
  source?: string;
  [key: string]: JsonValue | undefined;
}

export interface AgentRunRequest {
  role: AgentRole;
  promptSet: string;
  promptStage: PromptStage;
  subjectContent: SubjectContent;
  workspaceRef?: WorkspaceRef;
  idempotencyKey: string;
  budget?: AgentRunBudget;
  timeoutMs: number;
}

export interface RunResult<AppArtifact = JsonObject> {
  status: AgentRunStatus;
  artifact?: AppArtifact;
  failureClass?: AgentFailureClass | null;
  usage?: AgentUsage | null;
  runtimeMode?: RuntimeMode;
  // Human-readable failure/refusal detail (admission reason, stderr tail, …).
  detail?: string | null;
}

/**
 * A live (or settled) agent run. `await()` resolves the structured
 * `RunResult`; `cancel()` requests best-effort termination; `reattach()`
 * re-adopts the run from its durable record after a kernel restart.
 */
export interface AgentRunHandle<AppArtifact = JsonObject> {
  runRef: string;
  mode: RuntimeMode;
  await(): Promise<RunResult<AppArtifact>>;
  cancel(): Promise<void>;
  reattach(): Promise<RunResult<AppArtifact>>;
}

export interface AgentRuntime<AppArtifact = JsonObject> {
  run(request: AgentRunRequest): Promise<AgentRunHandle<AppArtifact>>;
  describe(): { id: string; mode: RuntimeMode; capabilities: AdapterCapabilities };
}

// ---------------------------------------------------------------------------
// Finalization port (v2 app architecture Phase 3; merge-authority-v2 §3–4)
//
// The finalization port isolates "decide and act on finalization" behind one
// seam so Merge Authority v2 (ARC-15/16) can be built and shadowed WITHOUT
// touching frozen v1 merge authority (the ARC-01 freeze). `evaluate(subjectState)
// → FinalizationDecision` is the pure decision over a subject's review outcome;
// `execute(decision) → FinalizationOutcome` performs — or, for code-pr,
// delegates to unchanged v1 AMA — the resulting action. Non-code domains get
// trivial finalizers (`mark-terminal` / `archive`); code-pr is v1 AMA wrapped
// UNCHANGED behind this port (wrapper only, zero behavior change).
//
// The decision vocabulary is the autonomous subset of merge-authority-v2 §3
// (`docs/SPEC-merge-authority-v2.md`). `close(reason)` is intentionally absent:
// the v2 policy reserves it for operator override, never emitting it from an
// autonomous fold. MA-v2 (ARC-15) adds it to the ledger fold, not to this port.
// ---------------------------------------------------------------------------

/**
 * The autonomous finalization decision vocabulary (merge-authority-v2 §3).
 * - `finalize-now` — the subject is finalization-eligible; the executor performs
 *   the terminal action (code-pr: merge; trivial domains: mark-terminal / archive).
 * - `remediate`    — outstanding findings with remediation budget remaining (or
 *   the exhaustion final round); dispatch a remediation round.
 * - `wait`         — eligibility is not yet determinable (verdict/checks/
 *   attestations pending); poll again, bounded by `deadline`.
 * - `halt`         — finalization is blocked in a way that needs a human
 *   (operator halt, or coverage operationally impossible); pages, never merges.
 * - `escalate`     — fail-closed outcome (fold error, kill switch, deadline
 *   expiry); recorded and terminal until an operator override.
 */
export type FinalizationDecisionKind =
  | 'finalize-now'
  | 'remediate'
  | 'wait'
  | 'halt'
  | 'escalate';

export interface FinalizationDecision {
  kind: FinalizationDecisionKind;
  /** The subject this decision concerns — provenance for the executor + shadow diff. */
  subjectRef: SubjectRef;
  /**
   * The revision the decision was folded at (merge-authority-v2 §2: "verdict at
   * head" is verified by construction). A decision is stale — and must be
   * re-evaluated rather than executed — once the subject advances past it.
   */
  revisionRef: string;
  /**
   * Human/audit-facing reason. Populated for `wait` / `halt` / `escalate` (why
   * the port is not finalizing); optional for `finalize-now` / `remediate`.
   */
  reason?: string;
  /** `remediate`: the stage whose findings drive the round (panel attribution). */
  stageId?: string;
  /** `remediate`: the 1-based remediation round this decision dispatches. */
  round?: number;
  /** `wait`: the bounded deadline after which patience expires (→ `escalate`). */
  deadline?: IsoTimestamp;
  observedAt: IsoTimestamp;
}

/**
 * The disposition of executing a decision. `execute` is idempotent
 * (merge-authority-v2 §4): a decision whose action was already taken, or a
 * subject that already moved, resolves to `skipped` rather than re-acting.
 * - `executed` — the terminal/mutating action completed.
 * - `deferred` — the action was declined for now (e.g. not yet merge-eligible);
 *   re-evaluate on the next tick.
 * - `skipped`  — no action was required (a non-mutating decision, or an
 *   already-terminal subject).
 * - `failed`   — the action was attempted and failed (fail-closed).
 */
export type FinalizationActionStatus = 'executed' | 'deferred' | 'skipped' | 'failed';

export interface FinalizationOutcome {
  decision: FinalizationDecision;
  status: FinalizationActionStatus;
  /**
   * The concrete action taken or attempted: `merge`, `mark-terminal`,
   * `archive`, `dispatch-remediation`, `escalate`, or `none`.
   */
  action: string;
  detail?: string;
  observedAt: IsoTimestamp;
}

/**
 * The finalization port for one domain. `evaluate` is a pure decision over the
 * subject's review outcome (no I/O, deterministic in `subjectState`); `execute`
 * performs or delegates the action for a decision. Implementations:
 * `createTrivialFinalizer` (non-code) and `createV1AmaFinalizationPort` (code-pr,
 * wrapping unchanged v1 AMA).
 */
export interface FinalizationPort {
  readonly domainId: string;
  evaluate(subjectState: SubjectState): FinalizationDecision | Promise<FinalizationDecision>;
  execute(decision: FinalizationDecision): FinalizationOutcome | Promise<FinalizationOutcome>;
}

// ---------------------------------------------------------------------------
// Merge Authority v2 finalization ledger + eligibility fold (ARC-15;
// docs/SPEC-merge-authority-v2.md §2–3)
//
// The six v1 merge-authority failure classes share one root: merge authority
// distributed across cooperating actors whose shared state is implicit. v2
// replaces that with ONE durable state machine per subject: an append-only
// event ledger (`FinalizationEvent[]`) and a PURE fold. `eligible(fold(events),
// policy) → EligibilityDecision`; no actor "decides to merge" — the fold does,
// and actors only append observations. Head-move is an ordinary event; every
// external fact carries its `sourceRef` provenance; time enters the fold only as
// event `at`. Implemented in `src/finalization/ledger-events.mjs`,
// `ledger-fold.mjs`, `eligibility.mjs`, `ledger-store.mjs`.
// ---------------------------------------------------------------------------

/** The subject identity every ledger row and fold projection is keyed on. */
export interface SubjectKey {
  domainId: string;
  subjectExternalId: string;
}

/** The append-only event vocabulary (merge-authority-v2 §2). */
export type FinalizationEventType =
  | 'revision_advanced'
  | 'verdict_recorded'
  | 'checks_settled'
  | 'attestation_recorded'
  | 'remediation_dispatched'
  | 'remediation_concluded'
  | 'budget_exhausted'
  | 'operator_override'
  | 'finalized'
  | 'closed'
  | 'escalated'
  | 'halted';

/**
 * One appended ledger observation. `at` is the event time (the ONLY way time
 * enters the pure fold). External-fact events (`verdict_recorded`,
 * `checks_settled`, `attestation_recorded`) carry a mandatory `sourceRef`
 * provenance (review commit_id, check-run id, …). `seq` is assigned by the store
 * on append and defines replay order; it is absent on freshly constructed events.
 */
export interface FinalizationEvent {
  type: FinalizationEventType;
  subjectKey: SubjectKey;
  at: IsoTimestamp;
  seq?: number;
  /** Revision-scoped events pin their revision; subject-scoped events omit it. */
  revisionRef?: string;
  /** Provenance of an external fact (required on verdict/checks/attestation events). */
  sourceRef?: string;
  /** `verdict_recorded`. */
  stageId?: string;
  role?: string;
  verdictKind?: ReviewVerdictKind;
  /** `checks_settled`. */
  conclusion?: string;
  requiredChecksPresent?: boolean;
  /** `attestation_recorded`. */
  kind?: string;
  principal?: string;
  /** `remediation_dispatched` / `remediation_concluded`. */
  round?: number;
  idempotencyKey?: string;
  outcome?: string;
  final?: boolean;
  /** `operator_override`. */
  overrideKind?: string;
  reason?: string;
  roundCap?: number;
  /** `finalized`. */
  method?: string;
}

/** Per-revision projection the fold maintains. */
export interface LedgerRevisionState {
  verdicts: { stageId: string; role: string; verdictKind: ReviewVerdictKind; sourceRef: string; at: IsoTimestamp }[];
  checks: { conclusion: string; requiredChecksPresent: boolean; sourceRef: string; at: IsoTimestamp } | null;
  attestations: { kind: string; principal: string; sourceRef: string; at: IsoTimestamp }[];
  revisionAdvancedAt: IsoTimestamp | null;
}

/** Per-stage projection: budget exhaustion + counted remediation rounds. */
export interface LedgerStageState {
  budgetExhausted: boolean;
  budgetExhaustedAt: IsoTimestamp | null;
  dispatchedRounds: number;
  concludedRounds: number;
}

/** A terminal mark (finalized/closed/escalated/halted) in the projection. */
export interface LedgerTerminalState {
  kind: 'finalized' | 'closed' | 'escalated' | 'halted';
  reason?: string;
  method?: string;
  revisionRef?: string;
  at: IsoTimestamp;
}

/**
 * The pure projection of a subject's ledger (`fold(events)`). Everything
 * `eligible` needs: the current revision, per-revision verdicts/checks/
 * attestations, per-stage budget, remediation history, operator overrides, and
 * the terminal mark. `terminal` is the most recent UNRESOLVED mark (a resuming
 * operator override clears escalated/halted); `finalized` is sticky.
 */
export interface LedgerState {
  subjectKey: SubjectKey | null;
  eventCount: number;
  lastEventAt: IsoTimestamp | null;
  currentRevision: string | null;
  revisions: { [revisionRef: string]: LedgerRevisionState };
  stages: { [stageId: string]: LedgerStageState };
  remediation: {
    dispatched: { revisionRef: string; round: number; idempotencyKey: string; stageId: string | null; final: boolean; at: IsoTimestamp }[];
    concluded: { revisionRef: string; round: number; outcome: string; stageId: string | null; at: IsoTimestamp }[];
  };
  operatorOverrides: { overrideKind: string; principal: string; reason: string; roundCap: number | null; revisionRef: string | null; at: IsoTimestamp }[];
  terminal: LedgerTerminalState | null;
  finalized: LedgerTerminalState | null;
}

/** A configured attestation producer the fold waits on when consuming. */
export interface AttestationProducer {
  principal: string;
  kind: string;
}

/**
 * The versioned eligibility policy (merge-authority-v2 §3). Every input is
 * explicit. `consumeAttestations` with an empty `attestationProducers` is a
 * config-validation error at load (`normalizePolicy` throws).
 */
export interface EligibilityPolicy {
  policyVersion: number;
  strictMode: boolean;
  exhaustionAlwaysCloses: boolean;
  allCommentsBeforeMerge: boolean;
  consumeAttestations: boolean;
  attestationProducers: readonly AttestationProducer[];
  checksPatienceMs: number;
  verdictPatienceMs: number;
  attestationPatienceMs: number;
  /** Kill switch: autonomous execution disabled ⇒ every mutating decision escalates. */
  autonomousExecutionDisabled: boolean;
}

/**
 * The full merge-authority-v2 §3 decision vocabulary — the autonomous
 * finalization port's five kinds PLUS `close`, which the fold emits ONLY on an
 * `operator_override` directing rejection.
 */
export type EligibilityDecisionKind =
  | 'finalize-now'
  | 'remediate'
  | 'close'
  | 'wait'
  | 'halt'
  | 'escalate';

/** The single decision `eligible` returns for the executor (ARC-17) to act on. */
export interface EligibilityDecision {
  kind: EligibilityDecisionKind;
  subjectKey: SubjectKey | null;
  revisionRef: string;
  observedAt: IsoTimestamp | null;
  reason?: string;
  stageId?: string;
  round?: number;
  deadline?: IsoTimestamp;
  /** `remediate`/`finalize-now`: this is the exhaustion final coverage-gated round. */
  final?: boolean;
}

// ---------------------------------------------------------------------------
// Merge Authority v2 shadow mode (ARC-16; merge-authority-v2 §5). v2 ingests the
// live ledger and LOGS decisions WITHOUT acting, next to what frozen v1 actually
// did; every `(v1 action, v2 decision)` pair is recorded with a bidirectional
// divergence classification that feeds the operator promotion gate.
// ---------------------------------------------------------------------------

/** The normalized vocabulary for what frozen v1 did on a finalization tick. */
export type ShadowV1ActionKind =
  | 'merged'
  | 'hammer-dispatch'
  | 'remediate'
  | 'wait'
  | 'close'
  | 'escalate'
  | 'halt'
  | 'none';

/** The v1 half of a shadow pair: what v1 did, plus optional provenance. */
export interface ShadowV1Action {
  kind: ShadowV1ActionKind;
  detail?: string;
  sourceRef?: string;
}

/**
 * The bidirectional triage of a shadow pair. `relation` is whether the two
 * systems concur. `direction` proposes attribution — `open` is the only one that
 * blocks promotion; a human override in the store may supersede it. v1 is the
 * known-buggy system, but a divergence is evidence, not an automatic v1 defect.
 */
export interface DivergenceClassification {
  relation: 'agree' | 'diverge';
  direction: 'v1-defect' | 'v2-suspect' | 'open' | 'benign';
  /** e.g. 'ci-impatience', 'ceiling-head-move-deadlock', 'unclassified', 'fold-error'. */
  class: string | null;
  /** An external reference for a known v1 failure family (e.g. 'AR#550', 'HCM-01'). */
  ref?: string | null;
  disposition: 'resolved' | 'open';
  reason: string;
}

/** A human's overriding triage disposition recorded on an observation (§5.2). */
export interface ShadowDispositionOverride {
  disposition: 'resolved' | 'open';
  note?: string;
  principal?: string;
  at: IsoTimestamp;
}

/** One recorded shadow tick: the `(v1 action, v2 decision)` pair + its triage. */
export interface ShadowObservation {
  id?: number;
  subjectKey: SubjectKey;
  revisionRef: string;
  /** Tick time the report windows on. The decision itself never reads a clock. */
  observedAt: IsoTimestamp;
  v1Action: ShadowV1Action;
  v2Decision: EligibilityDecision;
  classification: DivergenceClassification;
  /** True when the fold errored / the ledger was unavailable — v2 failed closed to escalate. */
  foldError: boolean;
  /** Organic-observation markers the promotion gate (§5.3) counts. */
  sawHeadMove: boolean;
  sawExhaustion: boolean;
  dispositionOverride?: ShadowDispositionOverride | null;
}

/** The model `finalization shadow-report` renders (SPEC §1 Win 3). */
export interface ShadowReportModel {
  now: IsoTimestamp;
  windowDays: number;
  window: { from: IsoTimestamp; to: IsoTimestamp };
  shadowed: number;
  agree: number;
  diverge: number;
  divergences: {
    id: number | null;
    subjectExternalId: string;
    label: string;
    revisionRef: string;
    v1: ShadowV1ActionKind | string;
    v1Detail: string | null;
    v2: EligibilityDecisionKind | string;
    v2Compact: string;
    direction: DivergenceClassification['direction'];
    class: string | null;
    ref: string | null;
    reason: string;
    disposition: 'resolved' | 'open';
    overridden: boolean;
    tag: string;
  }[];
  organicHeadMoves: number;
  exhaustionCloses: number;
  coverage: { earliestObservedAt: IsoTimestamp | null; coverageDays: number; enoughDays: boolean };
  openDivergences: number;
  promotable: boolean;
  blockers: string[];
}

// ---------------------------------------------------------------------------
// Merge Authority v2 leased executor (ARC-17; docs/SPEC-merge-authority-v2.md §4)
//
// The last piece of MA-v2: the single finalization worker per subject that turns
// the pure `eligible(...)` decision into an action. It is leased (one writer per
// subject, lease in the app store — never GitHub labels), idempotent (re-fold
// guard + `matchHeadCommit` + terminal short-circuit), and fail-closed (kill
// switch intercepts every mutating decision before any adapter and writes an
// `escalated` audit event). It SHIPS GATED OFF (`enabled:false`) until an
// operator promotes it on shadow evidence — see the promotion runbook.
// Implemented in `src/finalization/executor-lease-store.mjs`,
// `execution-surfaces.mjs`, and `executor.mjs`.
// ---------------------------------------------------------------------------

/** The app-store lease that serializes finalization execution to one writer per subject. */
export interface FinalizationExecutorLease {
  subjectKey: SubjectKey;
  /** Opaque per-acquisition fence token; release/renew must present it exactly. */
  leaseId: string;
  /** Opaque holder identity (e.g. `pid@host` or a worker id) for diagnostics. */
  holder: string;
  /** The revision the holder acquired the lease to act on. */
  revisionRef: string | null;
  acquiredAt: IsoTimestamp;
  /** After this, a contender may steal the lease (a live holder renews instead). */
  deadline: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** The result of an acquire attempt: taken (fresh/stolen), or held by another. */
export interface FinalizationLeaseAcquireResult {
  acquired: boolean;
  lease: FinalizationExecutorLease | null;
  /** `inserted` | `stolen` when acquired; `held` when another holder is live. */
  reason: string;
  /** The live holder when `acquired:false`. */
  existing: FinalizationExecutorLease | null;
}

/**
 * The disposition of an executor tick / execute. Reuses the finalization port's
 * status vocabulary: `executed` (the mutation completed), `deferred` (declined
 * for now — lease contended, world moved, gated off, or a `wait`), `skipped` (no
 * mutation required — already terminal, or a recorded escalate/halt), `failed`
 * (attempted and failed, fail-closed).
 */
export interface FinalizationExecutionOutcome {
  subjectKey: SubjectKey;
  decision: EligibilityDecision;
  status: FinalizationActionStatus;
  /**
   * The concrete action taken/attempted: `merge`, `dispatch-remediation`,
   * `close`, `escalate`, `halt`, `re-decide`, `lease-contended`, `gated-off`,
   * or `none`.
   */
  action: string;
  reason?: string;
  detail?: string;
  /** True when the kill switch intercepted a mutating decision (fail-closed audit). */
  killSwitch?: boolean;
  observedAt: IsoTimestamp;
}

/**
 * The merge seam the executor performs through: the ARC-20 adjudicate surface in
 * production, with a github-adapter `pull-request-merge` local-mode fallback.
 * `ok:false` fails closed (no `finalized` mark is written; the next tick retries).
 */
export interface FinalizationMergeSurface {
  name?: string;
  merge(args: {
    subjectKey: SubjectKey;
    subjectExternalId: string;
    revisionRef: string;
    mergeMethod: string;
  }): Promise<{ ok: boolean; reason?: string; detail?: string; via?: string; payload?: unknown }>;
}

/**
 * The identity/attestation seam (ARC-22), read-through and fail-closed. A present
 * surface is authoritative — its `{ ok:false }` (or a throw) blocks the merge; its
 * absence is local mode (the adapter enforces its own token identity).
 */
export interface FinalizationIdentitySurface {
  check(ctx: {
    subjectKey: SubjectKey;
    revisionRef: string;
    decision: EligibilityDecision;
  }): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
}
