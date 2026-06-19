import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  buildReviewCycleCapEscalationComment,
  hasReviewCycleEscalated,
  markReviewCycleEscalated,
  recentReviewCycleVerdicts,
  recordReviewCycleVerdict,
  shouldEscalateReviewCycle,
} from '../src/review-cycle-cap.mjs';
import {
  clearReviewCycleCapForOverride,
  postReviewCycleCapEscalation,
  addLabelToPRBestEffort,
  reviewBodyHasStandingBlockingFindings,
} from '../src/watcher.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 123;

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function record(db, n, at = `2026-06-04T0${n}:00:00.000Z`) {
  return recordReviewCycleVerdict(db, {
    repo: REPO,
    prNumber: PR,
    headSha: `sha-${n}`,
    verdictAt: at,
    verdictSummary: `## Summary\nVerdict ${n} still found blockers.`,
    windowHours: 24,
  });
}

test('5 successive verdicts each followed by a new commit make the 6th attempt escalate', () => {
  const db = setupDb();
  try {
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(record(db, i).count, i);
    }

    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-6',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T06:00:00.000Z',
    });

    assert.equal(decision.count, 6);
    assert.equal(decision.escalate, true);
    const recent = recentReviewCycleVerdicts(db, { repo: REPO, prNumber: PR, limit: 5 });
    const comment = buildReviewCycleCapEscalationComment({ cap: 5, recentVerdicts: recent });
    assert.match(comment, /Review cycle cap reached/);
    assert.match(comment, /operator-approved/);
    assert.match(comment, /merge-agent-requested/);
    assert.match(comment, /paused-for-redesign/);
  } finally {
    db.close();
  }
});

test('4 successive verdicts do not escalate', () => {
  const db = setupDb();
  try {
    for (let i = 1; i <= 4; i += 1) record(db, i);
    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-5',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T05:00:00.000Z',
    });
    assert.equal(decision.count, 5);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

test('same-head re-review does not increment the counter', () => {
  const db = setupDb();
  try {
    assert.equal(record(db, 1).count, 1);
    const sameHead = recordReviewCycleVerdict(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-1',
      verdictAt: '2026-06-04T02:00:00.000Z',
      verdictSummary: 'Same head review.',
      windowHours: 24,
    });
    assert.equal(sameHead.count, 1);

    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-2',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T03:00:00.000Z',
    });
    assert.equal(decision.count, 2);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

test('escalation dedupe is PR-scoped across later pushed heads', () => {
  const db = setupDb();
  try {
    for (let i = 1; i <= 5; i += 1) {
      record(db, i);
    }

    markReviewCycleEscalated(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-6',
      escalatedAt: '2026-06-04T06:00:00.000Z',
    });

    assert.equal(hasReviewCycleEscalated(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-7',
    }), true);
    const laterHeadDecision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-7',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T07:00:00.000Z',
    });
    assert.equal(laterHeadDecision.escalate, true);
    assert.equal(laterHeadDecision.alreadyEscalated, true);
  } finally {
    db.close();
  }
});

test('verdicts outside the review cycle window reset the counter', () => {
  const db = setupDb();
  try {
    recordReviewCycleVerdict(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'old-sha',
      verdictAt: '2026-06-04T00:00:00.000Z',
      verdictSummary: 'Old verdict.',
      windowHours: 24,
    });
    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'new-sha',
      cap: 5,
      windowHours: 24,
      now: '2026-06-05T01:00:01.000Z',
    });
    assert.equal(decision.count, 1);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

for (const overrideLabel of ['operator-approved', 'merge-agent-requested', PAUSED_FOR_REDESIGN_LABEL]) {
  test(`${overrideLabel} clears cycle-cap label, resets the counter, and sets resume status`, async () => {
    const db = setupDb();
    const removed = [];
    const octokit = {
      rest: {
        issues: {
          removeLabel: async (params) => {
            removed.push(params);
          },
        },
      },
    };

    try {
      db.prepare(
        `INSERT INTO reviewed_prs (
           repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
           failed_at, failure_message, labels_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        REPO,
        PR,
        '2026-06-04T01:00:00.000Z',
        'claude',
        'open',
        'failed',
        '2026-06-04T02:00:00.000Z',
        '[review-cycle-cap] automatic review paused',
        JSON.stringify([REVIEWER_CYCLE_CAP_REACHED_LABEL, overrideLabel]),
      );
      record(db, 1);
      markReviewCycleEscalated(db, {
        repo: REPO,
        prNumber: PR,
        headSha: 'sha-1',
        escalatedAt: '2026-06-04T02:00:00.000Z',
      });
      recordReviewCycleVerdict(db, {
        repo: REPO,
        prNumber: PR,
        headSha: 'sha-2',
        verdictAt: '2026-06-04T02:30:00.000Z',
        verdictSummary: 'New head after escalation.',
        windowHours: 24,
      });

      const result = await clearReviewCycleCapForOverride({
        db,
        octokit,
        repoPath: REPO,
        prNumber: PR,
        headSha: 'sha-2',
        labelNames: [REVIEWER_CYCLE_CAP_REACHED_LABEL, overrideLabel],
        logger: { log() {}, warn() {} },
      });

      assert.equal(result.cleared, true);
      assert.equal(result.overrideLabel, overrideLabel);
      assert.equal(removed.length, 1);
      assert.equal(removed[0].name, REVIEWER_CYCLE_CAP_REACHED_LABEL);
      const decision = shouldEscalateReviewCycle(db, {
        repo: REPO,
        prNumber: PR,
        headSha: 'sha-2',
        cap: 5,
        windowHours: 24,
        now: '2026-06-04T03:00:00.000Z',
      });
      assert.equal(decision.count, 1);
      assert.equal(decision.escalate, false);
      const row = db.prepare(
        'SELECT review_status, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
      ).get(REPO, PR);
      if (overrideLabel === PAUSED_FOR_REDESIGN_LABEL) {
        assert.equal(row.review_status, 'failed');
        assert.match(row.failure_message, /operator selected paused-for-redesign/);
      } else {
        assert.equal(row.review_status, 'posted');
        assert.equal(row.failed_at, null);
        assert.equal(row.failure_message, null);
      }
    } finally {
      db.close();
    }
  });
}

test('postReviewCycleCapEscalation posts only the comment (no label add) so the dedupe marker is not gated on label success', async () => {
  const calls = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (params) => {
          calls.push(['createComment', params]);
        },
        addLabels: async (params) => {
          calls.push(['addLabels', params]);
        },
      },
    },
  };

  await postReviewCycleCapEscalation(octokit, {
    repoPath: REPO,
    prNumber: PR,
    body: 'escalation body',
  });

  // The comment must post, and the label add must NOT happen inside this
  // function — the caller persists the escalation dedupe marker between the
  // two, then adds the label best-effort. This guarantees a transient
  // label-add failure can never unwind the marker and re-post the comment.
  assert.deepEqual(calls.map(([name]) => name), ['createComment']);
});

test('reviewBodyHasStandingBlockingFindings counts structured blockers and a None-only section', () => {
  const withBlocker = [
    '## Summary',
    'Found one issue.',
    '## Blocking issues',
    '- **A real blocker**',
    '  - File: src/x.mjs',
    '## Verdict',
    'Request changes',
  ].join('\n');
  assert.equal(reviewBodyHasStandingBlockingFindings(withBlocker), true);

  const noneOnly = [
    '## Summary',
    'All good.',
    '## Blocking issues',
    '- None.',
    '## Verdict',
    'Approved',
  ].join('\n');
  assert.equal(reviewBodyHasStandingBlockingFindings(noneOnly), false);
});

test('reviewBodyHasStandingBlockingFindings counts a legacy Request-changes review with no Blocking section (unknown fails safe)', () => {
  // Legacy unstructured review: Request changes verdict but no `## Blocking
  // issues` section. The canonical classifier returns state:'unknown' here.
  // The old local boolean returned false (under-counting → cap-evasion). It
  // must now accrue cap budget.
  const legacy = [
    '## Summary',
    'This still needs work before merge.',
    '## Verdict',
    'Request changes',
  ].join('\n');
  assert.equal(reviewBodyHasStandingBlockingFindings(legacy), true);
});

test('addLabelToPRBestEffort swallows transient label-add errors so the dedupe marker survives', async () => {
  const warnings = [];
  const octokit = {
    rest: {
      issues: {
        addLabels: async () => {
          const err = new Error('rate limited');
          err.status = 403;
          throw err;
        },
      },
    },
  };

  // Must not throw even though addLabels rejects.
  await addLabelToPRBestEffort(octokit, {
    repoPath: REPO,
    prNumber: PR,
    label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to add label/);
});
