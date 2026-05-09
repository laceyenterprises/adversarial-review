import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';
import {
  parseRemediationReply,
  validateRemediationReply,
} from '../src/kernel/remediation-reply.mjs';

const productionFixtureRoot = '/Users/airlock/agent-os/tools/adversarial-review/data/follow-up-jobs/completed';
const productionReplyRoot = '/Users/airlock/agent-os-hq/dispatch/remediation-replies';

function readProductionJob(name) {
  const path = `${productionFixtureRoot}/${name}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readProductionReply(jobId) {
  const path = `${productionReplyRoot}/${jobId}/remediation-reply.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const passingVerdictJob = readProductionJob('laceyenterprises__adversarial-review-pr-35-2026-05-04T05-24-51-401Z.json');
const failingVerdictJob = readProductionJob('laceyenterprises__agent-os-pr-307-2026-05-09T20-33-22-761Z.json');
const remediationJob = failingVerdictJob;
const remediationReply = remediationJob ? readProductionReply(remediationJob.jobId) : null;

test('kernel verdict parser accepts a production passing verdict and renders it stably', { skip: !passingVerdictJob && 'production fixture missing' }, () => {
  const sanitized = sanitizeCodexReviewPayload(passingVerdictJob.reviewBody);

  assert.equal(sanitizeCodexReviewPayload(sanitized), sanitized);
  assert.equal(extractReviewVerdict(sanitized), 'Comment only');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'comment-only');
});

test('kernel verdict parser preserves a production failing verdict byte-for-byte', { skip: !failingVerdictJob && 'production fixture missing' }, () => {
  const sanitized = sanitizeCodexReviewPayload(failingVerdictJob.reviewBody);

  assert.equal(sanitized, failingVerdictJob.reviewBody);
  assert.equal(extractReviewVerdict(sanitized), 'Request changes');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'request-changes');
});

test('kernel remediation-reply parser accepts a production reply without changing bytes', { skip: (!remediationJob || !remediationReply) && 'production fixture missing' }, () => {
  const raw = JSON.stringify(remediationReply, null, 2);
  const parsed = parseRemediationReply(raw, { expectedJob: remediationJob });
  const validated = validateRemediationReply(remediationReply, { expectedJob: remediationJob });

  assert.deepEqual(parsed, remediationReply);
  assert.deepEqual(validated, remediationReply);
  assert.equal(JSON.stringify(validated, null, 2), raw);
});

test('kernel remediation-reply validator rejects blocked outcome with empty blockers', { skip: (!remediationJob || !remediationReply) && 'production fixture missing' }, () => {
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
