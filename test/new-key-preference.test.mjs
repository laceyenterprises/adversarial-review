import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createGitHubPRCommentsAdapter,
  ensureCommentDeliverySchema,
} from '../src/adapters/comms/github-pr-comments/index.mjs';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
} from '../src/review-state.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'new-key-preference-'));
}

test('reader prefers new typed delivery key when both typed and legacy rows hit', async () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    ensureCommentDeliverySchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, domain_id, subject_external_id, revision_ref,
          reviewed_at, reviewer, review_status, review_attempts, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/demo',
      7,
      'code-pr',
      'laceyenterprises/demo#7',
      'sha-current',
      '2026-05-11T11:00:00.000Z',
      'codex',
      'posted',
      1,
      '2026-05-11T11:01:00.000Z'
    );
    db.prepare(
      `INSERT INTO comment_deliveries
         (domain_id, subject_external_id, revision_ref, round, delivery_kind,
          notice_ref, delivery_external_id, attempted_at, delivered_at, delivered,
          legacy_repo, legacy_pr_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'code-pr',
      'laceyenterprises/demo#7',
      'sha-current',
      1,
      'review-verdict',
      null,
      'typed-delivery-id',
      '2026-05-11T12:00:00.000Z',
      '2026-05-11T12:00:01.000Z',
      1,
      'laceyenterprises/demo',
      7
    );
  } finally {
    db.close();
  }

  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: {
      rest: {
        issues: {
          async createComment(payload) {
            calls.push(payload);
            return { data: { id: 'unexpected-post' } };
          },
        },
      },
    },
  });
  const key = {
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/demo#7',
    revisionRef: 'sha-current',
    round: 1,
    kind: 'review-verdict',
  };

  const existing = await adapter.lookupExistingDeliveries(key);
  const receipt = await adapter.deliverReviewComment({ body: 'should not post' }, key);

  assert.equal(calls.length, 0);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].deliveryExternalId, 'typed-delivery-id');
  assert.equal(receipt.deliveryExternalId, 'typed-delivery-id');
});
