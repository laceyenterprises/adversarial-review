import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ADVERSARIAL_GATE_CONTEXT,
  pickAdversarialGateStatus,
  projectAdversarialGateStatus,
  pruneGateRecordsForPR,
  publishAdversarialGateStatus,
} from '../src/adversarial-gate-status.mjs';
import { handlePostedReviewRow } from '../src/watcher.mjs';

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

test('pickAdversarialGateStatus keeps posted rows without a follow-up ledger entry pending', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'awaiting-ledger');
});

test('pickAdversarialGateStatus settles comment-only posted rows even without a follow-up job', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      reviewBody: '## Summary\nClean.\n## Verdict\nComment only',
    }),
    latestJob: null,
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

test('pickAdversarialGateStatus reports reviewer timeout failures precisely', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[reviewer-timeout] Command failed after reviewer timeout',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'reviewer-timeout');
  assert.match(decision.description, /timed out/i);
});

test('pickAdversarialGateStatus reports launchctl bootstrap failures precisely', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[launchctl-bootstrap] Claude launchctl session bootstrap failed',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'reviewer-launchctl-bootstrap');
  assert.match(decision.description, /bootstrap failed/i);
});

test('pickAdversarialGateStatus only trusts bracket tags at the message prefix', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[launchctl-bootstrap] stderr quoted stale row: [reviewer-timeout] Command timed out',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'reviewer-launchctl-bootstrap');
});

test('pickAdversarialGateStatus reports transient pending-upstream class precisely', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'pending-upstream',
      failure_message: '[reviewer-timeout] Command failed after reviewer timeout',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'reviewer-timeout-retry-pending');
  assert.match(decision.description, /retry is pending/i);
});

test('pickAdversarialGateStatus retro-classifies legacy raw cascade stderr', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'pending-upstream',
      failure_message: 'All upstream attempts failed in retry pool after command timed out after 600000ms',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'reviewer-cascade-retry-pending');
});

test('pickAdversarialGateStatus recognizes legacy cascade failure messages', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'pending-upstream',
      failure_message: 'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'reviewer-cascade-retry-pending');
});

test('pickAdversarialGateStatus does not infer timeout from debug-log fragments', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: 'debug: starting claude review\nreviewer process exited without completion marker',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'review-failed');
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

test('pickAdversarialGateStatus lets scoped operator-approved override claimable remediation rounds', () => {
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

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus lets scoped operator-approved override pending review state', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({ review_status: 'reviewing' }),
    latestJob: makeJob({ status: 'in_progress' }),
    operatorApproval: makeOperatorApproval(),
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus lets scoped operator-approved override missing review state', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: null,
    latestJob: null,
    operatorApproval: makeOperatorApproval({ reviewKey: null }),
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('publishAdversarialGateStatus skips duplicate decisions already recorded for the same head SHA', async () => {
  const rootDir = '/virtual/root';
  const ghCalls = [];
  const records = new Map();
  const writeOptions = [];
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
  const writeRecordImpl = (filePath, content, options) => {
    writeOptions.push(options);
    const parsed = JSON.parse(content);
    records.set(JSON.stringify({
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
    }), parsed);
    return filePath;
  };
  const readRecordImpl = () => {
    const record = records.get(JSON.stringify({
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 53,
      headSha: 'abc123',
    }));
    if (!record) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return `${JSON.stringify(record)}\n`;
  };

  const first = await publishAdversarialGateStatus(rootDir, {
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
    writeRecordImpl,
    readRecordImpl,
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
    writeRecordImpl,
    readRecordImpl,
    mkdirImpl: () => {},
  });

  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(writeOptions, [{ mode: 0o640 }]);
  assert.deepEqual(Object.keys(ghCalls[0].options.env).sort(), ['GH_TOKEN', 'HOME', 'PATH']);

  const record = records.get(JSON.stringify({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    headSha: 'abc123',
  }));
  assert.equal(record.state, 'pending');
  assert.equal(record.description, decision.description);
});

test('publishAdversarialGateStatus rejects invalid PR numbers before path interpolation', async () => {
  await assert.rejects(
    publishAdversarialGateStatus('/virtual/root', {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 'not-a-number',
      headSha: 'abc123',
      decision: {
        state: 'pending',
        description: 'Queued.',
        reason: 'review-queued',
      },
      execFileImpl: async () => {
        throw new Error('should not post');
      },
      env: {
        GITHUB_TOKEN: 'token-123',
      },
    }),
    /Invalid PR number/
  );
});

test('pruneGateRecordsForPR removes stale gate records while keeping the current SHA', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-gate-prune-'));
  try {
    const recordDir = path.join(rootDir, 'data', 'adversarial-gate-status');
    mkdirSync(recordDir, { recursive: true });
    const stale = path.join(recordDir, 'laceyenterprises__adversarial-review-pr-53-oldsha.json');
    const current = path.join(recordDir, 'laceyenterprises__adversarial-review-pr-53-newsha.json');
    const other = path.join(recordDir, 'laceyenterprises__adversarial-review-pr-54-oldsha.json');
    writeFileSync(stale, '{}\n');
    writeFileSync(current, '{}\n');
    writeFileSync(other, '{}\n');

    const result = pruneGateRecordsForPR(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 53,
      keepHeadSha: 'newsha',
    });

    assert.deepEqual(result, { removed: 1 });
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(other), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('posted watcher rows project the adversarial gate before merge-agent dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-gate-posted-'));
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 54;
    const headSha = 'abc123posted';
    const reviewRow = makeReviewRow({ pr_number: prNumber });
    const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
    mkdirSync(completedDir, { recursive: true });
    writeFileSync(
      path.join(completedDir, 'job-54.json'),
      `${JSON.stringify({
        jobId: 'job-54',
        repo,
        prNumber,
        status: 'completed',
        createdAt: '2026-05-08T00:00:00.000Z',
        completedAt: '2026-05-08T00:01:00.000Z',
        reviewBody: '## Summary\nClean.\n## Verdict\nComment only',
        remediationPlan: {
          currentRound: 2,
          maxRounds: 2,
        },
        reReview: {
          requested: false,
        },
      }, null, 2)}\n`
    );

    const events = [];
    const ghCalls = [];
    const execFileImpl = async (command, args, options) => {
      events.push('status-post');
      ghCalls.push({ command, args, options });
      return { stdout: '{}', stderr: '' };
    };

    await handlePostedReviewRow({
      rootDir,
      repoPath: repo,
      prNumber,
      existing: reviewRow,
      projectGateStatusSafe: async (row) => {
        assert.equal(row, reviewRow);
        return projectAdversarialGateStatus(rootDir, {
          repo,
          prNumber,
          headSha,
          reviewRow: row,
          execFileImpl,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/tmp/test-home',
            GITHUB_TOKEN: 'token-123',
          },
        });
      },
      fetchMergeAgentCandidateImpl: async () => {
        events.push('merge-fetch');
        return { repo, prNumber };
      },
      buildMergeAgentDispatchJobImpl: (_rootDir, candidate) => candidate,
      dispatchMergeAgentForPRImpl: async () => {
        events.push('merge-dispatch');
        return { decision: 'skip-test' };
      },
      logger: {
        log() {},
        error() {},
      },
    });

    assert.deepEqual(events, ['status-post', 'merge-fetch', 'merge-dispatch']);
    assert.equal(ghCalls.length, 1);
    assert.equal(ghCalls[0].command, 'gh');
    assert.ok(ghCalls[0].args.includes(`repos/laceyenterprises/adversarial-review/statuses/${headSha}`));
    assert.ok(ghCalls[0].args.includes('state=success'));
    assert.ok(ghCalls[0].args.includes(`context=${ADVERSARIAL_GATE_CONTEXT}`));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
