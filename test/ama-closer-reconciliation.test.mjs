import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/reconcile-ama-closer-dispatches.mjs';
import { amaCloserDispatchFilePath, updateAmaCloserDispatchRecord, findActiveAmaCloserLaunches } from '../src/ama/dispatch-closer.mjs';

test('CLI dry-run preserves bytes; terminal reconciliation is idempotent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amacap-reconcile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statuses = ['succeeded', 'failed', 'canceled', 'reaped'];
  const paths = statuses.map((status, i) => {
    const identity = { repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc' };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched', launchRequestId: status, custom: 'preserved' }));
    return amaCloserDispatchFilePath(root, identity);
  });
  const before = paths.map(p => readFileSync(p, 'utf8'));
  const options = { now: '2026-10-03T00:00:00Z', print() {}, readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true, row: { status: launchRequestId } }) };
  assert.equal((await main(['--root-dir', root, '--dry-run'], options)).changed, 4);
  assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), before);
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 0);
  for (const path of paths) {
    const doc = JSON.parse(readFileSync(path));
    assert.equal(doc.state, 'launch-terminal');
    assert.equal(doc.custom, 'preserved');
    assert.equal(doc.reconciledAt, options.now);
  }
  const after = paths.map(p => readFileSync(p, 'utf8'));
  assert.equal((await main(['--root-dir', root], options)).changed, 0);
  assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), after);
});

test('missing ledger launch expires; ledger read failures hold capacity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amacap-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: 1, headSha: 'abc' }, () => ({ repo: 'fixture/repo', prNumber: 1, headSha: 'abc', state: 'dispatched', launchRequestId: 'missing', lastAttemptedAt: '2020-01-01T00:00:00Z' }));
  assert.equal((await findActiveAmaCloserLaunches(root, { readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }) })).length, 1);
  assert.equal((await findActiveAmaCloserLaunches(root, { readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }) })).length, 0);
});

test('shared ledger adapter reads terminal and running SQLite launches offline', async (t) => {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'amacap-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDbPath = join(root, 'ledger.sqlite');
  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE launch_requests (launch_request_id TEXT, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT)');
  for (const [i, status] of ['succeeded', 'running'].entries()) {
    db.prepare('INSERT INTO launch_requests VALUES (?, ?, NULL, NULL, NULL)').run(`lrq-${i}`, status);
    updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc' }, () => ({ repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc', state: 'dispatched', launchRequestId: `lrq-${i}`, lastAttemptedAt: '2020-01-01T00:00:00Z' }));
  }
  db.close();
  const active = await findActiveAmaCloserLaunches(root, { ledgerDbPath, env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' } });
  assert.deepEqual(active.map(record => record.launchRequestId), ['lrq-1']);
});
