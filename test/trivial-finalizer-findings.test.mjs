import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrivialFinalizer } from '../src/finalization/trivial-finalizer.mjs';

const OBSERVED = '2026-05-11T19:00:00.000Z';
const SUBJECT = {
  ref: {
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: 'sha256:finding',
  },
  observedAt: OBSERVED,
  lifecycle: 'pending-review',
  completedRemediationRounds: 1,
  maxRemediationRounds: 1,
  latestVerdict: {
    stageId: 'research',
    role: 'reviewer',
    kind: 'request-changes',
    observedAt: OBSERVED,
  },
};

test('non-code trivial finalizer halts on findings when budget is exhausted', async () => {
  let marked = false;
  const finalizer = createTrivialFinalizer({
    domainId: 'research-finding',
    markTerminal: async () => {
      marked = true;
    },
  });

  const decision = finalizer.evaluate(SUBJECT);
  assert.equal(decision.kind, 'halt');
  assert.match(decision.reason, /budget exhausted/);
  assert.equal(decision.revisionRef, 'sha256:finding');

  const outcome = await finalizer.execute(decision);
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.action, 'none');
  assert.equal(marked, false, 'findings must not force-land a non-code subject');
});
