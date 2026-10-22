import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPushedHammerAttestation } from '../src/ama/hammer-pushed-attestation.mjs';
import { exactHammerValidation, fetchHammerHeadRange, hammerAttestationChain } from '../src/ama/hammer-head-validation.mjs';
import { closerAuthoredStaleEligible, proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';

const baseHead = 'a'.repeat(40), pushedHead = 'b'.repeat(40), nextHead = 'c'.repeat(40);
function fixture(author = 'hammer-worker') {
  const comments = [], writes = [];
  const api = async (path, input) => {
    if (path === 'graphql') return { data: { viewer: { login: author } } };
    if (!input) return comments;
    writes.push(input);
    const comment = { id: writes.length, body: input.body, user: { login: author } };
    comments.push(comment);
    return comment;
  };
  return { comments, writes, args: { repo: 'example/repo', prNumber: 42, baseHead, pushedHead, api } };
}

test('HAMATTEST-02: pushed provenance survives an unvalidated no-merge exit and all readers agree', async () => {
  const f = fixture();
  assert.equal((await publishPushedHammerAttestation(f.args)).published, true);
  const comment = f.comments[0];
  comment.body += '\nHAM closing status — no merge. CI unavailable. Stopped before lease.\n';
  assert.match(comment.body, /HAM-CI-Validated: false/);
  assert.equal(exactHammerValidation(comment, pushedHead), false);
  const headProof = await proveCloserAuthoredStaleHead({ reviewedHead: baseHead, currentHead: pushedHead, comments: f.comments });
  assert.equal(headProof.proven, true);
  const range = await fetchHammerHeadRange({ repo: 'example/repo', reviewedHead: baseHead,
    currentHead: pushedHead, comments: f.comments, env: {},
    get: () => assert.fail('App provenance needs no commit-author fallback') });
  assert.equal(range.proof, 'hammer-app-attestation-chain');
  for (const [checksConclusion, decision] of [['PENDING', 'retry'], ['FAILURE', 'not-eligible'],
    [null, 'not-eligible'], ['SUCCESS', 'eligible']]) {
    const result = closerAuthoredStaleEligible({ headProof, verdict: 'settled-success',
      blockingFindingState: 'known', blockingFindingCount: 0, checksConclusion, mergeability: 'MERGEABLE' });
    assert.equal(result.carryForward, true);
    assert.equal(result.decision, decision);
    assert.equal(result.eligible, checksConclusion === 'SUCCESS');
    const closureOwner = decideClosureOwner({ closerAuthoredStale: result,
      reviewState: { headSha: baseHead, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      currentHead: pushedHead, checks: checksConclusion, mergeable: 'MERGEABLE' });
    assert.notEqual(closureOwner.owner, 'review', 'ownership and rescue honor the same carried verdict');
    assert.notEqual(classifyRescue({ closureOwner }).decision, 'rereview-eligible');
  }
  assert.equal((await publishPushedHammerAttestation(f.args)).duplicate, true);
  assert.equal(f.writes.length, 1);
});

test('HAMATTEST-02: foreign pushed edges and ambiguous pairs confer no provenance', async () => {
  const f = fixture('builder');
  await assert.rejects(publishPushedHammerAttestation(f.args), /entitled hammer App/);
  assert.equal(f.writes.length, 0);
  const body = `HAM-Base-Head: ${baseHead}\nHAM-Pushed-Head: ${pushedHead}\n`;
  for (const comment of [
    { author: 'builder', body }, { author: 'untrusted-operator', body },
    { author: 'hammer-worker', body: body + `HAM-Base-Head: ${nextHead}\n` },
    { author: 'hammer-worker', body: body + `HAM-Pushed-Head: ${nextHead}\n` },
    { author: 'hammer-worker', body: body + `HAM-Validated-Head: ${nextHead}\n` },
  ]) assert.equal(hammerAttestationChain([comment], baseHead, pushedHead), null);
});

test('HAMATTEST-02: mixed pushed/validated chains preserve validated behavior and exclude later foreign heads', () => {
  const comments = [
    { author: 'hammer-worker', body: `HAM-Base-Head: ${pushedHead}\nHAM-Validated-Head: ${nextHead}` },
    { author: { login: 'hammer-worker' }, body: `HAM-Base-Head: ${baseHead}\nHAM-Pushed-Head: ${pushedHead}` },
  ];
  assert.equal(exactHammerValidation(comments[0], nextHead), true);
  assert.deepEqual(hammerAttestationChain(comments, baseHead, nextHead), [pushedHead, nextHead]);
  assert.equal(hammerAttestationChain(comments, baseHead, 'd'.repeat(40)), null);
});

test('HAMATTEST-02: unchanged publication writes nothing; read and credential failures never claim success', async () => {
  const f = fixture();
  assert.equal((await publishPushedHammerAttestation({ ...f.args, pushedHead: baseHead })).published, false);
  assert.equal(f.writes.length, 0);
  await assert.rejects(publishPushedHammerAttestation({ ...f.args, baseHead: '' }), /invalid/);
  await assert.rejects(publishPushedHammerAttestation({ ...f.args, api: async () => { throw new Error('credentials unavailable'); } }), /credentials unavailable/);
});


test('HAMATTEST-02: ownership and rescue execute the shared unproven-head decision despite the old ceiling', async () => {
  const headProof = await proveCloserAuthoredStaleHead({ reviewedHead: baseHead, currentHead: pushedHead, comments: [] });
  const closerAuthoredStale = closerAuthoredStaleEligible({ headProof });
  const closureOwner = decideClosureOwner({ closerAuthoredStale, attested: true,
    reviewState: { headSha: baseHead, verdict: 'approved' }, currentHead: pushedHead,
    roundsLeft: false, reviewCeilingReached: true });
  assert.deepEqual(closureOwner, { owner: 'review', reason: 'exact-head-review' });
  assert.equal(classifyRescue({ closureOwner }).decision, 'rereview-eligible');
});
