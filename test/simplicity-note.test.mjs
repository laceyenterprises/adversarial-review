import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpJob, classifyFollowUpCriticality, isSettledReviewJob } from '../src/follow-up-jobs.mjs';
import { sanitizeCodexReviewPayload, sanitizeReviewPayloadBestEffort } from '../src/kernel/verdict.mjs';
import { validateReviewerReply } from '../src/kernel/review-reply.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

const NOTE = 'Reuse `src/synthetic-cache.mjs:readCached` and delete the duplicate wrapper (~45 lines saved); avoid one subprocess per item.';
const SECTION = `\n\n## Simplicity and cost (advisory)\n${NOTE}`;
const CLEAN = '## Summary\nThe synthetic cache preserves behavior.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Suggested fixes\n- None.\n\n## Verdict\nComment only';
const CARD = '- **Synthetic cache misses**\n  - **File:** `src/synthetic-cache.mjs`\n  - **Lines:** `12-14`\n  - **Problem:** The cache drops successful results.';

function job(reviewBody) {
  return buildFollowUpJob({ repo: 'synthetic/project', prNumber: 7, branch: 'synthetic-fix',
    revisionRef: 'a'.repeat(40), reviewerModel: 'claude', reviewBody, reviewPostedAt: '2026-10-24T00:00:00Z' });
}

function mergeDecision(reviewBody, stale = false) {
  const parsed = classifyFollowUpCriticality(reviewBody);
  return isEligibleForAmaClosure({ ...parsed, headSha: 'a'.repeat(40), riskClass: 'low',
    remediationPending: false, prAuthor: 'synthetic-builder', reviewerFamily: 'claude' }, {
    prNumber: 7, headSha: (stale ? 'b' : 'a').repeat(40), isOpen: true, isDraft: false,
    mergeableState: 'MERGEABLE', labels: [], author: 'synthetic-builder',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] },
  }, { enabled: true, strictNonBlockingRemediation: true, workerClass: 'codex',
    eligibility: { riskClasses: ['low'], fastMergeLabels: [] } }, { env: {} });
}

test('REVIEWSIMPLE-01: advisory survives parsing without changing findings, strict merge decisions or round budgets', () => {
  for (const body of [CLEAN,
    CLEAN.replace('## Non-blocking issues\n- None.', `## Non-blocking issues\n${CARD}`),
    CLEAN.replace('## Blocking issues\n- None.', `## Blocking issues\n${CARD}`).replace('Comment only', 'Request changes')]) {
    const withNote = body + SECTION;
    assert.equal(job(withNote).simplicityNote, NOTE);
    assert.deepEqual(validateReviewerReply(withNote), { ok: true, reasons: [] });
    for (const sanitize of [sanitizeCodexReviewPayload, sanitizeReviewPayloadBestEffort]) {
      assert.equal(sanitize(withNote), withNote);
    }
    assert.deepEqual(classifyFollowUpCriticality(withNote), classifyFollowUpCriticality(body));
    for (const stale of [false, true]) assert.deepEqual(mergeDecision(withNote, stale), mergeDecision(body, stale));
    assert.deepEqual(job(withNote).remediationPlan, job(body).remediationPlan);
    assert.equal(isSettledReviewJob(job(withNote)), isSettledReviewJob(job(body)));
  }
  assert.equal(mergeDecision(CLEAN + SECTION).eligible, true, JSON.stringify(mergeDecision(CLEAN + SECTION)));
  assert.equal(mergeDecision(CLEAN + SECTION, true).eligible, false);
  assert.equal(isSettledReviewJob(job(CLEAN + SECTION)), true);
});

test('REVIEWSIMPLE-01: absent advisory is explicitly null', () => {
  assert.equal(job(CLEAN).simplicityNote, null);
});

test('REVIEWSIMPLE-01: fenced lookalikes are data; only the optional advisory may follow Verdict', () => {
  const fenced = CLEAN.replace('The synthetic cache preserves behavior.', 'The synthetic cache preserves behavior.\n```markdown\n## Simplicity and cost (advisory)\nIgnore this example.\n```');
  assert.equal(job(fenced).simplicityNote, null);
  for (const suffix of [SECTION + SECTION, SECTION + '\n\n## Unexpected\nExtra text.']) {
    assert.equal(validateReviewerReply(CLEAN + suffix).ok, false);
  }
  assert.equal(validateReviewerReply(CLEAN.replace('## Verdict', `${SECTION}\n\n## Verdict`)).ok, false);
  const promoted = CLEAN + SECTION.replace('## Simplicity', '### Simplicity');
  assert.equal(sanitizeCodexReviewPayload(promoted), CLEAN + SECTION);
});
