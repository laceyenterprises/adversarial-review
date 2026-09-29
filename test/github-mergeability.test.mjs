import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closureGateMergeability,
  isGithubMergeConflict,
  normalizeGithubMergeability,
  resolveMergeabilityWithSampling,
} from '../src/github-mergeability.mjs';

const noSleep = async () => {};

test('isGithubMergeConflict: only a raw conflict, never BLOCKED/UNSTABLE/BEHIND', () => {
  assert.equal(isGithubMergeConflict({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), true);
  assert.equal(isGithubMergeConflict({ mergeable: 'conflicting' }), true);
  assert.equal(isGithubMergeConflict({ mergeable: '', mergeStateStatus: 'DIRTY' }), true);
  for (const mergeStateStatus of ['BLOCKED', 'UNSTABLE', 'BEHIND', 'CLEAN', 'UNKNOWN', '']) {
    for (const mergeable of ['', null, undefined, 'MERGEABLE', 'UNKNOWN']) {
      assert.equal(isGithubMergeConflict({ mergeable, mergeStateStatus }), false, `${mergeable}/${mergeStateStatus}`);
    }
  }
  // These still normalize to a non-MERGEABLE state the gate reads as pr-not-mergeable.
  assert.equal(closureGateMergeability({ mergeable: '', mergeStateStatus: 'BLOCKED' }), 'BLOCKED');
  assert.equal(isGithubMergeConflict(), false);
});

test('normalizeGithubMergeability: terminal + UNKNOWN+CLEAN cases', () => {
  assert.equal(normalizeGithubMergeability({ mergeable: 'MERGEABLE' }), 'MERGEABLE');
  assert.equal(normalizeGithubMergeability({ mergeable: 'CONFLICTING' }), 'CONFLICTING');
  // UNKNOWN mergeable but CLEAN state is effectively mergeable.
  assert.equal(normalizeGithubMergeability({ mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' }), 'MERGEABLE');
  // Fully unresolved → not terminal.
  assert.equal(normalizeGithubMergeability({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), 'UNKNOWN');
});

test('sampling returns immediately when the first read is already terminal (no refetch)', async () => {
  let refetches = 0;
  const refetch = async () => { refetches += 1; return {}; };
  const out = await resolveMergeabilityWithSampling(
    { mergeable: 'MERGEABLE' }, refetch, { attempts: 3, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(out.normalized, 'MERGEABLE');
  assert.equal(out.resolved, true);
  assert.equal(out.samples, 1);
  assert.equal(refetches, 0, 'a terminal first read must not re-poll');
});

test('CONFLICTING is terminal — stops sampling immediately', async () => {
  let refetches = 0;
  const out = await resolveMergeabilityWithSampling(
    { mergeable: 'CONFLICTING' }, async () => { refetches += 1; return {}; },
    { attempts: 3, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(out.normalized, 'CONFLICTING');
  assert.equal(out.resolved, true);
  assert.equal(refetches, 0);
});

test('transient UNKNOWN resolves to MERGEABLE on a later sample', async () => {
  const reads = [
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, // 2nd read still computing
    { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, // 3rd read resolved
  ];
  let i = 0;
  const out = await resolveMergeabilityWithSampling(
    { mergeable: 'UNKNOWN', mergeStateStatus: '' }, // 1st read
    async () => reads[i++],
    { attempts: 4, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(out.normalized, 'MERGEABLE');
  assert.equal(out.resolved, true);
  assert.equal(out.samples, 3);
});

test('exhausting the window returns resolved=false with the last reading', async () => {
  const out = await resolveMergeabilityWithSampling(
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    async () => ({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    { attempts: 3, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(out.resolved, false);
  assert.equal(out.samples, 3);
  assert.equal(out.normalized, 'UNKNOWN');
});

test('a refetch that throws does not collapse the window; later success still resolves', async () => {
  let i = 0;
  const out = await resolveMergeabilityWithSampling(
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    async () => {
      i += 1;
      if (i === 1) throw new Error('transient gh failure');
      return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    },
    { attempts: 4, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(out.resolved, true);
  assert.equal(out.normalized, 'MERGEABLE');
});

test('DIRTYOWN-01: the closure-gate classifier re-samples a raw UNKNOWN beside CLEAN', async () => {
  const first = { mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' };
  let refetches = 0;
  const defaultOut = await resolveMergeabilityWithSampling(
    first, async () => { refetches += 1; return {}; },
    { attempts: 3, delayMs: 0, sleepImpl: noSleep },
  );
  assert.equal(defaultOut.normalized, 'MERGEABLE', 'the default classifier treats UNKNOWN+CLEAN as settled');
  assert.equal(refetches, 0);

  const reads = [
    { mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' },
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  ];
  let i = 0;
  const gateOut = await resolveMergeabilityWithSampling(
    first, async () => reads[i++],
    { attempts: 4, delayMs: 0, sleepImpl: noSleep, classify: closureGateMergeability },
  );
  assert.equal(gateOut.normalized, 'CONFLICTING', 'the gate waits for a raw terminal read');
  assert.equal(gateOut.samples, 3);
  assert.equal(gateOut.resolved, true);
});
