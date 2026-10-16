import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitTrailers, parseCommitTrailerValues, hamCommitIdentityMatches } from '../src/ama/ham-provenance.mjs';

for (const classes of [['hammer', 'codex'], ['codex', 'hammer']]) {
  test(`REBASEPROV-01 conflicting identity trailers refuse in order ${classes.join('/')}`, () => {
    const message = `Replayed commit\n\nWorker-Class: ${classes[0]}\nWorker-Class: ${classes[1]}\nWorker-Ticket: HAM`;
    assert.deepEqual(parseCommitTrailerValues(message)['worker-class'], classes);
    assert.equal(parseCommitTrailers(message)['worker-class'], undefined);
    assert.equal(hamCommitIdentityMatches({ author: 'hammer-worker', commit: { message } }), false);
  });
}
test('REBASEPROV-01 identical identity trailers retain their unambiguous value', () => {
  assert.equal(parseCommitTrailers('Commit\n\nWorker-Class: hammer\nWorker-Class: hammer')['worker-class'], 'hammer');
});

for (const [key, value] of [['Worker-Class', 'hammer'], ['Worker-Ticket', 'ham'], ['Ticket', 'ham'],
  ['Reviewed-Head', 'abcdef0123456789'.repeat(2) + 'abcdef01'], ['Closed-By', 'hammer (adversarial-pipe-mode)']]) {
  test(`REBASEPROV-01 ${key} case variants do not conflict`, () => {
    const message = `Commit\n\n${key}: ${value}\n${key}: ${value.toUpperCase()}`;
    assert.deepEqual(parseCommitTrailerValues(message)[key.toLowerCase()], [value, value.toUpperCase()]);
    assert.equal(parseCommitTrailers(message)[key.toLowerCase()], value);
    assert.equal(hamCommitIdentityMatches({ author: 'the-hammer-lacey[bot]', commit: { message } }), true);
    const conflicting = `${message}\n${key}: unrelated`;
    assert.equal(parseCommitTrailers(conflicting)[key.toLowerCase()], undefined);
    assert.equal(hamCommitIdentityMatches({ author: 'the-hammer-lacey[bot]', commit: { message: conflicting } }), false);
  });
}
