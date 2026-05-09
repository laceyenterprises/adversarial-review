import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';
import {
  parseRemediationReply,
  validateRemediationReply,
} from '../src/kernel/remediation-reply.mjs';

// Fixtures are committed under test/fixtures/kernel/ so the suite runs the
// same on every host (CI, fresh clones, agent worktrees). Snapshots of real
// production review/remediation artifacts; do not edit by hand — regenerate
// by copying a fresh production blob and trimming if needed.
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kernel');

function readFixture(name) {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));
}

const passingVerdictJob = readFixture('passing-verdict-job.json');
const failingVerdictJob = readFixture('failing-verdict-job.json');
const remediationJob = failingVerdictJob;
const remediationReply = readFixture('remediation-reply.json');

test('kernel verdict parser accepts a production passing verdict and renders it stably', () => {
  const sanitized = sanitizeCodexReviewPayload(passingVerdictJob.reviewBody);

  assert.equal(sanitizeCodexReviewPayload(sanitized), sanitized);
  assert.equal(extractReviewVerdict(sanitized), 'Comment only');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'comment-only');
});

test('kernel verdict parser preserves a production failing verdict byte-for-byte', () => {
  const sanitized = sanitizeCodexReviewPayload(failingVerdictJob.reviewBody);

  assert.equal(sanitized, failingVerdictJob.reviewBody);
  assert.equal(extractReviewVerdict(sanitized), 'Request changes');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'request-changes');
});

test('kernel remediation-reply parser accepts a production reply without changing bytes', () => {
  const raw = JSON.stringify(remediationReply, null, 2);
  const parsed = parseRemediationReply(raw, { expectedJob: remediationJob });
  const validated = validateRemediationReply(remediationReply, { expectedJob: remediationJob });

  assert.deepEqual(parsed, remediationReply);
  assert.deepEqual(validated, remediationReply);
  assert.equal(JSON.stringify(validated, null, 2), raw);
});

test('kernel remediation-reply validator rejects blocked outcome with empty blockers', () => {
  const invalid = {
    ...remediationReply,
    outcome: 'blocked',
    blockers: [],
    reReview: { requested: false, reason: null },
  };

  assert.throws(
    () => validateRemediationReply(invalid, { expectedJob: remediationJob }),
    /outcome is "blocked" but blockers is empty/
  );
});
