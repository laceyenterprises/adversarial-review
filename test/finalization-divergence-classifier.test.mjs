import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDivergence, V1_DEFECT_CLASSES } from '../src/finalization/divergence-classifier.mjs';

// Minimal state builders. `headMoved` is signalled by >1 revision key.
const oneRev = { revisions: { A: {} }, stages: {} };
const twoRev = { revisions: { A: {}, B: {} }, stages: {} };

function decision(kind, reason) {
  return { kind, subjectKey: null, revisionRef: 'B', observedAt: null, reason };
}

test('concurrence in the same bucket is agree (benign), not a divergence', () => {
  const c = classifyDivergence({ v1Action: { kind: 'merged' }, v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision') });
  assert.equal(c.relation, 'agree');
  assert.equal(c.direction, 'benign');
  assert.equal(c.disposition, 'resolved');
});

test('v1 none concurs with v2 wait (idle ≈ patience)', () => {
  const c = classifyDivergence({ v1Action: { kind: 'none' }, v2Decision: decision('wait', 'no verdict at current revision') });
  assert.equal(c.relation, 'agree');
});

test('v1 escalate concurs with v2 halt (both page, no mutation)', () => {
  const c = classifyDivergence({ v1Action: { kind: 'escalate' }, v2Decision: decision('halt', 'operator halt') });
  assert.equal(c.relation, 'agree');
});

test('CI-impatience: v1 merged, v2 waits on checks → v1-defect AR#550', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'merged' },
    v2Decision: decision('wait', 'required checks not yet present at current revision'),
  });
  assert.equal(c.relation, 'diverge');
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'ci-impatience');
  assert.equal(c.ref, V1_DEFECT_CLASSES['ci-impatience']);
  assert.equal(c.ref, 'AR#550');
  assert.equal(c.disposition, 'resolved');
});

test('verdict-at-wrong-head: v1 merged, v2 waits on a head verdict → v1-defect', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'merged' },
    v2Decision: decision('wait', 'no verdict at current revision'),
  });
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'verdict-at-wrong-head');
});

test('identity-head-pin: v1 merged on a pinned identity after a head move → v1-defect #603', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'merged', detail: 'worker identity head-pin bound at open' },
    v2Decision: decision('wait', 'awaiting attestations from: producer-x'),
    state: twoRev,
  });
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'identity-head-pin');
  assert.equal(c.ref, '#603');
});

test('LHA premature cutover: v1 stalls on attestations, v2 escalates on patience → v1-defect', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'wait', detail: 'awaiting produced attestation' },
    v2Decision: decision('escalate', 'attestation patience expired'),
  });
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'lha-premature-cutover');
});

test('HCM-01 phantom-die: v1 strands a converged PR, v2 finalizes → v1-defect', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'wait', detail: 'stranded after hammer crash' },
    v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision'),
    state: oneRev,
  });
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'phantom-die-before-merge');
  assert.equal(c.ref, 'HCM-01');
});

test('LAC-1559 ceiling+head-move deadlock: v1 stuck, head moved, v2 finalizes → v1-defect', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'wait' },
    v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision'),
    state: twoRev,
  });
  assert.equal(c.direction, 'v1-defect');
  assert.equal(c.class, 'ceiling-head-move-deadlock');
  assert.equal(c.ref, 'LAC-1559');
});

test('hammer-dispatch vs finalize-now is NOT auto-blamed on v1 — stays open', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'hammer-dispatch' },
    v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision'),
    state: oneRev,
  });
  assert.equal(c.relation, 'diverge');
  assert.equal(c.direction, 'open');
  assert.equal(c.class, 'unclassified');
  assert.equal(c.disposition, 'open');
});

test('v1 close vs v2 finalize-now stays open (could be operator close or v1 abandon)', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'close' },
    v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision'),
  });
  assert.equal(c.direction, 'open');
  assert.equal(c.disposition, 'open');
});

test('fold-error while v1 acted is a divergence that must be triaged (open), never auto-absolved', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'merged' },
    v2Decision: decision('escalate', 'shadow fold error (fail-closed, never a guess): boom'),
    foldError: true,
  });
  assert.equal(c.relation, 'diverge');
  assert.equal(c.direction, 'open');
  assert.equal(c.class, 'fold-error');
});

test('fold-error where v1 also paged is benign concurrence on no mutation', () => {
  const c = classifyDivergence({
    v1Action: { kind: 'escalate' },
    v2Decision: decision('escalate', 'shadow fold error (fail-closed, never a guess): boom'),
    foldError: true,
  });
  assert.equal(c.relation, 'agree');
  assert.equal(c.direction, 'benign');
  assert.equal(c.class, 'fold-error');
});

test('only `open` divergences carry an open disposition; v1-defects are dispositioned resolved', () => {
  const open = classifyDivergence({ v1Action: { kind: 'hammer-dispatch' }, v2Decision: decision('finalize-now', 'clean verdict, green checks at current revision') });
  const attributed = classifyDivergence({ v1Action: { kind: 'merged' }, v2Decision: decision('wait', 'checks not yet settled at current revision') });
  assert.equal(open.disposition, 'open');
  assert.equal(attributed.disposition, 'resolved');
});
