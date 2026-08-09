import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogChangeGate } from '../src/log-change-gate.mjs';

test('createLogChangeGate: first observation logs, unchanged repeats are suppressed', () => {
  const gate = createLogChangeGate();

  const first = gate.note('repo#1', 'sig-a');
  assert.equal(first.changed, true);
  assert.equal(first.count, 1);
  assert.equal(first.suppressedSincePrevious, 0);

  const second = gate.note('repo#1', 'sig-a');
  assert.equal(second.changed, false);
  assert.equal(second.count, 2);

  const third = gate.note('repo#1', 'sig-a');
  assert.equal(third.changed, false);
  assert.equal(third.count, 3);
});

test('createLogChangeGate: a changed signature logs again and reports the suppressed count', () => {
  const gate = createLogChangeGate();

  assert.equal(gate.note('k', 'a').changed, true);
  assert.equal(gate.note('k', 'a').changed, false);
  assert.equal(gate.note('k', 'a').changed, false); // two suppressed since the emit

  const changed = gate.note('k', 'b');
  assert.equal(changed.changed, true);
  assert.equal(changed.count, 1);
  assert.equal(changed.suppressedSincePrevious, 2);
});

test('createLogChangeGate: distinct keys are tracked independently', () => {
  const gate = createLogChangeGate();

  assert.equal(gate.note('a', 's').changed, true);
  assert.equal(gate.note('b', 's').changed, true);
  assert.equal(gate.note('a', 's').changed, false);
  assert.equal(gate.note('b', 's').changed, false);
  assert.equal(gate.size(), 2);
});

test('createLogChangeGate: forget re-arms a key; reset clears everything', () => {
  const gate = createLogChangeGate();

  assert.equal(gate.note('a', 's').changed, true);
  assert.equal(gate.note('a', 's').changed, false);

  gate.forget('a');
  assert.equal(gate.note('a', 's').changed, true); // re-armed after forget

  gate.reset();
  assert.equal(gate.size(), 0);
  assert.equal(gate.note('a', 's').changed, true); // re-armed after reset
});

test('createLogChangeGate: any transition is visible, including a return to a prior signature', () => {
  const gate = createLogChangeGate();

  assert.equal(gate.note('k', 'a').changed, true);
  assert.equal(gate.note('k', 'b').changed, true);
  assert.equal(gate.note('k', 'a').changed, true); // transitions always log
});

test('createLogChangeGate: evicts least-recently-used keys when the gate reaches its limit', () => {
  const gate = createLogChangeGate({ maxEntries: 2 });

  assert.equal(gate.note('a', 's').changed, true);
  assert.equal(gate.note('b', 's').changed, true);
  assert.equal(gate.note('a', 's').changed, false); // refreshes a, making b oldest

  assert.equal(gate.note('c', 's').changed, true);
  assert.equal(gate.size(), 2);
  assert.equal(gate.note('b', 's').changed, true); // b was evicted and re-armed
  assert.equal(gate.size(), 2);
});

test('createLogChangeGate: rejects invalid maxEntries values', () => {
  assert.throws(
    () => createLogChangeGate({ maxEntries: 0 }),
    /maxEntries must be a positive integer/
  );
  assert.throws(
    () => createLogChangeGate({ maxEntries: 1.5 }),
    /maxEntries must be a positive integer/
  );
});
