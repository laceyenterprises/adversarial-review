import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('conflicting custody under a replay key refuses without losing the original', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = openFinalizationLedgerStore({ db });
  ingestCustody(store, event());
  assert.throws(() => ingestCustody(store, { ...event(), custody: { ...event().custody, dirty: false } }), /content mismatch/);
  assert.equal(store.read(event().subjectKey)[0].custody.dirty, true);
  assert.equal(store.read(event().subjectKey).length, 1);
});

test('future custody payloads remain readable but unknown; writes stay strict', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = openFinalizationLedgerStore({ db });
  ingestCustody(store, event());
  db.prepare('UPDATE finalization_ledger SET payload_json=?').run(JSON.stringify({ custody: { ...event().custody, state: 'future-state', freshnessSeconds: 900 } }));
  const rows = store.read(event().subjectKey);
  assert.equal(rows[0].type, 'unknown:launch_custody_observed');
  assert.equal(rows[0].seq, 1);
  assert.equal(custodyFreshness(rows[0], at).fresh, false);
  assert.throws(() => ingestCustody(store, { ...event(), custody: rows[0].custody }));
});

test('custody CLI requires an existing owner-matched store and commits to it', t => {
  const root = mkdtempSync(join(tmpdir(), 'custody-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = new URL('../src/finalization/custody-ingest.mjs', import.meta.url);
  const run = (dir, foreign = false) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    ${foreign ? 'process.getuid = () => -1;' : ''}
    const { custodyIngestMain } = await import(${JSON.stringify(cli.href)});
    try { console.log(JSON.stringify(custodyIngestMain(['--root', ${JSON.stringify(dir)}], ${JSON.stringify(JSON.stringify(event()))}))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `], { encoding: 'utf8', timeout: 10000 });
  for (const dir of [join(root, 'missing'), root]) {
    const result = run(dir);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(root, 'data/reviews.db')), false);
  }
  openFinalizationLedgerStore({ rootDir: root }).close();
  const foreign = run(root, true);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /cross-user/);
  assert.equal(foreign.stdout, '');
  const committed = run(root);
  assert.equal(committed.status, 0, committed.stderr);
  const store = openFinalizationLedgerStore({ rootDir: root });
  t.after(() => store.close());
  assert.equal(store.read(event().subjectKey)[0].seq, JSON.parse(committed.stdout).seq);
});
