import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLaunchRequestStatusFromLedger, readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';

// Optional native coverage uses an isolated cluster on a private Unix socket.
// TCP listening is disabled; no network, credentials or external ledger is used.
// Actual psql scripts, variable substitution and exit statuses are preserved.
function isolatedPostgres(t) {
  for (const command of ['initdb', 'pg_ctl', 'psql']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error?.code === 'ENOENT') {
      t.skip('native PostgreSQL tools are not installed');
      return null;
    }
    assert.equal(probe.status, 0, probe.stderr);
  }
  // Keep the socket path below macOS's Unix-domain path limit.
  const root = mkdtempSync('/tmp/retry-postgres-');
  const dataDir = join(root, 'cluster');
  let started = false;
  t.after(() => {
    if (started) {
      const stop = spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', '-t', '10', 'stop'],
        { encoding: 'utf8', timeout: 15000 });
      assert.equal(stop.status, 0, stop.stderr);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const init = spawnSync('initdb', ['-D', dataDir, '-U', 'fixture_admin', '-A', 'trust', '--no-locale'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(init.status, 0, init.stderr);
  const start = spawnSync('pg_ctl', ['-D', dataDir, '-l', join(root, 'server.log'),
    '-o', `-F -k ${root} -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', '-t', '10', 'start'],
    { encoding: 'utf8', timeout: 15000 });
  started = start.status === 0;
  assert.equal(start.status, 0, start.stderr);
  function psql(args, options = {}, user = 'fixture_admin') {
    return spawnSync('psql', ['--host', root, '--username', user, ...args], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...options,
    });
  }
  function sql(statement) {
    const result = psql(['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-t', '-A'], { input: statement });
    assert.equal(result.status, 0, result.stderr);
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
  sql(`CREATE ROLE ledger_reader LOGIN;
    GRANT SELECT ON launch_requests TO ledger_reader;
    ALTER ROLE ledger_reader SET default_transaction_read_only = on;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE TEMP ON DATABASE postgres FROM PUBLIC;`);
  let responseBytes = 0;
  function spawnSyncImpl(command, args, options) {
    assert.equal(command, 'psql');
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    const actualArgs = args.map(arg => arg === 'synthetic' ? 'postgres' : arg);
    const response = psql(actualArgs, options, 'ledger_reader');
    if (options.input?.includes('WITH RECURSIVE')) responseBytes = Buffer.byteLength(response.stdout || '');
    return response;
  }
  return { sql, spawnSyncImpl, responseBytes: () => responseBytes };
}

test('RETRYCHAIN-01: native psql traverses cycles with SELECT-only authority and skips malformed metadata', async t => {
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
  const modern = Number(fixture.sql('SHOW server_version_num;').trim()) >= 160000;
  fixture.sql(`INSERT INTO launch_requests (launch_request_id, status, metadata_json)
    SELECT 'synthetic-unrelated-' || n, 'running',
      json_build_object('retryOf', 'synthetic-unrelated-parent', 'padding', repeat('x', 256))::text
    FROM generate_series(1, 50000) n;`);
  if (!modern) fixture.sql("DELETE FROM launch_requests WHERE launch_request_id LIKE 'synthetic-unrelated-%';");
  const large = await readLaunchRequestStatusFromLedgerAsync(args);
  assert.deepEqual(large, result);
  if (modern) assert.equal(fixture.responseBytes(), smallBytes, 'unrelated rows must add zero response bytes');
  assert.ok(smallBytes < 2048);
  // Read-only queries never install a parser in the catalog.
  assert.match(fixture.sql("SELECT count(*) FROM pg_proc WHERE proname = 'retry_parent';"), /^0\s*$/);
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

// Exercise psql's pre-16 branch even when the installed server is newer. Actual
// compatibility also runs naturally when the optional fixture uses PostgreSQL 15.
test('RETRYCHAIN-01: legacy PostgreSQL snapshot fallback stays read-only', t => {
  const fixture = isolatedPostgres(t);
  if (!fixture) return;
  const result = readLaunchRequestStatusFromLedger({ launchRequestId: 'synthetic-root', includeRetryChain: true,
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' },
    spawnSyncImpl: (command, args, options) => fixture.spawnSyncImpl(command, args, {
      ...options,
      input: options.input.replace("current_setting('server_version_num')::int >= 160000", 'false'),
    }) });
  assert.equal(result.ok, true);
  assert.equal(result.retryChainUnreadable, undefined);
  assert.deepEqual(result.retryChain.map(row => row.launch_request_id),
    ['synthetic-sibling', 'synthetic-leaf', 'synthetic-retry']);
  assert.ok(result.retryChain.every(row => !Object.hasOwn(row, 'metadata_json')));
});

test('RETRYCHAIN-01: real psql failures retain base status and mark traversal unreadable', t => {
  const fixture = isolatedPostgres(t);
  if (!fixture) return;
  let queries = 0;
  const result = readLaunchRequestStatusFromLedger({ launchRequestId: 'synthetic-root', includeRetryChain: true,
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' },
    spawnSyncImpl: (...args) => {
      const response = fixture.spawnSyncImpl(...args);
      if (++queries === 1) fixture.sql('REVOKE SELECT ON launch_requests FROM ledger_reader;');
      else {
        assert.notEqual(response.status, 0);
        assert.match(response.stderr, /permission denied/);
      }
      return response;
    } });
  assert.equal(result.ok, true);
  assert.equal(result.row.status, 'failed');
  assert.equal(result.retryChainUnreadable, true);
});
