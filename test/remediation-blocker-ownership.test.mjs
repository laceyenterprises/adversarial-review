import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRemediationBlockers, operationalBlockerOwner,
} from '../src/remediation-blocker-ownership.mjs';
import { resolvePendingCiCompletion } from '../src/comment-only-final-round-completion.mjs';
import pendingCi from './fixtures/pending-ci-ownership/blocker.json' with { type: 'json' };

const legacyFollowup = 'Confirm required checks pass for the pushed head, then request another adversarial review pass.';

for (const [name, entry, owner] of [
  ['negated human decision', pendingCi, 'CI'],
  ['arbitrary prose', { ...pendingCi, reasoning: 'Operator approval, human decision, permissions, credentials and push failed.' }, 'CI'],
  ['empty input', { ...pendingCi, needsHumanInput: '  ' }, 'CI'],
  ['access request', { ...pendingCi, needsHumanInput: 'Grant access to the fixture repository.' }, 'human'],
  ['legacy sentence on tagged CI', { ...pendingCi, needsHumanInput: legacyFollowup }, 'CI'],
  ['appended access request', { ...pendingCi, needsHumanInput: `${legacyFollowup} Restore access first.` }, 'human'],
  ['declared non-CI code', { ...pendingCi, title: 'stale-pr-head' }, 'human'],
  ['other kind', { ...pendingCi, kind: 'unknown' }, 'human'],
  ['untagged operator approval', { finding: 'Required CI is pending; operator approval is required.' }, 'human'],
  ['untagged legacy sentence', { finding: 'Required CI is pending.', needsHumanInput: legacyFollowup }, 'CI'],
  ['untagged negated decision', { ...pendingCi, kind: undefined }, 'CI'],
  ['untagged negated approval', { finding: 'Required CI is pending. No human decision or operator approval is needed.' }, 'CI'],
  ['untagged negated permissions', { finding: 'Required CI is pending. No credentials or permissions are required.' }, 'CI'],
  ['negation followed by real request', { finding: 'CI is pending. No human decision is needed; operator approval is required.' }, 'human'],
  ['negation followed by access request', { ...pendingCi, kind: undefined, needsHumanInput: 'Restore access.' }, 'human'],
  ['legacy push failure', { finding: 'CI is pending. Push failed before publication.' }, 'human'],
]) {
  test(`PENDINGCIOWNER-01 ownership: ${name}`, () => {
    assert.equal(operationalBlockerOwner(entry), owner);
    assert.deepEqual(classifyRemediationBlockers({ outcome: 'partial', blockers: [], operationalBlockers: [entry] }), {
      humanRequired: owner === 'human', pipelineOwners: owner === 'human' ? [] : ['CI'],
    });
  });
}

test('PENDINGCIOWNER-01 the CI normalizer receives structured ownership and preserves human requests', async () => {
  const job = { revisionRef: 'a'.repeat(40), repo: 'example/fixture', prNumber: 42 };
  for (const human of [false, true]) {
    const entry = human ? { ...pendingCi, needsHumanInput: 'Restore repository access.' } : pendingCi;
    const reply = { outcome: 'partial', summary: `Pushed ${'b'.repeat(40)}.`,
      validation: [], blockers: [], operationalBlockers: [entry], reReview: { requested: false } };
    const result = await resolvePendingCiCompletion({
      job, reply, log: {},
      resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: job.revisionRef }),
    });
    assert.equal(result.reply.reReview.normalizedFrom, human ? undefined : 'ci-pending-only');
    assert.equal(result.reply.outcome, human ? 'partial' : 'completed');
    assert.deepEqual(result.reply.reReview.originalOperationalBlockers || result.reply.operationalBlockers, [entry]);
  }
});
