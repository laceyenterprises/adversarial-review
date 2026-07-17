import type {
  AgentRunRequest,
  AgentRuntime,
  AggregationPolicy,
  CommsChannelAdapter,
  DeliveryKey,
  FinalizationActionStatus,
  FinalizationDecision,
  FinalizationDecisionKind,
  FinalizationOutcome,
  FinalizationPort,
  OperatorSurfaceAdapter,
  RemediationBudgetPlan,
  ReviewPipeline,
  ReviewerRuntimeAdapter,
  RemediationCommitMetadata,
  RemediationReply,
  RunResult,
  Stage,
  StageState,
  SubjectChannelAdapter,
  SubjectContent,
  SubjectRef,
  SubjectState,
  Verdict,
} from '../../../src/kernel/contracts.js';

const ref: SubjectRef = {
  domainId: 'example-domain',
  subjectExternalId: 'subject-123',
  revisionRef: 'revision-abc',
};

const verdict: Verdict = {
  kind: 'request-changes',
  body: '## Summary\nNeeds work.\n\n## Verdict\nRequest changes',
  blockingFindings: [
    {
      title: 'Missing validation',
      file: 'src/example.mjs',
      lines: '10-12',
      problem: 'The input can be empty.',
    },
  ],
};

const reply: RemediationReply = {
  kind: 'adversarial-review-remediation-reply',
  schemaVersion: 1,
  jobId: 'job-123',
  outcome: 'completed',
  summary: 'Added validation.',
  validation: ['npm test'],
  addressed: [
    {
      title: 'Missing validation',
      finding: 'The input can be empty.',
      action: 'Rejected empty input before processing.',
      files: ['src/example.mjs'],
    },
  ],
  pushback: [],
  blockers: [],
  reReview: {
    requested: true,
    reason: 'The blocking finding has been addressed.',
  },
};

// Review pipeline contract (§4.1–4.2): a sequential two-stage pipeline whose
// first stage runs a two-role panel under a weighted policy and whose second
// stage is a single-role blocking gate.
const unanimousClean: AggregationPolicy = { kind: 'unanimous-clean' };
const anyBlocking: AggregationPolicy = { kind: 'any-blocking-blocks' };
const quorumPolicy: AggregationPolicy = { kind: 'quorum', quorum: 2 };
const weightedPolicy: AggregationPolicy = {
  kind: 'weighted',
  weights: { 'code-quality:claude': 2, 'code-quality:codex': 1 },
  threshold: 2,
};
void unanimousClean;
void anyBlocking;
void quorumPolicy;

const pipeline: ReviewPipeline = [
  {
    id: 'code-quality',
    panel: [
      { id: 'code-quality:claude', model: 'claude' },
      { id: 'code-quality:codex', model: 'codex' },
    ],
    aggregation: weightedPolicy,
    roundBudgetByRisk: { low: 1, medium: 2, high: 3, critical: 4 },
  },
  {
    id: 'security',
    panel: [{ id: 'security:codex', model: 'codex' }],
    aggregation: anyBlocking,
    roundBudgetByRisk: { low: 1, medium: 1, high: 2, critical: 3 },
  },
];
const firstStage: Stage = pipeline[0];
void firstStage.panel.length;

const pinnedVerdict: Verdict = {
  kind: 'approved',
  body: '## Verdict\nApprove',
  revisionRef: 'revision-abc',
  stageId: 'code-quality',
  reviewerRoleId: 'code-quality:claude',
};

const stageStates: StageState[] = [
  { stageId: 'code-quality', stageIndex: 0, panelVerdicts: [pinnedVerdict, verdict] },
  { stageId: 'security', stageIndex: 1, panelVerdicts: [] },
];

const pipelineState: SubjectState = {
  ref,
  lifecycle: 'review-in-progress',
  riskClass: 'high',
  currentRound: 1,
  completedRemediationRounds: 0,
  maxRemediationRounds: 5,
  pipeline: stageStates,
  latestVerdict: pinnedVerdict,
  terminal: false,
  observedAt: '2026-05-10T00:00:00.000Z',
};
void pipelineState.pipeline?.length;

const budgetPlan: RemediationBudgetPlan = {
  riskClass: 'high',
  perStage: [
    { stageId: 'code-quality', roundBudget: 3 },
    { stageId: 'security', roundBudget: 2 },
  ],
  ceiling: 5,
  ceilingSource: 'sum-capped',
};
void budgetPlan.ceiling;

const deliveryKey: DeliveryKey = {
  domainId: ref.domainId,
  subjectExternalId: ref.subjectExternalId,
  revisionRef: ref.revisionRef,
  round: 1,
  kind: 'review',
};

const subjectAdapter: SubjectChannelAdapter = {
  async discoverSubjects() {
    return [ref];
  },
  async fetchState(subjectRef) {
    return {
      ref: subjectRef,
      lifecycle: 'reviewed',
      currentRound: 1,
      completedRemediationRounds: 0,
      maxRemediationRounds: 2,
      latestVerdict: verdict,
      terminal: false,
      observedAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async fetchContent(subjectRef) {
    return {
      ref: subjectRef,
      representation: 'Reviewable content',
      observedAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async prepareRemediationWorkspace(subjectRef) {
    return {
      ref: subjectRef,
      workspacePath: '/tmp/example-workspace',
      preparedAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async recordRemediationCommit(subjectRef, commit: RemediationCommitMetadata) {
    return {
      ref: {
        ...subjectRef,
        revisionRef: commit.revisionRef,
      },
      lifecycle: 'awaiting-rereview',
      currentRound: 1,
      completedRemediationRounds: 1,
      maxRemediationRounds: 2,
      latestRemediationReply: reply,
      terminal: false,
      observedAt: commit.committedAt,
    };
  },
  async finalizeSubject(subjectRef) {
    return {
      ref: subjectRef,
      lifecycle: 'finalized',
      currentRound: 1,
      completedRemediationRounds: 1,
      maxRemediationRounds: 2,
      terminal: true,
      observedAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async isTerminal() {
    return false;
  },
};

const commsAdapter: CommsChannelAdapter = {
  async postReview(postedVerdict, key) {
    return {
      key,
      deliveryExternalId: postedVerdict.kind,
      deliveredAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async postRemediationReply(postedReply, key) {
    return {
      key,
      deliveryExternalId: postedReply.jobId,
      deliveredAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async postOperatorNotice(event, _body, key) {
    return {
      key,
      deliveryExternalId: event.type,
      deliveredAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async lookupExistingDeliveries(key) {
    return [
      {
        key,
        deliveryExternalId: 'delivery-123',
        attemptedAt: '2026-05-10T00:00:00.000Z',
        deliveredAt: '2026-05-10T00:00:00.000Z',
        delivered: true,
      },
    ];
  },
};

const operatorSurface: OperatorSurfaceAdapter = {
  async observeOverrides(subjectRef, currentRevisionRef) {
    return {
      subjectRef,
      expectedRevisionRef: currentRevisionRef,
      observedRevisionRef: currentRevisionRef,
      forceRereview: false,
      operatorApproved: false,
      halted: false,
      events: [],
      observedAt: '2026-05-10T00:00:00.000Z',
    };
  },
  async syncTriageStatus(_subjectRef, _status) {},
  async recordReviewerEngagement(subjectRef, attempt) {
    await commsAdapter.postReview(attempt.verdict ?? verdict, {
      ...deliveryKey,
      subjectExternalId: subjectRef.subjectExternalId,
      revisionRef: attempt.revisionRef,
    });
  },
};

const reviewerRuntime: ReviewerRuntimeAdapter = {
  async spawnReviewer(req) {
    return {
      ok: true,
      reviewBody: `reviewed ${req.subjectContext.domainId}`,
      failureClass: null,
      stderrTail: null,
      stdoutTail: null,
      exitCode: 0,
      signal: null,
      pgid: 123,
      spawnedAt: '2026-05-10T00:00:00.000Z',
      reattachToken: req.sessionUuid,
    };
  },
  async spawnRemediator(req) {
    return {
      ok: true,
      remediationBody: req.prompt,
      failureClass: null,
      stderrTail: null,
      stdoutTail: null,
      exitCode: 0,
      signal: null,
      pgid: 124,
      spawnedAt: '2026-05-10T00:00:00.000Z',
      reattachToken: req.sessionUuid,
    };
  },
  async cancel(_sessionUuid) {},
  async reattach(record) {
    return {
      ok: false,
      reviewBody: null,
      failureClass: 'daemon-bounce',
      stderrTail: null,
      stdoutTail: null,
      exitCode: null,
      signal: null,
      pgid: record.pgid,
      spawnedAt: record.spawnedAt,
      reattachToken: record.reattachToken,
    };
  },
  describe() {
    return {
      id: 'fixture-stub',
      modelFamily: 'fixture',
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: true,
        leaseManaged: false,
        oauthStripEnforced: true,
      },
    };
  },
};

const subjectContent: SubjectContent = {
  ref,
  representation: 'Reviewable content',
  observedAt: '2026-05-10T00:00:00.000Z',
};

const agentRunRequest: AgentRunRequest = {
  role: { id: 'reviewer:codex', kind: 'reviewer', model: 'codex', forbiddenFallbacks: ['api-key'] },
  promptSet: 'code-pr',
  promptStage: 'first',
  subjectContent,
  idempotencyKey: 'example-domain:subject-123:revision-abc:review:reviewer:1',
  budget: { maxTokens: 500_000, maxWallMs: 900_000 },
  timeoutMs: 1_000,
};

const agentRuntime: AgentRuntime = {
  async run(request) {
    const result: RunResult = {
      status: 'completed',
      artifact: { kind: 'review', body: `reviewed ${request.subjectContent.ref.domainId}` },
      failureClass: null,
      usage: { total: 1234, source: 'fixture' },
      runtimeMode: 'local',
    };
    return {
      runRef: request.idempotencyKey,
      mode: 'local',
      async await() {
        return result;
      },
      async cancel() {},
      async reattach() {
        return result;
      },
    };
  },
  describe() {
    return {
      id: 'local',
      mode: 'local',
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: false,
        leaseManaged: false,
        oauthStripEnforced: true,
      },
    };
  },
};

// Finalization port (Phase 3 / ARC-14): `evaluate → FinalizationDecision`,
// `execute → FinalizationOutcome`, one port per domain.
const finalizeDecision: FinalizationDecision = {
  kind: 'finalize-now',
  subjectRef: ref,
  revisionRef: ref.revisionRef,
  observedAt: '2026-05-10T00:00:00.000Z',
};
const remediateDecision: FinalizationDecision = {
  kind: 'remediate',
  subjectRef: ref,
  revisionRef: ref.revisionRef,
  stageId: 'security',
  round: 2,
  observedAt: '2026-05-10T00:00:00.000Z',
};
const waitDecision: FinalizationDecision = {
  kind: 'wait',
  subjectRef: ref,
  revisionRef: ref.revisionRef,
  reason: 'required check missing',
  deadline: '2026-05-10T01:00:00.000Z',
  observedAt: '2026-05-10T00:00:00.000Z',
};
const decisionKinds: FinalizationDecisionKind[] = ['finalize-now', 'remediate', 'wait', 'halt', 'escalate'];
const actionStatuses: FinalizationActionStatus[] = ['executed', 'deferred', 'skipped', 'failed'];
void decisionKinds;
void actionStatuses;
void remediateDecision;
void waitDecision;

const finalizationPort: FinalizationPort = {
  domainId: 'code-pr',
  evaluate(subjectState: SubjectState): FinalizationDecision {
    return { ...finalizeDecision, subjectRef: subjectState.ref, revisionRef: subjectState.ref.revisionRef };
  },
  async execute(decision: FinalizationDecision): Promise<FinalizationOutcome> {
    return {
      decision,
      status: 'executed',
      action: 'merge',
      observedAt: decision.observedAt,
    };
  },
};
const finalizationDecision: FinalizationDecision = await finalizationPort.evaluate(pipelineState);
const finalizationOutcome: FinalizationOutcome = await finalizationPort.execute(finalizationDecision);
void finalizationOutcome.status;

await subjectAdapter.discoverSubjects();
await commsAdapter.postRemediationReply(reply, { ...deliveryKey, kind: 'remediation-reply' });
await operatorSurface.syncTriageStatus(ref, 'awaiting-rereview');
await reviewerRuntime.spawnReviewer({
  model: 'codex',
  prompt: 'review',
  subjectContext: { domainId: ref.domainId },
  timeoutMs: 1_000,
  sessionUuid: 'session-123',
  forbiddenFallbacks: ['api-key'],
});

const agentRunHandle = await agentRuntime.run(agentRunRequest);
const agentRunResult: RunResult = await agentRunHandle.await();
const timeoutRunResult: RunResult = {
  status: 'timeout',
  failureClass: 'timeout',
  usage: null,
  runtimeMode: 'local',
  detail: 'reviewer wall-clock exceeded',
};
void agentRunResult;
void timeoutRunResult;
void agentRuntime.describe();
await agentRunHandle.cancel();
