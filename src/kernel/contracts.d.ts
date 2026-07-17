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

/**
 * Review pipeline contract (ARC-11).
 *
 * A review is an ordered list of stages; each stage runs a panel of one or
 * more reviewer roles and aggregates their verdicts under a policy. A later
 * stage runs only once every prior stage is clean at the current revision.
 * The single-stage, single-reviewer configuration (`stages.length === 1`,
 * `panel.length === 1`, `any-blocking-blocks`) is behaviourally identical to
 * the pre-pipeline model, so existing consumers keep working through the
 * `latestVerdict` alias. Production multi-stage enablement is ARC-13; this
 * contract only defines the shape and the pure selection logic.
 */

/** A reviewer role id, resolved against the role registry (ARC-12). */
export type ReviewerRole = string;

/**
 * How a stage folds its panel's verdicts into a single stage decision.
 * - `unanimous-clean`: every collected verdict must be clean.
 * - `any-blocking-blocks`: any blocking verdict blocks the stage (the default,
 *   and the single-reviewer behaviour).
 * - `quorum`: at least `n` collected verdicts must be clean.
 * - `weighted`: the summed weight of clean verdicts must meet `threshold`.
 */
export type AggregationPolicy =
  | 'unanimous-clean'
  | 'any-blocking-blocks'
  | { readonly kind: 'quorum'; readonly n: number }
  | {
      readonly kind: 'weighted';
      readonly weights: { readonly [role: string]: number };
      readonly threshold: number;
    };

/** Per-risk-class round budgets for a single stage. */
export type StageRoundBudgetByRisk = { readonly [K in RiskClass]?: number };

export interface ReviewStage {
  readonly id: string;
  readonly panel: readonly ReviewerRole[];
  readonly aggregation: AggregationPolicy;
  /**
   * Per-stage remediation-round budget keyed by risk class. When a risk class
   * is absent the resolver falls back to the domain-level `riskClasses`
   * budget, then to 0.
   */
  readonly roundBudgetByRisk?: StageRoundBudgetByRisk;
}

export interface ReviewPipeline {
  readonly stages: readonly ReviewStage[];
  /**
   * Optional subject-level remediation ceiling. When omitted the ceiling is
   * the sum of the per-stage budgets for the subject's risk class; when set it
   * caps that sum so a multi-stage pipeline can never multiply hammer cycles
   * past the operator's tolerance.
   */
  readonly subjectRemediationCeiling?: number;
}

/** One reviewer's verdict within a stage panel, pinned to the reviewed revision. */
export interface PanelVerdict {
  readonly reviewerRole: ReviewerRole;
  readonly verdict: Verdict;
  /** The revision this verdict reviewed — never inferred from current head. */
  readonly revisionRef: string;
}

export type StageDecision = 'clean' | 'blocked' | 'incomplete';

/** Runtime state of one pipeline stage for a subject. */
export interface PipelineStageState {
  readonly stageId: string;
  readonly stageIndex: number;
  readonly panelVerdicts: readonly PanelVerdict[];
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
   * Per-stage panel state for the active pipeline. Absent for single-stage
   * subjects that predate the pipeline contract.
   */
  pipeline?: readonly PipelineStageState[];
  /**
   * @deprecated Pipeline-aware consumers should read `pipeline[]`. Retained as
   * a compatibility alias resolving to the newest verdict of the active stage;
   * `deriveLatestVerdict` computes it from `pipeline` when present.
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
