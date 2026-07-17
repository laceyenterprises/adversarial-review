import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrivialFinalizer } from '../src/finalization/trivial-finalizer.mjs';

// ---------------------------------------------------------------------------
// Fixtures — non-code (`research-finding`) subject snapshots.
// ---------------------------------------------------------------------------

const OBSERVED = '2026-05-10T00:00:00.000Z';

function subject(overrides = {}) {
  return {
    ref: { domainId: 'research-finding', subjectExternalId: 'finding-7', revisionRef: 'rev-A' },
    lifecycle: 'reviewed',
    currentRound: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds: 2,
    terminal: false,
    observedAt: OBSERVED,
    ...overrides,
  };
}

function verdict(kind, extra = {}) {
  return { kind, body: `## Verdict\n${kind}`, ...extra };
}

function makeFinalizer(mode = 'mark-terminal') {
  const calls = [];
  const port = createTrivialFinalizer({
    domainId: 'research-finding',
    mode,
    markTerminal: (ref, decision) => {
      calls.push({ ref, decision });
      return { ref, lifecycle: 'terminal', terminal: true };
    },
  });
  return { port, calls };
}

// ---------------------------------------------------------------------------
// Construction guards
// ---------------------------------------------------------------------------

test('createTrivialFinalizer validates its inputs', () => {
  assert.throws(() => createTrivialFinalizer({ markTerminal() {} }), /domainId/);
  assert.throws(() => createTrivialFinalizer({ domainId: 'd', mode: 'delete', markTerminal() {} }), /mode/);
  assert.throws(() => createTrivialFinalizer({ domainId: 'd' }), /markTerminal/);
});

// ---------------------------------------------------------------------------
// evaluate — decision fixtures
// ---------------------------------------------------------------------------

test('clean settled verdict → finalize-now', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({ latestVerdict: verdict('approved') }));
  assert.equal(d.kind, 'finalize-now');
  assert.equal(d.subjectRef.domainId, 'research-finding');
  assert.equal(d.revisionRef, 'rev-A');
  assert.equal(d.observedAt, OBSERVED);
});

test('comment-only with no blocking findings is clean → finalize-now', () => {
  const { port } = makeFinalizer();
  assert.equal(port.evaluate(subject({ latestVerdict: verdict('comment-only') })).kind, 'finalize-now');
});

test('blocking verdict with budget remaining → remediate (next round, active stage)', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({
    latestVerdict: verdict('request-changes', { stageId: 'research-review' }),
    completedRemediationRounds: 1,
    maxRemediationRounds: 2,
  }));
  assert.equal(d.kind, 'remediate');
  assert.equal(d.round, 2);
  assert.equal(d.stageId, 'research-review');
});

test('blocking verdict with budget exhausted → halt (non-code never force-lands)', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({
    latestVerdict: verdict('request-changes'),
    completedRemediationRounds: 2,
    maxRemediationRounds: 2,
  }));
  assert.equal(d.kind, 'halt');
  assert.match(d.reason, /exhausted/);
});

test('comment-only with a structured blocking finding escalates to blocking → remediate', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({
    latestVerdict: verdict('comment-only', { blockingFindings: [{ problem: 'unsupported claim' }] }),
  }));
  assert.equal(d.kind, 'remediate');
});

test('no verdict yet → wait', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({ latestVerdict: undefined, lifecycle: 'pending-review' }));
  assert.equal(d.kind, 'wait');
  assert.match(d.reason, /no current-revision verdict/);
});

test('indeterminate (unknown) verdict → wait', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({ latestVerdict: verdict('unknown') }));
  assert.equal(d.kind, 'wait');
  assert.match(d.reason, /indeterminate/);
});

test('operator halt → halt with the recorded reason', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({ lifecycle: 'halted', haltReason: 'operator paused' }));
  assert.equal(d.kind, 'halt');
  assert.equal(d.reason, 'operator paused');
});

test('already-terminal subject → finalize-now (idempotent marker)', () => {
  const { port } = makeFinalizer();
  const d = port.evaluate(subject({ terminal: true, lifecycle: 'terminal', latestVerdict: verdict('approved') }));
  assert.equal(d.kind, 'finalize-now');
  assert.equal(d.reason, 'already terminal');
});

test('evaluate requires an observedAt fold timestamp', () => {
  const { port } = makeFinalizer();
  assert.throws(() => port.evaluate(subject({ observedAt: undefined, latestVerdict: verdict('approved') })), /observedAt/);
});

// ---------------------------------------------------------------------------
// execute — action fixtures
// ---------------------------------------------------------------------------

test('execute finalize-now marks the subject terminal via the injected callback', async () => {
  const { port, calls } = makeFinalizer('mark-terminal');
  const d = port.evaluate(subject({ latestVerdict: verdict('approved') }));
  const outcome = await port.execute(d);
  assert.equal(outcome.status, 'executed');
  assert.equal(outcome.action, 'mark-terminal');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref.subjectExternalId, 'finding-7');
});

test('execute finalize-now honors the archive mode', async () => {
  const { port, calls } = makeFinalizer('archive');
  const d = port.evaluate(subject({ latestVerdict: verdict('approved') }));
  const outcome = await port.execute(d);
  assert.equal(outcome.action, 'archive');
  assert.equal(calls.length, 1);
});

test('execute on an already-terminal finalize-now is idempotent (skipped, no callback)', async () => {
  const { port, calls } = makeFinalizer();
  const d = port.evaluate(subject({ terminal: true, lifecycle: 'terminal' }));
  const outcome = await port.execute(d);
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.action, 'mark-terminal');
  assert.match(outcome.detail, /already terminal/);
  assert.equal(calls.length, 0);
});

test('execute of a non-finalize decision is a no-op skip', async () => {
  const { port, calls } = makeFinalizer();
  for (const state of [
    subject({ latestVerdict: verdict('request-changes'), completedRemediationRounds: 0, maxRemediationRounds: 2 }),
    subject({ latestVerdict: verdict('unknown') }),
    subject({ lifecycle: 'halted', haltReason: 'x' }),
  ]) {
    const outcome = await port.execute(port.evaluate(state));
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.action, 'none');
  }
  assert.equal(calls.length, 0);
});
