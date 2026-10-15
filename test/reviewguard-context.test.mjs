import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';

const guards = [{ check: 'Reject generated catalog edits', path: 'docs/CATALOG.md' }];

test('REVIEWGUARD-01: reviewer retains guard guidance in full and slim context', async () => {
  for (const slim of [false, true]) {
    const context = await buildReviewerExtraContext({
      repo: 'example/manual', prNumber: 1, guardForbiddenPaths: guards,
      reviewModeDecision: { slim, lowRiskClasses: ['docs'], stats: { files: 1, added: 5, removed: 0 } }, readFindingDisputeReservationsImpl: () => [],
      fetchLinkedSpecContentsImpl: async () => '', buildHardeningReviewContextImpl: async () => '',
      log: { error() {} },
    });
    assert.match(context, /Reject generated catalog edits/);
    assert.match(context, /docs\/CATALOG\.md/);
    assert.match(context, /never recommend editing/i);
  }
});

