import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildAdversarialGateSnapshot,
  pickAdversarialGateStatus,
  projectAdversarialGateStatus,
  pruneGateRecordsForPR,
  publishAdversarialGateStatus,
} from '../src/adversarial-gate-status.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

const ADVERSARIAL_GATE_CONTEXT = DEFAULT_ADVERSARIAL_GATE_CONTEXT;
import {
  claimNextFollowUpJob,
  createFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  handlePostedReviewRow,
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/watcher.mjs';
import { resetConfigCache } from '../src/config-loader.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';

// Pin AMA enabled/disabled for a test body regardless of the host's live
// config.local.yaml (which may set roles.adversarial.merge_authority.enabled).
// The env alias overrides config; resetConfigCache forces the cached loader to
// re-read. Restores the prior value + cache on exit.
async function withMergeAuthorityEnabled(enabled, fn) {
  const KEY = 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED';
  const prev = process.env[KEY];
  process.env[KEY] = enabled ? 'true' : 'false';
  resetConfigCache();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    resetConfigCache();
  }
}

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
    codeScopedAt: '2026-05-07T18:00:00.000Z',
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

test('pickAdversarialGateStatus fails closed for unparseable verdicts', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      reviewBody: [
        '## Summary',
        'The review body has no recognized verdict line.',
        '',
        '## Blocking issues',
        '- None.',
        '',
        '## Verdict',
        'Needs work',
      ].join('\n'),
    }),
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'unknown-verdict');
});

test('pickAdversarialGateStatus holds a settled verdict pending when the live head moved past the reviewed head', () => {
  // Regression: a comment-only/approved verdict was reviewed at head A, then
  // the PR advanced to head B (remediation push / re-review still in flight).
  // The verdict no longer describes the merge tree, so the gate must not
  // greenlight head B until the re-review posts on it.
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({ reviewer_head_sha: 'aaaaaaa_reviewed_head' }),
    latestJob: makeJob(),
    headSha: 'bbbbbbb_live_head',
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'stale-review-head');
});

test('pickAdversarialGateStatus holds a settled posted row (no follow-up job) pending on a stale head', () => {
  // The !latestJob branch must respect the same staleness guard so a
  // comment-only verdict computed at head A cannot greenlight head B.
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      reviewer_head_sha: 'aaaaaaa_reviewed_head',
      reviewBody: '## Summary\nClean.\n## Verdict\nComment only',
    }),
    latestJob: null,
    headSha: 'bbbbbbb_live_head',
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'stale-review-head');
});

for (const failureCase of [
  {
    name: 'reviewer timeout',
    failure_message: '[reviewer-timeout] Command failed after reviewer timeout',
  },
  {
    name: 'launchctl bootstrap',
    failure_message: '[launchctl-bootstrap] Claude launchctl session bootstrap failed',
  },
  {
    name: 'cascade',
    failure_message: 'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.',
  },
  {
    name: 'unknown failure',
    failure_message: 'reviewer process exited without completion marker',
  },
]) {
  test(`pickAdversarialGateStatus holds stale failed ${failureCase.name} rows pending`, () => {
    const decision = pickAdversarialGateStatus({
      reviewRow: makeReviewRow({
        review_status: 'failed',
        reviewer_head_sha: 'aaaaaaa_reviewed_head',
        failure_message: failureCase.failure_message,
      }),
      latestJob: null,
      headSha: 'bbbbbbb_live_head',
    });

    assert.equal(decision.state, 'pending');
    assert.equal(decision.reason, 'stale-review-head');
  });
}

test('pickAdversarialGateStatus holds stale failed-orphan rows pending', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed-orphan',
      reviewer_head_sha: 'aaaaaaa_reviewed_head',
    }),
    latestJob: null,
    headSha: 'bbbbbbb_live_head',
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'stale-review-head');
});

test('pickAdversarialGateStatus settles when the reviewed head matches the live head', () => {
  // The guard must not block the normal path: once the re-review posts on the
  // current head, reviewer_head_sha catches up and the verdict applies.
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({ reviewer_head_sha: 'bbbbbbb_live_head' }),
    latestJob: makeJob(),
    headSha: 'bbbbbbb_live_head',
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'review-settled');
});

test('pickAdversarialGateStatus keeps current-head failed rows non-blocking', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      reviewer_head_sha: 'bbbbbbb_live_head',
      failure_message: '[reviewer-timeout] Command failed after reviewer timeout',
    }),
    latestJob: null,
    headSha: 'bbbbbbb_live_head',
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'reviewer-timeout');
});

test('pickAdversarialGateStatus falls through the staleness guard on legacy rows without a reviewed head', () => {
  // Rows predating the reviewer_head_sha column carry no reviewed head; the
  // guard must not block them (it would block every legacy PR forever).
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob(),
    headSha: 'bbbbbbb_live_head',
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

test('pickAdversarialGateStatus keeps pending clean verdict-carrier jobs queued', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({ status: 'pending' }),
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'remediation-queued');
});

test('pickAdversarialGateStatus returns pending while remediation is active', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      status: 'in_progress',
      reviewBody: '## Summary\nStill blocked.\n## Verdict\nRequest changes',
    }),
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'remediation-in-progress');
});

test('pickAdversarialGateStatus keeps operator-retriggered clean jobs pending while active', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      status: 'in_progress',
      reviewBody: '## Summary\nOperator requested another pass.\n## Verdict\nComment only',
      remediationPlan: {
        currentRound: 2,
        maxRounds: 3,
        nextAction: {
          type: 'reconcile-worker',
          round: 2,
          operatorVisibility: 'explicit',
        },
      },
    }),
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'remediation-in-progress');
});

test('pickAdversarialGateStatus posts non-blocking success when remediation stopped (operator decides)', () => {
  // Pipeline-give-up cases intentionally do not block the GitHub merge
  // button; the operator reads the review thread and decides. Real
  // adversarial findings still fire `failure` via the `blocking-review`
  // path (covered by a separate test).
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      status: 'stopped',
      reviewBody: '## Summary\nStill blocked.\n## Verdict\nRequest changes',
    }),
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'remediation-stopped');
  assert.match(decision.description, /operator decides/i);
});

test('pickAdversarialGateStatus settles clean re-review jobs after remediation is suppressed', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-gate-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewPostedAt: '2026-05-07T18:30:00.000Z',
    critical: false,
    priorCompletedRounds: 2,
    maxRemediationRounds: 2,
    reviewBody: [
      '## Summary',
      'Clean final review.',
      '',
      '## Blocking issues',
      '- None.',
      '',
      '## Non-blocking issues',
      '- None.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
  });

  const cleanJob = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-05-07T18:31:00.000Z',
    returnStopped: true,
  });

  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: cleanJob.job,
  });

  assert.equal(cleanJob.stopped, true);
  assert.equal(cleanJob.reason, 'review-settled');
  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'review-settled');
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

test('pickAdversarialGateStatus keeps fast-merge skipped rows pending', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      pr_state: 'fast_merge_skipped',
      review_status: 'fast_merge_skipped',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'fast-merge-skipped');
});

test('pickAdversarialGateStatus reports reviewer timeout precisely (non-blocking, operator decides)', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[reviewer-timeout] Command failed after reviewer timeout',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'reviewer-timeout');
  assert.match(decision.description, /timed out/i);
  assert.match(decision.description, /operator decides/i);
});

test('pickAdversarialGateStatus reports launchctl bootstrap precisely (non-blocking, operator decides)', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[launchctl-bootstrap] Claude launchctl session bootstrap failed',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'reviewer-launchctl-bootstrap');
  assert.match(decision.description, /bootstrap failed/i);
  assert.match(decision.description, /operator decides/i);
});

test('pickAdversarialGateStatus only trusts bracket tags at the message prefix', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: '[launchctl-bootstrap] stderr quoted stale row: [reviewer-timeout] Command timed out',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'success');
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

test('pickAdversarialGateStatus retro-classifies legacy raw progress-timeout stderr', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'pending-upstream',
      failure_message: 'Claude review failed: Command no output for 900000ms',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'reviewer-timeout-retry-pending');
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

test('pickAdversarialGateStatus does not infer timeout from debug-log fragments (non-blocking, operator decides)', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({
      review_status: 'failed',
      failure_message: 'debug: starting claude review\nreviewer process exited without completion marker',
    }),
    latestJob: null,
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'review-failed');
  assert.match(decision.description, /operator decides/i);
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
    headSha: 'abc123',
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
    headSha: 'abc123',
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus lets scoped operator-approved override pending review state', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow({ review_status: 'reviewing' }),
    latestJob: makeJob({ status: 'in_progress' }),
    operatorApproval: makeOperatorApproval(),
    headSha: 'abc123',
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus lets scoped operator-approved override missing review state', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: null,
    latestJob: null,
    operatorApproval: makeOperatorApproval(),
    headSha: 'abc123',
  });

  assert.equal(decision.state, 'success');
  assert.equal(decision.reason, 'operator-approved');
});

test('pickAdversarialGateStatus lets explicit skip labels override operator-approved', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      reviewBody: '## Summary\nOperator accepted.\n## Verdict\nRequest changes',
    }),
    operatorApproval: makeOperatorApproval(),
    labels: [{ name: 'operator-approved' }, { name: 'do-not-merge' }],
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'operator-skip-label');
});

test('pickAdversarialGateStatus treats no-merge-hold as an explicit skip label', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    labels: [{ name: 'no-merge-hold' }, { name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
    headSha: 'abc123',
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'operator-skip-label');
});

test('pickAdversarialGateStatus ignores unvalidated operator approvals', () => {
  const decision = pickAdversarialGateStatus({
    reviewRow: makeReviewRow(),
    latestJob: makeJob({
      reviewBody: '## Summary\nStill blocked.\n## Verdict\nRequest changes',
    }),
    operatorApproval: {
      actor: 'VirtualPaul',
    },
    headSha: 'abc123',
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'blocking-review');
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

test('publishAdversarialGateStatus sends byte-equivalent required fields through adapter mutation', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'gate-status-adapter-'));
  const calls = [];
  const decision = {
    state: 'success',
    description: 'Adversarial review passed',
    reason: 'settled-success',
    context: ADVERSARIAL_GATE_CONTEXT,
  };

  const result = await publishAdversarialGateStatus(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 54,
    headSha: 'def456',
    decision,
    execFileImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      assert.equal(command, '/fixture/github-adapter');
      return { stdout: JSON.stringify({ ok: true }) };
    },
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/test-home',
      GITHUB_TOKEN: 'status-token',
      GHA_ADAPTER_BIN: '/fixture/github-adapter',
      SHOULD_NOT_LEAK: 'nope',
    },
  });

  assert.equal(result.posted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'write',
    '--kind',
    'commit-status',
    '--json',
    '--repo',
    'laceyenterprises/adversarial-review',
    '--head-sha',
    'def456',
    '--state',
    'success',
    '--context',
    ADVERSARIAL_GATE_CONTEXT,
    '--description',
    'Adversarial review passed',
  ]);
  assert.equal(calls[0].options.env.GH_TOKEN, 'status-token');
  assert.equal(calls[0].options.env.SHOULD_NOT_LEAK, undefined);
});

test('publishAdversarialGateStatus early-returns disabled-by-config when ADVERSARIAL_GATE_STATUS_DISABLED=true', async () => {
  const ghCalls = [];
  const writeCalls = [];
  const execFileImpl = async (command, args) => {
    ghCalls.push({ command, args });
    return { stdout: '', stderr: '' };
  };
  const writeRecordImpl = (filePath, content, options) => {
    writeCalls.push({ filePath, content, options });
    return filePath;
  };

  const result = await publishAdversarialGateStatus('/virtual/root', {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 99,
    headSha: 'abc123',
    decision: {
      state: 'pending',
      description: 'Queued.',
      reason: 'review-queued',
    },
    execFileImpl,
    writeRecordImpl,
    env: {
      GITHUB_TOKEN: 'token-123',
      ADVERSARIAL_GATE_STATUS_DISABLED: 'true',
    },
  });

  assert.equal(result.posted, false);
  assert.equal(result.reason, 'disabled-by-config');
  assert.equal(result.record.repo, 'laceyenterprises/adversarial-review');
  assert.equal(result.record.headSha, 'abc123');
  assert.equal(ghCalls.length, 0, 'kill-switch must NOT POST to /statuses/');
  assert.equal(writeCalls.length, 0, 'kill-switch must NOT write a gate record');
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

    // This test exercises the merge-agent dispatch path, which only runs when
    // AMA is disabled. Pin it off so the host's live config.local.yaml (which
    // may enable AMA) cannot pre-empt merge-agent and drop 'merge-dispatch'.
    await withMergeAuthorityEnabled(false, () => handlePostedReviewRow({
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
      resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
        outcome: 'dispatch-merge-agent',
        dispatchEnv: null,
      }),
      logger: {
        log() {},
        error() {},
      },
    }));

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

test('projectAdversarialGateStatus posts the env-override context when ADV_GATE_STATUS_CONTEXT is set', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-gate-override-'));
  try {
    const repo = 'galileo/example';
    const prNumber = 77;
    const headSha = 'overrideheadsha';
    const reviewRow = makeReviewRow({
      repo,
      pr_number: prNumber,
      review_body: '## Summary\nClean.\n## Verdict\nComment only',
    });

    const ghCalls = [];
    const execFileImpl = async (command, args, options) => {
      ghCalls.push({ command, args, options });
      return { stdout: '{}', stderr: '' };
    };

    const result = await projectAdversarialGateStatus(rootDir, {
      repo,
      prNumber,
      headSha,
      reviewRow,
      execFileImpl,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/test-home',
        GITHUB_TOKEN: 'token-123',
        ADV_GATE_STATUS_CONTEXT: 'galileo/adversarial-gate',
      },
    });

    assert.equal(ghCalls.length, 1);
    assert.ok(ghCalls[0].args.includes('context=galileo/adversarial-gate'));
    assert.ok(!ghCalls[0].args.some((arg) => arg === `context=${DEFAULT_ADVERSARIAL_GATE_CONTEXT}`));
    assert.equal(result.decision.context, 'galileo/adversarial-gate');
    assert.equal(result.publish.posted, true);
    assert.equal(result.publish.record.context, 'galileo/adversarial-gate');
    assert.equal(result.snapshot.settledReview, null);
    assert.equal(result.snapshot.reviewedHeadSha, null);
    assert.equal(result.snapshot.mergeableState, '');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('maybeDispatchAmaClosureFor passes the canonical blocker and CI snapshot into AMA eligibility', async () => {
  let observed = null;
  const result = await maybeDispatchAmaClosureFor({
    reviewStateRow: makeReviewRow({
      last_verdict: 'Comment only',
      risk_class: 'low',
      remediation_pending: 0,
      reviewer: 'claude',
      reviewer_login: 'claude-reviewer-lacey',
      // The closer resolves blocking/non-blocking findings from the SAME authoritative
      // current-head body it resolves the verdict from
      // (`resolveSettledReviewVerdict`), NOT from an injected
      // `dispatchJob.blockingFindingState`. A settled `Comment only` body whose
      // finding sections are `- None.` is `known: 0`.
      reviewer_head_sha: 'abc123',
      review_body: '## Summary\nLooks fine.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.',
    }),
    // dispatchJob blocker fields are intentionally stale here: they are no
    // longer the source of truth for the closer's blocking-findings axis.
    dispatchJob: {
      blockingFindingCount: 5,
      blockingFindingState: 'unknown',
    },
    candidate: {
      headSha: 'abc123',
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate', 'ci/test'] },
      isDraft: false,
    },
    labelNames: ['adversarial-merge-requested'],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: {
      actor: 'VirtualPaul',
      createdAt: '2026-06-11T23:20:00.000Z',
      nodeId: 'LE_adversarial_merge_requested',
      headSha: 'abc123',
    },
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 265,
    currentRevisionRef: 'abc123',
    logger: { warn() {} },
    // Live-review reconcile fires because the stored body is settled-success;
    // return the same settled comment-only body on the head so the authoritative
    // path resolves `known: 0`.
    fetchLatestHeadReviewBodiesImpl: async () => [
      '## Summary\nLooks fine.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.',
    ],
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return { enabled: true };
      },
    }),
    maybeDispatchAmaCloserImpl: async (payload) => {
      observed = payload;
      return {
        dispatched: false,
        reason: 'not-eligible',
        reasons: ['blocking-findings-present', 'ci-not-green'],
      };
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.namedReason, 'not-eligible:blocking-findings-present');
  assert.equal(observed.reviewState.blockingFindingCount, 0);
  assert.equal(observed.reviewState.blockingFindingState, 'known');
  assert.equal(observed.reviewState.nonBlockingFindingCount, 0);
  assert.equal(observed.reviewState.nonBlockingFindingState, 'known');
  // A mergeable PR (mergeable=MERGEABLE, mergeStateStatus=CLEAN) must resolve to
  // 'MERGEABLE' so the eligibility gate (which compares against 'MERGEABLE')
  // passes. The prior mapping yielded 'CLEAN' here, which !== 'MERGEABLE' and
  // made AMA report `pr-not-mergeable` for every clean PR.
  assert.equal(observed.prMetadata.mergeableState, 'MERGEABLE');
  assert.deepEqual(observed.prMetadata.statusCheckRollup, [
    { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
  ]);
  assert.deepEqual(observed.prMetadata.branchProtection.requiredContexts, [
    'agent-os/adversarial-gate',
    'ci/test',
  ]);
  assert.deepEqual(observed.options.adversarialMergeRequested, {
    applied: true,
    observedRevisionRef: 'abc123',
    actor: 'VirtualPaul',
    eventId: 'LE_adversarial_merge_requested',
    observedAt: '2026-06-11T23:20:00.000Z',
  });
});

test('maybeDispatchAmaClosureFor preserves explicit conflicting mergeability over CLEAN status', async () => {
  let observed = null;
  const result = await maybeDispatchAmaClosureFor({
    reviewStateRow: makeReviewRow({
      last_verdict: 'Comment only',
      risk_class: 'low',
      remediation_pending: 0,
      reviewer_login: 'claude-reviewer-lacey',
    }),
    dispatchJob: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
    },
    candidate: {
      headSha: 'abc123',
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
      isDraft: false,
    },
    labelNames: ['adversarial-merge-requested'],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 265,
    currentRevisionRef: 'abc123',
    logger: { warn() {} },
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return { enabled: true };
      },
    }),
    maybeDispatchAmaCloserImpl: async (payload) => {
      observed = payload;
      return { dispatched: false, reason: 'fixture' };
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(observed.prMetadata.mergeableState, 'CONFLICTING');
});

test('maybeDispatchAmaClosureFor resolves risk class from the remediation ledger when neither candidate nor review row carries it', async () => {
  // Root cause of "AMA closed 0 PRs ever": fetchMergeAgentCandidate never sets
  // candidate.riskClass and reviewed_prs has no risk_class column, so the
  // eligibility riskClass fell back to 'unknown' (always two-key) for EVERY PR.
  // It must instead use the remediation ledger's latestRiskClass
  // (DEFAULT_RISK_CLASS = 'medium' for a PR with no jobs) — the same class the
  // round-budget path already computes.
  let observed = null;
  await maybeDispatchAmaClosureFor({
    reviewStateRow: makeReviewRow({
      last_verdict: 'Comment only',
      // risk_class explicitly NULL — production reviewed_prs has no such column.
      risk_class: null,
      remediation_pending: 0,
      reviewer_login: 'claude-reviewer-lacey',
    }),
    dispatchJob: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
    },
    candidate: {
      headSha: 'abc123',
      // riskClass intentionally omitted — fetchMergeAgentCandidate never sets it.
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] },
      isDraft: false,
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    // Fixture repo/PR with no remediation jobs -> latestRiskClass defaults to
    // DEFAULT_RISK_CLASS ('medium').
    repoPath: 'laceyenterprises/nonexistent-ama-riskclass-fixture',
    prNumber: 999999,
    currentRevisionRef: 'abc123',
    logger: { warn() {} },
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        // Operator all-classes config: medium is allowlisted and branch
        // protection is waived, so the ONLY thing that could refuse this
        // settled-success PR is the risk-class resolution.
        return {
          enabled: true,
          eligibility: {
            riskClasses: ['low', 'medium', 'high', 'critical'],
            highRiskRequiresTwoKey: false,
          },
          branchProtection: { required: false },
        };
      },
    }),
    maybeDispatchAmaCloserImpl: async (payload) => {
      observed = payload;
      return { dispatched: false, reason: 'fixture' };
    },
  });

  assert.ok(observed, 'AMA closer payload should be built');
  // (1) Resolution: the ledger default ('medium'), not 'unknown'.
  assert.equal(observed.reviewState.riskClass, 'medium');
  assert.notEqual(observed.reviewState.riskClass, 'unknown');

  // (2) Full eligibility result: feeding the resolved reviewState through the
  // real predicate under the all-classes config, the risk gate does NOT refuse
  // this no-explicit-risk PR. Before the fix it resolved to 'unknown' ->
  // always-two-key -> `risk-class-not-permitted` (the gate that made AMA close
  // 0 PRs); now it resolves to the ledger default 'medium' and passes the risk
  // gate. (Other structural gates here belong to the fixture, not this change.)
  const eligibility = isEligibleForAmaClosure(
    observed.reviewState,
    observed.prMetadata,
    observed.cfg,
    observed.options,
  );
  assert.equal(
    eligibility.reasons.includes('risk-class-not-permitted'),
    false,
    `unexpected risk-class refusal: ${JSON.stringify(eligibility.reasons)}`,
  );
  assert.equal(eligibility.trace.riskClass.resolved, 'medium');
  assert.equal(eligibility.trace.riskClass.requiresTwoKey, false);
});

test('maybeDispatchAmaClosureFor carries stale reviewed head into AMA instead of current PR head', async () => {
  let observed = null;
  await maybeDispatchAmaClosureFor({
    reviewStateRow: makeReviewRow({
      review_body: '## Summary\nClean on the old head.\n## Verdict\nComment only',
      reviewer_head_sha: 'head-a-reviewed',
      reviewer_login: 'claude-reviewer-lacey',
    }),
    dispatchJob: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
    },
    candidate: {
      headSha: 'head-b-current',
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      isDraft: false,
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: 'laceyenterprises/nonexistent-ama-stale-review-head-fixture',
    prNumber: 999998,
    currentRevisionRef: 'head-b-current',
    logger: { warn() {} },
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          eligibility: {
            riskClasses: ['low', 'medium', 'high', 'critical'],
            highRiskRequiresTwoKey: false,
          },
          branchProtection: { required: false },
        };
      },
    }),
    maybeDispatchAmaCloserImpl: async (payload) => {
      observed = payload;
      return { dispatched: false, reason: 'fixture' };
    },
  });

  assert.ok(observed, 'AMA closer payload should be built');
  assert.equal(observed.reviewState.verdict, '');
  assert.equal(observed.reviewState.headSha, 'head-a-reviewed');
  assert.equal(observed.prMetadata.headSha, 'head-b-current');

  const eligibility = isEligibleForAmaClosure(
    observed.reviewState,
    observed.prMetadata,
    observed.cfg,
    observed.options,
  );
  assert.ok(eligibility.reasons.includes('stale-review-head'));
  assert.ok(eligibility.reasons.includes('verdict-not-settled-success'));
});

async function observeAmaSnapshotProjection({
  rootDir,
  reviewRow,
  candidate,
  repoPath = 'laceyenterprises/adversarial-review',
  prNumber = 265,
  labelNames = [],
  fetchLatestHeadReviewBodiesImpl = async () => [reviewRow.review_body || reviewRow.reviewBody || ''],
} = {}) {
  let observed = null;
  await maybeDispatchAmaClosureFor({
    rootDir,
    reviewStateRow: reviewRow,
    dispatchJob: {
      blockingFindingCount: 99,
      blockingFindingState: 'unknown',
    },
    candidate,
    labelNames,
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath,
    prNumber,
    currentRevisionRef: candidate?.headSha || null,
    logger: { warn() {} },
    fetchLatestHeadReviewBodiesImpl,
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          eligibility: {
            riskClasses: ['low', 'medium', 'high', 'critical'],
            highRiskRequiresTwoKey: false,
          },
          branchProtection: { required: false },
        };
      },
      getOrchestrationMode() {
        return 'native';
      },
    }),
    maybeDispatchAmaCloserImpl: async (payload) => {
      observed = payload;
      return { dispatched: false, reason: 'fixture' };
    },
  });

  const snapshot = await buildAdversarialGateSnapshot(rootDir, {
    repo: repoPath,
    prNumber,
    headSha: candidate?.headSha || null,
    mergeability: candidate,
    labels: labelNames,
    reviewRow,
    includeSettledReview: true,
  });
  return { observed, snapshot, decision: pickAdversarialGateStatus(snapshot) };
}

test('maybeDispatchAmaClosureFor consumes the canonical gate snapshot verdict/head/mergeable matrix', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ama-gate-snapshot-matrix-'));
  try {
    const fixtures = [
      {
        name: 'phantom-verdict-column',
        reviewRow: makeReviewRow({
          reviewer: 'codex',
          reviewer_head_sha: 'head-clean',
          review_body: '## Summary\nClean.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.',
          last_verdict: undefined,
          remediation_pending: undefined,
        }),
        candidate: {
          headSha: 'head-clean',
          riskClass: 'low',
          prAuthor: 'codex-worker-bot',
          prState: 'open',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          branchProtection: { requiredContexts: [] },
          isDraft: false,
        },
        expectedDecision: 'review-settled',
      },
      {
        name: 'stale-reviewed-head',
        reviewRow: makeReviewRow({
          reviewer: 'codex',
          reviewer_head_sha: 'head-reviewed',
          review_body: '## Summary\nClean on the old head.\n\n## Verdict\nComment only',
        }),
        candidate: {
          headSha: 'head-live',
          riskClass: 'low',
          prAuthor: 'codex-worker-bot',
          prState: 'open',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          branchProtection: { requiredContexts: [] },
          isDraft: false,
        },
        expectedDecision: 'stale-review-head',
      },
      {
        name: 'mergeable-clean-empty-field',
        reviewRow: makeReviewRow({
          reviewer: 'codex',
          reviewer_head_sha: 'head-clean-status',
          review_body: '## Summary\nClean.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.',
        }),
        candidate: {
          headSha: 'head-clean-status',
          riskClass: 'low',
          prAuthor: 'codex-worker-bot',
          prState: 'open',
          mergeable: '',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          branchProtection: { requiredContexts: [] },
          isDraft: false,
        },
        expectedDecision: 'review-settled',
      },
      {
        name: 'conflicting',
        reviewRow: makeReviewRow({
          reviewer: 'codex',
          reviewer_head_sha: 'head-conflict',
          review_body: '## Summary\nClean.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.',
        }),
        candidate: {
          headSha: 'head-conflict',
          riskClass: 'low',
          prAuthor: 'codex-worker-bot',
          prState: 'open',
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          branchProtection: { requiredContexts: [] },
          isDraft: false,
        },
        expectedDecision: 'review-settled',
      },
    ];

    for (const fixture of fixtures) {
      const { observed, snapshot, decision } = await observeAmaSnapshotProjection({
        rootDir,
        reviewRow: fixture.reviewRow,
        candidate: fixture.candidate,
      });

      assert.ok(observed, fixture.name);
      assert.equal(decision.reason, fixture.expectedDecision, fixture.name);
      assert.equal(observed.reviewState.verdict, snapshot.settledReview.verdict, fixture.name);
      assert.equal(observed.reviewState.headSha, snapshot.reviewedHeadSha, fixture.name);
      assert.equal(observed.reviewState.remediationPending, snapshot.settledReview.remediationPending, fixture.name);
      assert.equal(observed.reviewState.blockingFindingState, snapshot.settledReview.blockingFindingState, fixture.name);
      assert.equal(observed.reviewState.blockingFindingCount, snapshot.settledReview.blockingFindingCount, fixture.name);
      assert.equal(observed.prMetadata.mergeableState, snapshot.mergeableState, fixture.name);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('maybeDispatchAmaClosureFor mergeability matrix passes MERGEABLE and CLEAN fallback and blocks CONFLICTING', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ama-gate-mergeability-matrix-'));
  try {
    const baseReviewRow = makeReviewRow({
      reviewer: 'codex',
      reviewer_head_sha: 'head-mergeable',
      review_body: '## Summary\nClean.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.',
    });
    const baseCandidate = {
      headSha: 'head-mergeable',
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      isDraft: false,
    };

    const cases = [
      ['MERGEABLE', { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }, false],
      ['CLEAN fallback', { mergeable: '', mergeStateStatus: 'CLEAN' }, false],
      ['CONFLICTING', { mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' }, true],
    ];

    for (const [name, mergeability, shouldBlock] of cases) {
      const { observed } = await observeAmaSnapshotProjection({
        rootDir,
        reviewRow: baseReviewRow,
        candidate: { ...baseCandidate, ...mergeability },
      });
      const eligibility = isEligibleForAmaClosure(
        observed.reviewState,
        observed.prMetadata,
        observed.cfg,
        observed.options,
      );
      assert.equal(eligibility.reasons.includes('pr-not-mergeable'), shouldBlock, name);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveMergeAgentCoexistenceForWatcher recovers AMA dispatch failures via merge-agent on the normal posted-review path', async () => {
  const decision = await resolveMergeAgentCoexistenceForWatcher({
    reviewStateRow: makeReviewRow(),
    dispatchJob: {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 53,
      headSha: 'abc123',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    candidate: {
      headSha: 'abc123',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    labelNames: [],
    mergeAgentRequestEvent: null,
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    currentRevisionRef: 'abc123',
    logger: { log() {}, warn() {}, error() {} },
    maybeDispatchAmaClosureForImpl: async () => ({
      amaEnabled: true,
      dispatched: false,
      reason: 'dispatch-failed',
    }),
  });

  assert.equal(decision.outcome, 'dispatch-merge-agent');
  assert.equal(decision.amaClosureResult.reason, 'dispatch-failed');
  assert.deepEqual(decision.dispatchEnv, {
    AMA_OPERATOR_MERGE_AGENT_OVERRIDE: 'true',
  });
});

test('resolveMergeAgentCoexistenceForWatcher treats eligible clean AMA dispatch as terminal, not await-operator', async () => {
  const decision = await resolveMergeAgentCoexistenceForWatcher({
    reviewStateRow: makeReviewRow(),
    dispatchJob: {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 53,
      headSha: 'abc123',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    candidate: {
      headSha: 'abc123',
      mergeStateStatus: 'CLEAN',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    labelNames: [],
    mergeAgentRequestEvent: null,
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    currentRevisionRef: 'abc123',
    logger: { log() {}, warn() {}, error() {} },
    maybeDispatchAmaClosureForImpl: async () => ({
      amaEnabled: true,
      dispatched: true,
      dispatchId: 'lrq_clean',
      workerClass: 'codex',
    }),
  });

  assert.equal(decision.outcome, 'ama-dispatched');
  assert.notEqual(decision.outcome, 'await-operator');
});

test('resolveMergeAgentCoexistenceForWatcher preserves await-operator with named ineligible reason', async () => {
  const decision = await resolveMergeAgentCoexistenceForWatcher({
    reviewStateRow: makeReviewRow(),
    dispatchJob: {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 53,
      headSha: 'abc123',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    candidate: {
      headSha: 'abc123',
      mergeStateStatus: 'CLEAN',
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
    },
    labelNames: [],
    mergeAgentRequestEvent: null,
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 53,
    currentRevisionRef: 'abc123',
    logger: { log() {}, warn() {}, error() {} },
    maybeDispatchAmaClosureForImpl: async () => ({
      amaEnabled: true,
      dispatched: false,
      reason: 'not-eligible',
      namedReason: 'not-eligible:blocking-findings-present',
      reasons: ['blocking-findings-present'],
    }),
  });

  assert.equal(decision.outcome, 'await-operator');
  assert.equal(decision.amaClosureResult.namedReason, 'not-eligible:blocking-findings-present');
});
