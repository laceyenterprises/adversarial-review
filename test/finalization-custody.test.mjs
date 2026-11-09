import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { custodyFreshness, ingestCustody } from '../src/finalization/custody-ingest.mjs';

const at = '2026-11-03T00:00:00.000Z';
const event = (state = 'workspace') => ({
  type: 'launch_custody_observed',
  subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/project#42' },
  revisionRef: 'a'.repeat(40), at, sourceRef: 'agent-os:fixture', idempotencyKey: 'fixture',
  custody: {
    repository: 'example/project', prNumber: 42, launchRequestId: 'lrq_fixture',
    state, at, freshnessSeconds: 180, launchLiveness: 'terminal', dirty: true,
    worktree: '/synthetic/retained', branch: 'pr-branch',
  },
});

test('missing custody in heterogeneous events projects unknown without throwing', () => {
  for (const input of [undefined, null, {}, { type: 'head_observed', at }, { at, custody: null }]) {
    assert.deepEqual(custodyFreshness(input, at),
      { fresh: false, liveness: 'unknown', terminalDirtyWorktree: false });
  }
});

test('custody CLI reports argument and payload errors on stderr', () => {
  const cli = fileURLToPath(new URL('../src/finalization/custody-ingest.mjs', import.meta.url));
  for (const [args, input, message] of [
    [[], '', '--root DIR required'],
    [['--root', 'unused'], 'x'.repeat(65537), 'custody event too large'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `custody append unavailable: ${message}\n`);
  }
});

test('append-before-ack crash replays once and retains terminal dirty holder', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = openFinalizationLedgerStore({ db });
  const first = ingestCustody(store, event());
  assert.deepEqual(ingestCustody(store, event()), first);
  const events = store.read(event().subjectKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].custody.dirty, true);
  assert.deepEqual(custodyFreshness(events[0], at),
    { fresh: true, liveness: 'terminal', terminalDirtyWorktree: true });
  assert.deepEqual(custodyFreshness(events[0], '2026-11-03T00:03:01Z'),
    { fresh: false, liveness: 'unknown', terminalDirtyWorktree: false });
  assert.equal(custodyFreshness(events[0], '2026-11-02T23:59:59Z').fresh, false);
});

test('every lifecycle observation is accepted, neither waits nor terminal facts decide closure', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = openFinalizationLedgerStore({ db });
  for (const state of ['requested', 'admitted', 'deferred', 'refused', 'running', 'terminal']) {
    ingestCustody(store, { ...event(state), idempotencyKey: state });
  }
  assert.deepEqual(store.read(event().subjectKey).map(e => e.custody.state),
    ['requested', 'admitted', 'deferred', 'refused', 'running', 'terminal']);
});

test('foreign subjects, invalid dirty evidence and unbounded freshness are refused', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = openFinalizationLedgerStore({ db });
  for (const patch of [
    { subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/foreign#42' } },
    { custody: { ...event().custody, dirty: 'false' } },
    { custody: { ...event().custody, freshnessSeconds: 3600 } },
  ]) assert.throws(() => ingestCustody(store, { ...event(), ...patch }));
  assert.equal(store.read(event().subjectKey).length, 0);
});
