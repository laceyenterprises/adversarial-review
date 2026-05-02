import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemediationOutcomeCommentBody } from '../src/pr-comments.mjs';

test('buildRemediationOutcomeCommentBody renders round-budget-exhausted with risk class and operator next step', () => {
  const body = buildRemediationOutcomeCommentBody({
    status: 'stopped',
    riskClass: 'medium',
    remediationPlan: {
      currentRound: 1,
      maxRounds: 1,
      stop: {
        code: 'round-budget-exhausted',
        maxRounds: 1,
      },
    },
  });

  assert.match(body, /\*\*Outcome:\*\* stopped \(`round-budget-exhausted`\)/);
  assert.match(body, /medium risk-class remediation budget \(1 round\)/);
  assert.match(body, /Completed remediation rounds: 1/);
  assert.match(body, /Operator next step:/);
  assert.match(body, /reopen the underlying spec and justify a higher risk class/);
});
