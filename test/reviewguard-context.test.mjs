import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';
import { GUARD_POLICY_INSTRUCTIONS } from '../src/guard-forbidden-paths.mjs';

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

test('REVIEWGUARD-01: hammer resolves only guard-forbidden non-blocking remedies without an operator', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.ok(prompt.includes('bin/guard-forbidden-paths.mjs'));
  assert.ok(prompt.includes('Follow `instructions` and add `auditDetails` to the HAM audit'));
  assert.ok(GUARD_POLICY_INSTRUCTIONS.includes('Resolved-By-Policy: guard:<check name> forbids <path>'));
  assert.ok(/do not raise an operator decision/i.test(GUARD_POLICY_INSTRUCTIONS));
  assert.ok(GUARD_POLICY_INSTRUCTIONS.includes('Blocking findings keep'));
  assert.ok(GUARD_POLICY_INSTRUCTIONS.includes('every remaining finding still requires normal remediation'));
});
