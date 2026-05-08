import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERSARIAL_GATE_CONTEXT,
  pickAdversarialGateStatus,
  publishAdversarialGateStatus,
} from '../src/adversarial-gate-status.mjs';

function makeReviewRow(overrides = {}) {
  return {
    repo: 'laceyenterprises/adversarial-review',
    pr_number: 53,
    pr_state: 'open',
    review_status: 'posted',
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return {
    jobId: 'job-53',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    status: 'completed',
    reviewBody: '## Summary\nLooks fine.\n## Verdict\nComment only',
    remediationPlan: {
      currentRound: 1,
      maxRounds: 1,
    },
    reReview: {
      requested: false,
    },
    ...overrides,
  };
}

function makeOperatorApproval(overrides = {}) {
  return {
    actor: 'VirtualPaul',
    createdAt: '2026-05-07T18:05:00.000Z',
    labelEventId: 'evt-operator-approved',
    labelEventNodeId: 'LE_operator_approved',
    headSha: 'abc123',
    reviewKey: 'job-53:2026-05-07T18:00:00.000Z',
    ...overrides,
  };
}

test('pickAdversarialGateStatus returns success for a settled non-blocking review', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob(),
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'review-settled');
});

test('pickAdversarialGateStatus returns pending while remediation is active', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({ status: 'in_progress' }),
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'remediation-in-progress');
});

test('pickAdversarialGateStatus returns failure when remediation stopped', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      status: 'stopped',
      reviewBody: '## Summary\nStill blocked.\n## Verdict\nRequest changes',
    }),
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'remediation-stopped');
});

test('pickAdversarialGateStatus keeps PR #53 queued-rereview shape pending until the second review posts', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({ review_status: 'pending' }),
    latestJob: makeJob({
      status: 'completed',
      reviewBody: '## Summary\nRemediation done.\n## Verdict\nRequest changes',
      reReview: {
        requested: true,
      },
    }),
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'rereview-queued');
  assert.match(decision.description, /queued re-review/i);
});

test('pickAdversarialGateStatus returns success for a scoped operator-approved override after rounds are exhausted', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      reviewBody: '## Summary\nRemaining issue accepted by operator.\n## Verdict\nRequest changes',
      remediationPlan: {
        currentRound: 2,
        maxRounds: 2,
      },
    }),
    operatorApproval: makeOperatorApproval(),
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus fails closed when operator-approved is present but remediation rounds remain claimable', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      reviewBody: '## Summary\nStill blocking.\n## Verdict\nRequest changes',
      remediationPlan: {
        currentRound: 1,
        maxRounds: 2,
      },
    }),
    operatorApproval: makeOperatorApproval(),
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'override-remediation-claimable');
});

test('publishAdversarialGateStatus skips duplicate posts for the same sha/state/description', async () => {
  const rootDir = '/virtual/root';
  const ghCalls = [];
  const records = new Map();
  const decision = {
    context: ADVERSARIAL_GATE_CONTEXT,
    state: 'pending',
    description: 'Queued re-review has not posted yet.',
    reason: 'rereview-queued',
  };

  const execFileImpl = async (command, args, options) => {
    ghCalls.push({ command, args, options });
    return { stdout: '{}', stderr: '' };
  };
  const readRecordImpl = (_unusedRootDir, coordinates) => records.get(JSON.stringify(coordinates)) || null;
  const writeRecordImpl = (filePath, content) => {
    const parsed = JSON.parse(content);
    records.set(JSON.stringify({
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
    }), parsed);
    return filePath;
  };

  await publishAdversarialGateStatus(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    headSha: 'abc123',
    decision,
    execFileImpl,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/test-home',
      GITHUB_TOKEN: 'token-123',
      SHOULD_NOT_LEAK: 'nope',
    },
    readRecordImpl,
    writeRecordImpl,
    mkdirImpl: () => {},
  });

  const second = await publishAdversarialGateStatus(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    headSha: 'abc123',
    decision,
    execFileImpl,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/test-home',
      GITHUB_TOKEN: 'token-123',
      SHOULD_NOT_LEAK: 'nope',
    },
    readRecordImpl,
    writeRecordImpl,
    mkdirImpl: () => {},
  });

  assert.equal(ghCalls.length, 1);
  assert.equal(second.reason, 'already-current');
  assert.deepEqual(Object.keys(ghCalls[0].options.env).sort(), ['GH_TOKEN', 'HOME', 'PATH']);

  const record = records.get(JSON.stringify({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    headSha: 'abc123',
  }));
  assert.equal(record.state, 'pending');
  assert.equal(record.description, decision.description);
});
