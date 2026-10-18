import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLaunchRequestStatusFromLedger, readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';

// Native SQL coverage when PostgreSQL tools are installed. Standalone mode has
// no sockets, network, running server, credentials or external ledger dependency.
// The adapter unit tests always assert the query and failure contracts as well.
function isolatedPostgres(t) {
  for (const command of ['initdb', 'postgres']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error?.code === 'ENOENT') {
      t.skip('native PostgreSQL tools are not installed');
      return null;
    }
    assert.equal(probe.status, 0, probe.stderr);
  }
  const root = mkdtempSync(join(tmpdir(), 'retry-postgres-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'cluster');
  const init = spawnSync('initdb', ['-D', dataDir, '-A', 'trust', '--no-locale'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(init.status, 0, init.stderr);
  function sql(statement) {
    const result = spawnSync('postgres', ['--single', '-D', dataDir, 'postgres'], {
      // Standalone mode consumes one statement batch per line. This fixture's
      // SQL has no line comments or multiline string values.
      input: statement.replace(/\n/g, ' ') + '\n',
      encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /(?:ERROR|FATAL|PANIC):/, result.stderr);
    return result.stdout;
  }
  sql(`CREATE TABLE launch_requests (
    launch_request_id text PRIMARY KEY, status text, updated_at timestamptz,
    terminal_at timestamptz, failure_class text, failure_detail text,
    ticket_ref text, metadata_json text
  );
  INSERT INTO launch_requests VALUES
    ('synthetic-root', 'failed', NULL, NULL, NULL, NULL, 'HAM', '{"retryOf":"synthetic-leaf"}'),
    ('synthetic-retry', 'failed', '2026-01-01', NULL, 'synthetic-failure', 'synthetic detail', 'HAM', '{"retryOf":"synthetic-root"}'),
    ('synthetic-leaf', 'succeeded', '2026-01-02', '2026-01-02', NULL, NULL, 'HAM', '{"retryOf":"synthetic-retry"}'),
    ('synthetic-sibling', 'canceled', '2026-01-02', NULL, NULL, NULL, 'HAM', '{"retryOf":"synthetic-root"}'),
    ('synthetic-malformed', 'running', NULL, NULL, NULL, NULL, 'HAM', '{broken "retryOf":"synthetic-root"'),
    ('synthetic-escape', 'running', NULL, NULL, NULL, NULL, 'HAM', '{"retryOf":"synthetic-root\\u0000"}'),
    ('synthetic-number', 'running', NULL, NULL, NULL, NULL, 'HAM', '{"retryOf":123}'),
    ('synthetic-scalar', 'running', NULL, NULL, NULL, NULL, 'HAM', '"synthetic-root"'),
    ('synthetic-empty', 'running', NULL, NULL, NULL, NULL, 'HAM', ''),
    ('synthetic-null', 'running', NULL, NULL, NULL, NULL, 'HAM', NULL);`);
  let responseBytes = 0;
  function spawnSyncImpl(command, args, options) {
    assert.equal(command, 'psql');
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    const selector = args.find(arg => arg.startsWith('lrq=')).slice(4);
    const script = options.input.replace(/\\set QUIET on/, '')
      .replaceAll(":'lrq'", "'" + selector.replaceAll("'", "''") + "'");
    const stdout = sql(script);
    const rows = [...stdout.matchAll(/json_build_object = "(.*)"\t\(typeid/g)].map(match => JSON.parse(match[1]));
    const payload = rows.map(row => JSON.stringify(row)).join('\n');
    if (options.input.includes('WITH RECURSIVE')) responseBytes = Buffer.byteLength(payload);
    return { status: 0, stdout: payload, stderr: '' };
  }
  return { sql, spawnSyncImpl, responseBytes: () => responseBytes };
}

test('RETRYCHAIN-01: native PostgreSQL traverses cycles safely and skips malformed metadata', async t => {
  const fixture = isolatedPostgres(t);
  if (!fixture) return;
  const args = { launchRequestId: 'synthetic-root', includeRetryChain: true,
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' }, spawnSyncImpl: fixture.spawnSyncImpl };
  const result = readLaunchRequestStatusFromLedger(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.retryChainUnreadable, undefined);
  assert.deepEqual(result.retryChain.map(row => row.launch_request_id),
    ['synthetic-sibling', 'synthetic-leaf', 'synthetic-retry']);
  assert.equal(result.retryChain[2].failure_detail, 'synthetic detail');
  assert.equal(result.retryChain[1].status, 'succeeded');
  assert.ok(result.retryChain.every(row => !Object.hasOwn(row, 'metadata_json')));
  const smallBytes = fixture.responseBytes();
  fixture.sql(`INSERT INTO launch_requests (launch_request_id, status, metadata_json)
    SELECT 'synthetic-unrelated-' || n, 'running',
      json_build_object('retryOf', 'synthetic-unrelated-parent', 'padding', repeat('x', 256))::text
    FROM generate_series(1, 50000) n;`);
  const large = await readLaunchRequestStatusFromLedgerAsync(args);
  assert.deepEqual(large, result);
  assert.equal(fixture.responseBytes(), smallBytes, 'unrelated rows must add zero response bytes');
  assert.ok(smallBytes < 2048);
  // ROLLBACK removes the temporary helper; no durable function is installed.
  assert.match(fixture.sql("SELECT count(*) FROM pg_proc WHERE proname = 'retry_parent';"), /count = "0"/);
  const empty = readLaunchRequestStatusFromLedger({ ...args, launchRequestId: 'synthetic-empty' });
  assert.deepEqual(empty.retryChain, []);
  let removedRoot = false;
  const raced = readLaunchRequestStatusFromLedger({ ...args, spawnSyncImpl: (...childArgs) => {
    const response = fixture.spawnSyncImpl(...childArgs);
    if (!removedRoot) {
      fixture.sql("DELETE FROM launch_requests WHERE launch_request_id = 'synthetic-root';");
      removedRoot = true;
    }
    return response;
  } });
  assert.deepEqual(raced.retryChain, result.retryChain,
    'deleting the base row after its status probe cannot hide surviving retries');
});

test('RETRYCHAIN-01: native PostgreSQL supports JSON metadata and absent historical columns', t => {
  const fixture = isolatedPostgres(t);
  if (!fixture) return;
  fixture.sql(`DELETE FROM launch_requests WHERE launch_request_id IN ('synthetic-malformed', 'synthetic-empty', 'synthetic-escape');
    ALTER TABLE launch_requests ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;`);
  const args = { launchRequestId: 'synthetic-root', includeRetryChain: true,
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' }, spawnSyncImpl: fixture.spawnSyncImpl };
  const result = readLaunchRequestStatusFromLedger(args);
  assert.equal(result.retryChain.length, 3, JSON.stringify(result));
  fixture.sql('ALTER TABLE launch_requests DROP COLUMN metadata_json; ALTER TABLE launch_requests DROP COLUMN failure_detail;');
  const missing = readLaunchRequestStatusFromLedger(args);
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.retryChain, []);
});
