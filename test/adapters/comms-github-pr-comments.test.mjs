import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGitHubPRCommentsAdapter } from '../../src/adapters/comms/github-pr-comments/index.mjs';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
} from '../../src/review-state.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'comms-github-pr-comments-'));
}

function makeOctokit(calls) {
  return {
    rest: {
      issues: {
        async createComment(payload) {
          calls.push(payload);
          return {
            data: {
              id: calls.length,
              html_url: `https://github.test/comment/${calls.length}`,
            },
          };
        },
      },
    },
  };
}

function makeKey(overrides = {}) {
  return {
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/demo#7',
    revisionRef: 'sha-current',
    round: 1,
    kind: 'review-verdict',
    ...overrides,
  };
}

function readDeliveries(rootDir) {
  const db = openReviewStateDb(rootDir);
  try {
    return db.prepare(
      `SELECT domain_id, subject_external_id, revision_ref, round, delivery_kind, notice_ref, delivered
         FROM comment_deliveries
        ORDER BY id`
    ).all();
  } finally {
    db.close();
  }
}

test('adapter deliverReviewComment posts and persists the typed delivery key', async () => {
  const rootDir = makeRootDir();
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
    now: () => new Date('2026-05-11T12:00:00.000Z'),
  });

  const receipt = await adapter.deliverReviewComment({ body: 'Verdict body' }, makeKey());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'laceyenterprises');
  assert.equal(calls[0].repo, 'demo');
  assert.equal(calls[0].issue_number, 7);
  assert.equal(calls[0].body, 'Verdict body');
  assert.deepEqual(receipt.key, makeKey());

  const rows = readDeliveries(rootDir);
  assert.deepEqual(rows, [{
    domain_id: 'code-pr',
    subject_external_id: 'laceyenterprises/demo#7',
    revision_ref: 'sha-current',
    round: 1,
    delivery_kind: 'review-verdict',
    notice_ref: null,
    delivered: 1,
  }]);
});

test('adapter dedupe suppresses a second post for the same typed key', async () => {
  const rootDir = makeRootDir();
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
    now: () => new Date('2026-05-11T12:00:00.000Z'),
  });

  const first = await adapter.deliverReviewComment({ body: 'first' }, makeKey());
  const second = await adapter.deliverReviewComment({ body: 'second' }, makeKey());

  assert.equal(calls.length, 1);
  assert.equal(first.deliveryExternalId, second.deliveryExternalId);
  assert.equal(readDeliveries(rootDir).length, 1);
});

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
test('adapter claim lock suppresses concurrent duplicate posts for the same typed key', async () => {
  const rootDir = makeRootDir();
  const calls = [];
  const octokit = {
    rest: {
      issues: {
        async createComment(payload) {
          calls.push(payload);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            data: {
              id: calls.length,
              html_url: `https://github.test/comment/${calls.length}`,
            },
          };
        },
      },
    },
  };
  const adapterA = createGitHubPRCommentsAdapter({ rootDir, octokit });
  const adapterB = createGitHubPRCommentsAdapter({ rootDir, octokit });

  const [first, second] = await Promise.all([
    adapterA.deliverReviewComment({ body: 'first concurrent' }, makeKey({ revisionRef: 'sha-race' })),
    adapterB.deliverReviewComment({ body: 'second concurrent' }, makeKey({ revisionRef: 'sha-race' })),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(first.deliveryExternalId, second.deliveryExternalId);
  assert.equal(readDeliveries(rootDir).length, 1);
});

<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
test('adapter dedupe suppresses a legacy hit only when it matches the same head', async () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, domain_id, subject_external_id, revision_ref, reviewed_at, reviewer, review_status, review_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/demo',
      7,
      'code-pr',
      'laceyenterprises/demo#7',
      'sha-current',
      '2026-05-11T11:00:00.000Z',
      'codex',
      'posted',
      1
    );
  } finally {
    db.close();
  }

  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
  });

  const receipt = await adapter.deliverReviewComment({ body: 'should not post' }, makeKey());

  assert.equal(calls.length, 0);
  assert.match(receipt.deliveryExternalId, /^legacy-reviewed-pr:/);
});

test('adapter dedupe does not suppress a legacy hit from a different head', async () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, domain_id, subject_external_id, revision_ref, reviewed_at, reviewer, review_status, review_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/demo',
      7,
      'code-pr',
      'laceyenterprises/demo#7',
      'sha-old',
      '2026-05-11T11:00:00.000Z',
      'codex',
      'posted',
      1
    );
  } finally {
    db.close();
  }

  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
  });

  await adapter.deliverReviewComment({ body: 'new head gets a comment' }, makeKey());

  assert.equal(calls.length, 1);
  assert.equal(readDeliveries(rootDir)[0].revision_ref, 'sha-current');
});

test('adapter dedupe does not treat non-posted legacy rows as delivered', async () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, domain_id, subject_external_id, revision_ref, reviewed_at, reviewer, review_status, review_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/demo',
      7,
      'code-pr',
      'laceyenterprises/demo#7',
      'sha-current',
      '2026-05-11T11:00:00.000Z',
      'codex',
      'reviewing',
      1
    );
  } finally {
    db.close();
  }

  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
  });

  await adapter.deliverReviewComment({ body: 'still needs a post' }, makeKey());

  assert.equal(calls.length, 1);
});

test('adapter redacts public body content before posting', async () => {
  const rootDir = makeRootDir();
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
  });

  await adapter.deliverReviewComment({
    body: 'Token sk-1234567890abcdef leaked from /Users/airlock/private/app.js',
  }, makeKey({ revisionRef: 'sha-redact' }));

  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /\[REDACTED_OPENAI_TOKEN\]/);
  assert.match(calls[0].body, /<path-redacted>\/app\.js/);
  assert.doesNotMatch(calls[0].body, /sk-1234567890abcdef|\/Users\/airlock/);
});

test('operator notice noticeRef is distinct from review-verdict dedupe', async () => {
  const rootDir = makeRootDir();
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeOctokit(calls),
  });

  await adapter.deliverReviewComment({ body: 'review verdict' }, makeKey({ revisionRef: 'sha-notice' }));
  await adapter.deliverOperatorNotice(
    {
      type: 'halted',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-notice',
      },
      revisionRef: 'sha-notice',
      eventExternalId: 'notice-a',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice a',
    makeKey({ revisionRef: 'sha-notice', kind: 'operator-notice', noticeRef: 'notice-a' })
  );
  await adapter.deliverOperatorNotice(
    {
      type: 'halted',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-notice',
      },
      revisionRef: 'sha-notice',
      eventExternalId: 'notice-a',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice a duplicate',
    makeKey({ revisionRef: 'sha-notice', kind: 'operator-notice', noticeRef: 'notice-a' })
  );
  await adapter.deliverOperatorNotice(
    {
      type: 'halted',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-notice',
      },
      revisionRef: 'sha-notice',
      eventExternalId: 'notice-b',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice b',
    makeKey({ revisionRef: 'sha-notice', kind: 'operator-notice', noticeRef: 'notice-b' })
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(
    readDeliveries(rootDir).map((row) => [row.delivery_kind, row.notice_ref]),
    [
      ['review-verdict', null],
      ['operator-notice', 'notice-a'],
      ['operator-notice', 'notice-b'],
    ]
  );
});

test('adapter gh fallback passes only an allowlisted env and worker-routed GH_TOKEN', async () => {
  /** @type {Array<{cmd: string, args: string[], options: any}>} */
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    workerClass: 'codex',
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/Users/airlock',
      GH_CODEX_REVIEWER_TOKEN: 'codex-bot-token',
      OP_SERVICE_ACCOUNT_TOKEN: 'op-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-101\n' };
    },
  });

  const receipt = await adapter.deliverReviewComment({ body: 'gh review path' }, makeKey({ revisionRef: 'sha-gh' }));

  assert.equal(receipt.deliveryExternalId, 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-101');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].options.env, {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/airlock',
    GH_TOKEN: 'codex-bot-token',
  });
  assert.equal(calls[0].options.env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('adapter gh fallback requires explicit token routing for operator notices', async () => {
  const adapter = createGitHubPRCommentsAdapter({
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GITHUB_TOKEN: 'operator-token',
    },
    execFileImpl: async () => {
      throw new Error('should not run gh without routing');
    },
  });

  await assert.rejects(
    adapter.deliverOperatorNotice(
      {
        type: 'raised-round-cap',
        subjectRef: {
          domainId: 'code-pr',
          subjectExternalId: 'laceyenterprises/demo#7',
          revisionRef: 'sha-notice-gh',
        },
        revisionRef: 'sha-notice-gh',
        eventExternalId: 'notice-gh',
        observedAt: '2026-05-11T12:00:00.000Z',
      },
      'notice body',
      makeKey({ revisionRef: 'sha-notice-gh', kind: 'operator-notice', noticeRef: 'notice-gh' })
    ),
    /No gh token routing configured/
  );
});

test('adapter gh fallback honors explicit operator-notice token routing', async () => {
  /** @type {Array<{cmd: string, args: string[], options: any}>} */
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GITHUB_TOKEN: 'operator-token',
      GH_CODEX_REVIEWER_TOKEN: 'wrong-token',
    },
    resolveGhToken: () => ({ tokenEnvName: 'GITHUB_TOKEN' }),
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-102\n' };
    },
  });

  const receipt = await adapter.deliverOperatorNotice(
    {
      type: 'raised-round-cap',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-notice-gh',
      },
      revisionRef: 'sha-notice-gh',
      eventExternalId: 'notice-gh',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice body',
    makeKey({ revisionRef: 'sha-notice-gh', kind: 'operator-notice', noticeRef: 'notice-gh' })
  );

  assert.equal(receipt.deliveryExternalId, 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-102');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GH_TOKEN, 'operator-token');
<<<<<<< HEAD
=======
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
});

test('adapter gh fallback does not pass through GITHUB_TOKEN when an explicit token is resolved', async () => {
  /** @type {Array<{cmd: string, args: string[], options: any}>} */
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GITHUB_TOKEN: 'operator-token',
      GH_CODEX_REVIEWER_TOKEN: 'worker-token',
    },
    resolveGhToken: () => ({ token: 'explicit-bot-token', allowGhAuthFallback: true }),
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-104\n' };
    },
  });

  await adapter.deliverOperatorNotice(
    {
      type: 'raised-round-cap',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-explicit-token',
      },
      revisionRef: 'sha-explicit-token',
      eventExternalId: 'notice-explicit-token',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice body',
    makeKey({ revisionRef: 'sha-explicit-token', kind: 'operator-notice', noticeRef: 'notice-explicit-token' })
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/airlock',
    GH_TOKEN: 'explicit-bot-token',
  });
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
});

test('adapter gh fallback honors ambient GH_TOKEN when operator notices allow fallback auth', async () => {
  /** @type {Array<{cmd: string, args: string[], options: any}>} */
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GH_TOKEN: 'operator-fallback-token',
    },
    resolveGhToken: () => ({
      tokenEnvName: 'GITHUB_TOKEN',
      fallbackTokenEnvNames: ['GH_TOKEN'],
      allowGhAuthFallback: true,
    }),
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-103\n' };
    },
  });

  await adapter.deliverOperatorNotice(
    {
      type: 'raised-round-cap',
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: 'sha-notice-fallback',
      },
      revisionRef: 'sha-notice-fallback',
      eventExternalId: 'notice-fallback',
      observedAt: '2026-05-11T12:00:00.000Z',
    },
    'notice body',
    makeKey({ revisionRef: 'sha-notice-fallback', kind: 'operator-notice', noticeRef: 'notice-fallback' })
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GH_TOKEN, 'operator-fallback-token');
<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
});

test('adapter remediation-reply path fails closed until wired to the hardened renderer', async () => {
  const adapter = createGitHubPRCommentsAdapter({
    octokit: makeOctokit([]),
  });

  await assert.rejects(
    adapter.deliverRemediationReply(
      {
        kind: 'adversarial-review-remediation-reply',
        schemaVersion: 1,
        jobId: 'job-1',
        outcome: 'completed',
        summary: 'unsafe body',
        validation: [],
        blockers: [],
        reReview: { requested: true, reason: 'ready' },
      },
      makeKey({ kind: 'remediation-reply' })
    ),
    /does not support remediation-reply delivery/
  );
});
