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
