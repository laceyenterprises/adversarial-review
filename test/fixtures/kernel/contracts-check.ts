import type {
  CommsChannelAdapter,
  DeliveryKey,
  OperatorSurfaceAdapter,
  RemediationCommitMetadata,
  RemediationReply,
  SubjectChannelAdapter,
  SubjectRef,
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

await subjectAdapter.discoverSubjects();
await commsAdapter.postRemediationReply(reply, { ...deliveryKey, kind: 'remediation-reply' });
await operatorSurface.syncTriageStatus(ref, 'awaiting-rereview');
