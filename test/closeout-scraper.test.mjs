import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  recordMergeCloseout,
  recordMergeCloseoutScrapeFailure,
  ensureReviewStateSchema,
  listPendingMergeCloseouts,
} from '../src/review-state.mjs';
import {
  fetchPullRequestCreatedAt,
  fetchIssueComments,
  scrapeMergeCloseout,
  scraperFetchIssueComments,
} from '../src/closeout-scraper.mjs';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

test('closeout comment readers prefer optional adapter payloads', async () => {
  const env = { GHA_ADAPTER_BIN: '/fixture/github-adapter' };
  const execFileImpl = async (command, args) => {
    assert.equal(command, '/fixture/github-adapter');
    assert.equal(args.includes('issue-comments'), true);
    return {
      stdout: JSON.stringify({
        comments: [{
          id: 'IC_adapter',
          nodeId: 'IC_node',
          authorLogin: 'operator',
          createdAt: '2026-05-20T20:40:00.000Z',
          updatedAt: '2026-05-20T20:41:00.000Z',
          body: '<!-- hq:closeout:pr -->Done',
          url: 'https://example.test/comment',
        }],
      }),
    };
  };

  assert.deepEqual(await scraperFetchIssueComments({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    env,
    execFileImpl,
    logger: { warn() {} },
  }), [{
    id: 'IC_adapter',
    login: 'operator',
    created_at: '2026-05-20T20:40:00.000Z',
    body: '<!-- hq:closeout:pr -->Done',
  }]);

  assert.deepEqual(await fetchIssueComments({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    env,
    execFileImpl,
  }), [{
    id: 'IC_adapter',
    nodeId: 'IC_node',
    body: '<!-- hq:closeout:pr -->Done',
    createdAt: '2026-05-20T20:40:00.000Z',
    updatedAt: '2026-05-20T20:41:00.000Z',
    authorLogin: 'operator',
    url: 'https://example.test/comment',
  }]);
});

test('closeout PR created-at reader prefers optional adapter metadata', async () => {
  const calls = [];
  const createdAt = await fetchPullRequestCreatedAt({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    env: { GHA_ADAPTER_BIN: '/fixture/github-adapter' },
    execFileImpl: async (command, args) => {
      calls.push({ command, args: [...args] });
      assert.equal(command, '/fixture/github-adapter');
      assert.equal(args.includes('pull-request'), true);
      return {
        stdout: JSON.stringify({
          pullRequest: {
            number: 17,
            createdAt: '2026-05-20T19:45:00.000Z',
          },
        }),
      };
    },
  });

  assert.equal(createdAt, '2026-05-20T19:45:00.000Z');
  assert.equal(calls.length, 1);
});

test('closeout PR created-at reader falls back to gh on malformed adapter output', async () => {
  const calls = [];
  const createdAt = await fetchPullRequestCreatedAt({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    env: { GHA_ADAPTER_BIN: '/fixture/github-adapter' },
    execFileImpl: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === '/fixture/github-adapter') {
        return { stdout: '{not json' };
      }
      assert.equal(command, 'gh');
      return {
        stdout: JSON.stringify({ created_at: '2026-05-20T19:50:00.000Z' }),
      };
    },
  });

  assert.equal(createdAt, '2026-05-20T19:50:00.000Z');
  assert.deepEqual(calls.map((call) => call.command), ['/fixture/github-adapter', 'gh']);
});

function seedReviewerPass(db, {
  repo = 'laceyenterprises/adversarial-review',
  prNumber = 17,
  attemptNumber = 1,
  reviewerClass = 'codex',
  reviewerModel = 'codex',
  passKind = 'first-pass',
  startedAt = '2026-05-20T20:00:00.000Z',
  endedAt = '2026-05-20T20:30:00.000Z',
  status = endedAt ? 'completed' : 'running',
} = {}) {
  db.prepare(
    `INSERT INTO reviewer_passes (
       repo, pr_number, attempt_number, reviewer_class, reviewer_model,
       pass_kind, started_at, ended_at, status, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
  ).run(
    repo,
    prNumber,
    attemptNumber,
    reviewerClass,
    reviewerModel,
    passKind,
    startedAt,
    endedAt,
    status
  );
}

function seedMergedReviewRow(db, {
  repo = 'laceyenterprises/adversarial-review',
  prNumber = 17,
  reviewedAt = '2026-05-20T19:00:00.000Z',
  mergedAt = '2026-05-20T20:55:00.000Z',
} = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, review_status
     ) VALUES (?, ?, ?, 'claude', 'merged', ?, 'posted')`
  ).run(repo, prNumber, reviewedAt, mergedAt);
}

function readCloseoutRow(db, repo = 'laceyenterprises/adversarial-review', prNumber = 17) {
  return db.prepare(
    'SELECT * FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ?'
  ).get(repo, prNumber) || null;
}

test('happy path captures in-window closeout comments and artifact refs', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_kwDOABCD1234',
        login: 'claude-code',
        created_at: '2026-05-20T20:47:12.000Z',
        body: 'Addressed X and Y.',
      },
      {
        id: 'IC_kwDOABCD5678',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:51:45.000Z',
        body: 'Deferred Z to LAC-456.',
      },
    ]),
  });

  assert.equal(result.ok, true);
  assert.match(result.closeoutBodyMd, /### Closeout 2026-05-20T20:47:12Z claude-code/);
  assert.match(result.closeoutBodyMd, /Addressed X and Y\./);
  assert.match(result.closeoutBodyMd, /### Closeout 2026-05-20T20:51:45Z virtualpaul/);
  assert.match(result.closeoutBodyMd, /Deferred Z to LAC-456\./);

  const row = readCloseoutRow(db);
  assert.ok(row.body_captured_at);
  assert.equal(row.empty_confirmed_at, null);
  assert.deepEqual(JSON.parse(row.closeout_authors_json), ['claude-code', 'virtualpaul']);
  assert.deepEqual(
    JSON.parse(row.gh_artifact_refs),
    [
      { kind: 'issue_comment', id: 'IC_kwDOABCD1234' },
      { kind: 'issue_comment', id: 'IC_kwDOABCD5678' },
    ]
  );
});

test('pre-settling empty case remains retryable debt', async () => {
  const db = setupDb();
  seedMergedReviewRow(db);
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T21:03:00.000Z'),
    fetchIssueCommentsImpl: async () => [],
  });

  const row = readCloseoutRow(db);
  assert.equal(row.closeout_body_md, null);
  assert.equal(row.body_captured_at, null);
  assert.ok(row.scrape_last_checked_at);
  assert.equal(row.empty_confirmed_at, null);
  assert.equal(JSON.parse(row.gh_artifact_refs).length, 0);
  const pending = listPendingMergeCloseouts(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].repo, 'laceyenterprises/adversarial-review');
  assert.equal(pending[0].pr_number, 17);
  assert.equal(pending[0].merged_at, '2026-05-20T20:55:00.000Z');
  assert.equal(pending[0].empty_confirmed_at, null);
});

test('settled empty case records terminal-empty timestamp', async () => {
  const db = setupDb();
  seedMergedReviewRow(db);
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T21:06:00.000Z'),
    fetchIssueCommentsImpl: async () => [],
  });

  const row = readCloseoutRow(db);
  assert.equal(row.closeout_body_md, null);
  assert.ok(row.scrape_last_checked_at);
  assert.ok(row.empty_confirmed_at);
  // Settled-empty rows are kept observable on a slower cadence (default
  // 1 hour). Right after settling they should NOT be in the immediate
  // pending list. But once enough time passes, they reappear so a late
  // closeout posted past T+10min still has a path to upgrade the row.
  assert.deepEqual(
    listPendingMergeCloseouts(db, { now: new Date('2026-05-20T21:06:30.000Z') }),
    []
  );
  const lateRescrape = listPendingMergeCloseouts(db, {
    now: new Date('2026-05-20T22:30:00.000Z'),
  });
  assert.equal(lateRescrape.length, 1);
  assert.equal(lateRescrape[0].pr_number, 17);
  assert.ok(lateRescrape[0].empty_confirmed_at);
});

test('late closeout posted past 10-minute settle upgrades the row', async () => {
  const db = setupDb();
  seedMergedReviewRow(db);
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T21:06:00.000Z'),
    fetchIssueCommentsImpl: async () => [],
  });
  assert.ok(readCloseoutRow(db).empty_confirmed_at);

  // Operator posts a closeout 20 minutes later; the row must upgrade
  // from settled-empty to a captured body, not be silently ignored.
  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T22:00:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_late',
        login: 'virtualpaul',
        created_at: '2026-05-20T21:15:00.000Z',
        body: 'Late closeout reply.',
      },
    ]),
  });

  const upgraded = readCloseoutRow(db);
  assert.match(upgraded.closeout_body_md || '', /Late closeout reply/);
  assert.equal(upgraded.empty_confirmed_at, null);
});

test('merged before any rereview falls back to PR created_at', async () => {
  const db = setupDb();
  seedReviewerPass(db, {
    endedAt: null,
    status: 'running',
  });

  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchPullRequestCreatedAtImpl: async () => '2026-05-20T19:45:00.000Z',
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_kwDOABCD7777',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:10:00.000Z',
        body: 'Closed out before any rereview completed.',
      },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.lowerBound, '2026-05-20T19:45:00.000Z');
  assert.match(readCloseoutRow(db).closeout_body_md, /Closed out before any rereview completed/);
});

test('reviewer-authored closeout comments are excluded', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_reviewer',
        login: 'codex-reviewer-lacey',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Reviewer comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:45:00.000Z',
        body: 'Operator closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Reviewer comment must be excluded/);
  assert.match(row.closeout_body_md, /Operator closeout stays/);
  assert.deepEqual(JSON.parse(row.closeout_authors_json), ['virtualpaul']);
});

test('reviewer login exclusion is case-insensitive', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_reviewer_upper',
        login: 'CODEX-REVIEWER-LACEY',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Uppercase reviewer comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'claude-code',
        created_at: '2026-05-20T20:42:00.000Z',
        body: 'Non-reviewer closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Uppercase reviewer comment/);
  assert.match(row.closeout_body_md, /Non-reviewer closeout stays/);
  assert.deepEqual(JSON.parse(row.closeout_authors_json), ['claude-code']);
});

test('reviewer-lacey suffix and [bot] suffix logins are excluded', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_other_reviewer',
        login: 'some-future-reviewer-lacey',
        created_at: '2026-05-20T20:38:00.000Z',
        body: 'Unmapped reviewer login must be excluded.',
      },
      {
        id: 'IC_gh_bot',
        login: 'github-actions[bot]',
        created_at: '2026-05-20T20:39:00.000Z',
        body: 'CI bot comment must be excluded.',
      },
      {
        id: 'IC_dependabot',
        login: 'dependabot[bot]',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Dependabot comment must be excluded.',
      },
      {
        id: 'IC_clio',
        login: 'clio-agent',
        created_at: '2026-05-20T20:41:00.000Z',
        body: 'Builder bot self-comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:45:00.000Z',
        body: 'Operator closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Unmapped reviewer login/);
  assert.doesNotMatch(row.closeout_body_md, /CI bot comment/);
  assert.doesNotMatch(row.closeout_body_md, /Dependabot comment/);
  assert.doesNotMatch(row.closeout_body_md, /Builder bot self-comment/);
  assert.match(row.closeout_body_md, /Operator closeout stays/);
  assert.deepEqual(JSON.parse(row.closeout_authors_json), ['virtualpaul']);
});

test('transient gh failure persists scrape-debt row with attempt counter and next scrape can resume', async () => {
  const db = setupDb();
  seedReviewerPass(db);
  const warnings = [];

  let ghAttempts = 0;
  const failed = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    logger: { warn: (message) => warnings.push(message), log() {} },
    sleepImpl: async () => {},
    fetchIssueCommentsImpl: async () => {
      ghAttempts += 1;
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    },
  });

  assert.equal(failed.ok, false);
  assert.equal(ghAttempts, 3);
  const failureRow = readCloseoutRow(db);
  assert.ok(failureRow, 'expected scrape-failure row to be persisted for triage');
  assert.equal(failureRow.closeout_body_md, null);
  assert.equal(failureRow.empty_confirmed_at, null);
  assert.equal(failureRow.scrape_attempt_count, 1);
  assert.match(failureRow.scrape_last_error || '', /socket hang up/);
  assert.match(warnings.join('\n'), /leaving debt outstanding/);

  const resumed = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_resume',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:50:00.000Z',
        body: 'Recovered on a later poll.',
      },
    ]),
  });

  assert.equal(resumed.ok, true);
  assert.match(readCloseoutRow(db).closeout_body_md, /Recovered on a later poll/);
});

test('repeated scrape failures bump scrape_attempt_count for triage', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  for (let i = 0; i < 3; i += 1) {
    await scrapeMergeCloseout({
      db,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 17,
      mergedAt: '2026-05-20T20:55:00.000Z',
      logger: { warn() {}, log() {} },
      sleepImpl: async () => {},
      fetchIssueCommentsImpl: async () => {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      },
    });
  }

  const row = readCloseoutRow(db);
  assert.equal(row.scrape_attempt_count, 3);
  assert.match(row.scrape_last_error || '', /socket hang up/);
});

test('monotonic idempotency preserves richer prior capture on empty rerun', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_first',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:50:00.000Z',
        body: 'Initial capture.',
      },
    ]),
  });
  const firstRow = readCloseoutRow(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T21:10:00.000Z'),
    fetchIssueCommentsImpl: async () => [],
  });

  const secondRow = readCloseoutRow(db);
  assert.equal(secondRow.closeout_body_md, firstRow.closeout_body_md);
  assert.equal(secondRow.closeout_authors_json, firstRow.closeout_authors_json);
  assert.equal(secondRow.gh_artifact_refs, firstRow.gh_artifact_refs);
  assert.equal(secondRow.empty_confirmed_at, null);
});

test('gh_artifact_refs stores only {kind, id} objects', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_shape',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:50:00.000Z',
        body: 'Shape check.',
      },
    ]),
  });

  const refs = JSON.parse(readCloseoutRow(db).gh_artifact_refs);
  assert.deepEqual(refs, [{ kind: 'issue_comment', id: 'IC_shape' }]);
  assert.deepEqual(Object.keys(refs[0]).sort(), ['id', 'kind']);
});

test('benign gh stderr alongside parsed stdout is accepted, not retried as fatal', async () => {
  // Reviewer flagged the original fail-closed behavior as outage-class:
  // a persistent `gh` update/deprecation/ratelimit banner on stderr
  // would brick every closeout capture host-wide. The fix is to trust
  // a parsed non-empty stdout and log stderr at warn.
  const db = setupDb();
  seedReviewerPass(db);
  const warnings = [];

  let attempts = 0;
  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    logger: { warn: (m) => warnings.push(m), log() {} },
    sleepImpl: async () => {},
    fetchIssueCommentsImpl: undefined,
    execFileImpl: async (bin, args) => {
      if (bin !== 'gh') throw new Error(`unexpected bin ${bin}`);
      const subjectArg = String(args?.[2] || '');
      if (subjectArg.includes('issues/')) {
        attempts += 1;
        return {
          stdout: '{"id":"IC_partial","login":"virtualpaul","created_at":"2026-05-20T20:45:00.000Z","body":"benign-stderr"}\n',
          stderr: 'Warning: ratelimit exceeded',
        };
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 1, 'parsed stdout should be accepted on the first attempt');
  const row = readCloseoutRow(db);
  assert.match(row.closeout_body_md || '', /benign-stderr/);
  assert.match(warnings.join('\n'), /accepting parsed result/);
});

test('fatal-shaped gh stderr is still treated as retryable failure even with parsed stdout', async () => {
  const db = setupDb();
  seedReviewerPass(db);
  const warnings = [];

  let attempts = 0;
  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    logger: { warn: (m) => warnings.push(m), log() {} },
    sleepImpl: async () => {},
    execFileImpl: async (bin, args) => {
      if (bin !== 'gh') throw new Error(`unexpected bin ${bin}`);
      const subjectArg = String(args?.[2] || '');
      if (subjectArg.includes('issues/')) {
        attempts += 1;
        return {
          stdout: '{"id":"IC_partial","login":"virtualpaul","created_at":"2026-05-20T20:45:00.000Z","body":"partial"}\n',
          stderr: 'gh: HTTP 502: Bad Gateway',
        };
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(attempts, 3);
  const row = readCloseoutRow(db);
  assert.ok(row, 'expected failure-debt row to be persisted');
  assert.equal(row.closeout_body_md, null);
  assert.equal(row.scrape_attempt_count, 1);
  assert.match(row.scrape_last_error || '', /fatal-shaped stderr|HTTP 502/);
});

test('non-empty gh stderr with empty parsed stdout still retries and fails', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  let attempts = 0;
  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    logger: { warn() {}, log() {} },
    sleepImpl: async () => {},
    execFileImpl: async (bin, args) => {
      if (bin !== 'gh') throw new Error(`unexpected bin ${bin}`);
      const subjectArg = String(args?.[2] || '');
      if (subjectArg.includes('issues/')) {
        attempts += 1;
        return {
          stdout: '',
          stderr: 'Note: gh CLI authentication may have changed',
        };
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(attempts, 3);
  const row = readCloseoutRow(db);
  assert.ok(row, 'expected failure-debt row to be persisted');
  assert.match(row.scrape_last_error || '', /stderr|no parsed comments/);
});

test('non-JSON gh stdout line is skipped-and-warned alongside parsed entries', async () => {
  // Reviewer flagged the original throw-on-bad-line behavior as the
  // same fail-closed shape as the stderr case: an in-band banner on
  // stdout would discard every parsed comment from that page. The fix
  // is to skip-and-warn on individual bad lines and keep the parsed
  // entries.
  const db = setupDb();
  seedReviewerPass(db);
  const warnings = [];

  let attempts = 0;
  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    logger: { warn: (m) => warnings.push(m), log() {} },
    sleepImpl: async () => {},
    execFileImpl: async (bin, args) => {
      if (bin !== 'gh') throw new Error(`unexpected bin ${bin}`);
      const subjectArg = String(args?.[2] || '');
      if (subjectArg.includes('issues/')) {
        attempts += 1;
        return {
          stdout: 'gh: in-band banner\n{"id":"IC_ok","login":"virtualpaul","created_at":"2026-05-20T20:45:00.000Z","body":"good-line"}\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 1, 'should accept after skipping the bad line');
  assert.match(readCloseoutRow(db).closeout_body_md || '', /good-line/);
  assert.match(warnings.join('\n'), /non-JSON line/);
});

test('all-non-JSON gh stdout retries and fails as a parse error', async () => {
  const db = setupDb();
  seedReviewerPass(db);

  let attempts = 0;
  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    logger: { warn() {}, log() {} },
    sleepImpl: async () => {},
    execFileImpl: async (bin, args) => {
      if (bin !== 'gh') throw new Error(`unexpected bin ${bin}`);
      const subjectArg = String(args?.[2] || '');
      if (subjectArg.includes('issues/')) {
        attempts += 1;
        return {
          stdout: 'gh: in-band banner\nNot-JSON\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(attempts, 3);
  const row = readCloseoutRow(db);
  assert.match(row.scrape_last_error || '', /non-JSON/);
});

test('sqlite transient retry succeeds within the bounded backoff budget', async () => {
  const db = setupDb();
  seedReviewerPass(db);
  let persistAttempts = 0;

  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    sleepImpl: async () => {},
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_sqlite',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:50:00.000Z',
        body: 'SQLite retry path.',
      },
    ]),
    recordMergeCloseoutImpl: (...args) => {
      persistAttempts += 1;
      if (persistAttempts === 1) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return recordMergeCloseout(...args);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(persistAttempts, 2);
  assert.match(readCloseoutRow(db).closeout_body_md, /SQLite retry path/);
});

test('clio-agent reviewer-class login excludes the codex reviewer bot', async () => {
  // CLAUDE.md adversarial-review routing: clio-agent (builder) PRs are
  // reviewed by Codex, so the reviewer login under clio-agent is the
  // codex-reviewer-lacey bot. If the exclusion map misattributed this,
  // the real reviewer's comments would leak into the operator closeout.
  const db = setupDb();
  seedReviewerPass(db, { reviewerClass: 'clio-agent', reviewerModel: 'codex' });

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_codex_reviewer',
        login: 'codex-reviewer-lacey',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Codex reviewer comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:45:00.000Z',
        body: 'Operator closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Codex reviewer comment must be excluded/);
  assert.match(row.closeout_body_md, /Operator closeout stays/);
});

test('historical gemini builder-tag closeouts still exclude the Codex reviewer bot', async () => {
  const db = setupDb();
  seedReviewerPass(db, { reviewerClass: 'gemini', reviewerModel: null });

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_codex_reviewer',
        login: 'codex-reviewer-lacey',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Historical Codex reviewer comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:45:00.000Z',
        body: 'Operator closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Historical Codex reviewer comment must be excluded/);
  assert.match(row.closeout_body_md, /Operator closeout stays/);
});

test('native Gemini closeouts exclude the Gemini reviewer bot', async () => {
  const db = setupDb();
  seedReviewerPass(db, { reviewerClass: 'gemini', reviewerModel: 'gemini' });

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    now: new Date('2026-05-20T20:56:00.000Z'),
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_gemini_reviewer',
        login: 'gemini-reviewer-lacey',
        created_at: '2026-05-20T20:40:00.000Z',
        body: 'Native Gemini reviewer comment must be excluded.',
      },
      {
        id: 'IC_operator',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:45:00.000Z',
        body: 'Operator closeout stays.',
      },
    ]),
  });

  const row = readCloseoutRow(db);
  assert.doesNotMatch(row.closeout_body_md, /Native Gemini reviewer comment must be excluded/);
  assert.match(row.closeout_body_md, /Operator closeout stays/);
});

test('successful capture clears scrape_attempt_count and scrape_last_error', async () => {
  // Reviewer flagged that recovered rows kept their failure-derived
  // attempt count and stale last-error string forever, breaking triage
  // dashboards that page on those columns.
  const db = setupDb();
  seedReviewerPass(db);

  for (let i = 0; i < 3; i += 1) {
    await scrapeMergeCloseout({
      db,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 17,
      mergedAt: '2026-05-20T20:55:00.000Z',
      logger: { warn() {}, log() {} },
      sleepImpl: async () => {},
      fetchIssueCommentsImpl: async () => {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      },
    });
  }
  assert.equal(readCloseoutRow(db).scrape_attempt_count, 3);
  assert.match(readCloseoutRow(db).scrape_last_error || '', /socket hang up/);

  await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    fetchIssueCommentsImpl: async () => ([
      {
        id: 'IC_recovered',
        login: 'virtualpaul',
        created_at: '2026-05-20T20:50:00.000Z',
        body: 'Recovered closeout body.',
      },
    ]),
  });

  const recovered = readCloseoutRow(db);
  assert.match(recovered.closeout_body_md || '', /Recovered closeout body/);
  assert.equal(recovered.scrape_attempt_count, 0);
  assert.equal(recovered.scrape_last_error, null);
});

test('failure-debt persist retries SQLITE_BUSY before giving up', async () => {
  // Without this retry the success path tolerates SQLITE_BUSY but the
  // failure path silently drops the attempt-count bump under the same
  // contention. That defeats the chronic-failure triage signal.
  const db = setupDb();
  seedReviewerPass(db);

  let failureAttempts = 0;

  const result = await scrapeMergeCloseout({
    db,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    mergedAt: '2026-05-20T20:55:00.000Z',
    logger: { warn() {}, log() {} },
    sleepImpl: async () => {},
    fetchIssueCommentsImpl: async () => {
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    },
    recordMergeCloseoutScrapeFailureImpl: (...args) => {
      failureAttempts += 1;
      if (failureAttempts === 1) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return recordMergeCloseoutScrapeFailure(...args);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(failureAttempts, 2, 'should retry SQLITE_BUSY on the failure-debt persist');
  const row = readCloseoutRow(db);
  assert.ok(row, 'failure debt should land after the SQLITE_BUSY retry');
  assert.equal(row.scrape_attempt_count, 1);
});
