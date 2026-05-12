/**
 * Target contract surface for the auto-remediation kernel boundary.
 * Runtime modules only bind a subset of these shapes today; the
 * governing intent and rollout status are documented in
 * docs/SPEC-adversarial-review-auto-remediation.md.
 */
export type IsoTimestamp = string;

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

export interface RemediationReply {
  kind: 'adversarial-review-remediation-reply';
  schemaVersion: 1;
  jobId: string;
  outcome: 'completed' | 'blocked' | 'partial';
  summary: string;
  validation: readonly string[];
  addressed?: readonly RemediationReplyAddressed[];
  pushback?: readonly RemediationReplyPushback[];
  // Legacy string blockers remain valid under schemaVersion 1 so older
  // persisted replies still parse during reconciliation. New producer
  // code should prefer structured RemediationReplyBlocker objects.
  blockers: readonly (string | RemediationReplyBlocker)[];
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
  | 'rate-limit'
  | 'queue-back-pressure'
  | 'forbidden-fallback'
  | 'oauth-broken'
  | 'daemon-bounce'
  | 'launchctl-bootstrap'
  | 'bug'
  | 'unknown';

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
