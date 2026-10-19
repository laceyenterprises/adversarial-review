import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLaunchRequestStatusFromLedger, readLaunchRequestStatusFromLedgerAsync, readLaunchRequestSnapshotFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';

function reserveLoopbackPort() {
  const reserve = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(reserve.status, 0, reserve.stderr);
  const port = Number(reserve.stdout);
  assert.ok(Number.isInteger(port) && port > 0);
  return port;
}

function startPostgresWithPortRetry({ dataDir, root, reservePort = reserveLoopbackPort, spawnSyncImpl = spawnSync }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = reservePort();
    // Separate logs keep an earlier collision from masking a later failure.
    const logPath = join(root, `server-${attempt}.log`);
    const start = spawnSyncImpl('pg_ctl', ['-D', dataDir, '-l', logPath,
      '-o', `-F -k ${root} -p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700`, '-w', '-t', '10', 'start'],
      { encoding: 'utf8', timeout: 15000 });
    const diagnostics = [start.error?.message, start.stderr, start.stdout,
      existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''].filter(Boolean).join('\n');
    if (start.status === 0 || start.error || !/address already in use/i.test(diagnostics) || attempt === 3) {
      return { start, port, diagnostics };
    }
  }
}

for (const scenario of ['recovers', 'exhausts', 'unrelated failure']) {
  test(`native PostgreSQL fixture port collision retry ${scenario}`, t => {
    const root = mkdtempSync('/tmp/retry-postgres-start-');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    let reservations = 0;
    const result = startPostgresWithPortRetry({ dataDir: join(root, 'cluster'), root,
      reservePort: () => 40000 + ++reservations,
      spawnSyncImpl: (command, args) => {
        assert.equal(command, 'pg_ctl');
        calls++;
        assert.ok(args[args.indexOf('-o') + 1].includes(`-p ${40000 + calls} `));
        const succeeds = scenario === 'recovers' && calls === 2;
        const message = scenario === 'unrelated failure' && calls === 2
          ? 'FATAL: invalid configuration' : 'could not bind IPv4 address "127.0.0.1": Address already in use';
        writeFileSync(args[args.indexOf('-l') + 1], succeeds ? 'ready' : message);
        // pg_ctl puts the bind failure in the server log, not stderr.
        return { status: succeeds ? 0 : 1, stdout: '', stderr: succeeds ? '' : 'could not start server' };
      },
    });
    assert.equal(calls, scenario === 'exhausts' ? 3 : 2);
    assert.equal(reservations, calls);
    assert.equal(result.port, 40000 + calls);
    assert.equal(result.start.status, scenario === 'recovers' ? 0 : 1);
    if (scenario === 'unrelated failure') assert.match(result.diagnostics, /invalid configuration/);
  });
}

// Optional native coverage uses an isolated cluster on an ephemeral loopback
// port (Unix-socket connects are denied by the host network guard). No external
// network, credentials or existing ledger is used.
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
  const { start, port, diagnostics } = startPostgresWithPortRetry({ dataDir, root });
  started = start.status === 0;
  assert.equal(start.status, 0, diagnostics);
  function psql(args, options = {}, user = 'fixture_admin') {
    return spawnSync('psql', ['--host', '127.0.0.1', '--port', String(port), '--username', user, ...args], {
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
  let lastChainRead;
  function spawnSyncImpl(command, args, options) {
    assert.equal(command, 'psql');
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    const actualArgs = args.map(arg => arg === 'synthetic' ? 'postgres' : arg);
    const response = psql(actualArgs, options, 'ledger_reader');
    if (options.input?.includes('WITH RECURSIVE')) {
      responseBytes = Buffer.byteLength(response.stdout || '');
      lastChainRead = { args: actualArgs, options };
    }
    return response;
  }
  function explainLastRead() {
    assert.ok(lastChainRead);
    const result = psql(lastChainRead.args, { ...lastChainRead.options,
      input: lastChainRead.options.input.replaceAll('WITH RECURSIVE', 'EXPLAIN (COSTS OFF) WITH RECURSIVE'),
    }, 'ledger_reader');
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  return { sql, spawnSyncImpl, explainLastRead, responseBytes: () => responseBytes };
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
  const launchSnapshot = await readLaunchRequestSnapshotFromLedgerAsync({ ...args,
    launchRequestIds: ['synthetic-root'] });
  assert.equal(launchSnapshot.ok, true, JSON.stringify(launchSnapshot));
  const snapshotResult = await readLaunchRequestStatusFromLedgerAsync({ ...args, launchSnapshot });
  assert.deepEqual(snapshotResult, result);
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

test('RETRYCHAIN-01: native PostgreSQL supports JSON metadata and absent historical columns', async t => {
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
  assert.equal(missing.row.failure_detail, null);
  const launchSnapshot = await readLaunchRequestSnapshotFromLedgerAsync({ ...args,
    launchRequestIds: ['synthetic-root'] });
  assert.equal(launchSnapshot.ok, true, JSON.stringify(launchSnapshot));
  assert.deepEqual(launchSnapshot.rows, [missing.row]);
  assert.deepEqual(await readLaunchRequestStatusFromLedgerAsync({ ...args, launchSnapshot }), missing);
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

test('RETRYCHAIN-02: native jsonb retry and capacity plans use indexes at ledger scale on every server version', async t => {
  const fixture = isolatedPostgres(t);
  if (!fixture) return;
  fixture.sql(`DELETE FROM launch_requests WHERE launch_request_id IN ('synthetic-malformed', 'synthetic-empty', 'synthetic-escape');
    ALTER TABLE launch_requests ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
    ALTER TABLE launch_requests ADD COLUMN created_at timestamptz DEFAULT '2026-01-01';
    ALTER TABLE launch_requests ADD COLUMN payload text;
    ALTER TABLE launch_requests ALTER COLUMN payload SET STORAGE EXTERNAL;
    INSERT INTO launch_requests (launch_request_id, status, metadata_json, payload)
      SELECT 'synthetic-unrelated-' || n, 'running', jsonb_build_object('retryOf', 'synthetic-unrelated-parent-' || n),
        repeat(md5(n::text), 256) FROM generate_series(1, 25000) n;
    INSERT INTO launch_requests (launch_request_id, status, metadata_json) VALUES
      ('synthetic-alone', 'failed', NULL),
      ('synthetic-chain-0', 'failed', NULL),
      ('synthetic-chain-1', 'failed', '{"retryOf":"synthetic-chain-0"}'),
      ('synthetic-chain-2', 'failed', '{"retryOf":"synthetic-chain-1"}'),
      ('synthetic-chain-3', 'running', '{"retryOf":"synthetic-chain-2"}');
    CREATE INDEX idx_launch_requests_retry_of ON launch_requests
      USING btree ((metadata_json ->> 'retryOf'), created_at, launch_request_id)
      WHERE CASE WHEN metadata_json IS NULL THEN NULL::boolean ELSE true END;
    ANALYZE launch_requests;`);
  const args = { includeRetryChain: true,
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' }, spawnSyncImpl: fixture.spawnSyncImpl };
  // Keep the deployed RETRYCHAIN-01 query as a synthetic EXPLAIN baseline.
  // No ANALYZE: this captures plan shape without executing the whole-row scan.
  const baseline = `EXPLAIN (COSTS OFF)
    WITH RECURSIVE retry_edges AS MATERIALIZED (
      SELECT launch_request_id,
        CASE WHEN pg_input_is_valid(to_jsonb(request)->>'metadata_json', 'jsonb')
          THEN (to_jsonb(request)->>'metadata_json')::jsonb END AS metadata
      FROM launch_requests request
    ), retry_chain(launch_request_id) AS (
      SELECT 'synthetic-alone'::text UNION
      SELECT child.launch_request_id FROM retry_edges child JOIN retry_chain parent
        ON CASE WHEN jsonb_typeof(child.metadata->'retryOf') = 'string'
          THEN child.metadata->>'retryOf' END = parent.launch_request_id
    )
    SELECT json_build_object('launch_request_id', launch_request_id, 'status', status,
      'updated_at', updated_at, 'terminal_at', terminal_at, 'failure_class', failure_class,
      'failure_detail', to_jsonb(launch_requests)->>'failure_detail',
      'ticket_ref', to_jsonb(launch_requests)->>'ticket_ref')
    FROM launch_requests
    WHERE launch_request_id IN (SELECT launch_request_id FROM retry_chain)
      AND launch_request_id != 'synthetic-alone'
    ORDER BY updated_at DESC NULLS LAST, launch_request_id DESC;`;
  const modern = Number(fixture.sql('SHOW server_version_num;').trim()) >= 160000;
  const before = fixture.sql(modern ? baseline : baseline.replace(
    "pg_input_is_valid(to_jsonb(request)->>'metadata_json', 'jsonb')", 'true'));
  assert.match(before, /Seq Scan on launch_requests/);
  t.diagnostic(`Before (RETRYCHAIN-01):\n${before.trim()}`);
  for (const legacy of [false, true]) {
    const options = { ...args, spawnSyncImpl: (command, argv, opts) => fixture.spawnSyncImpl(command, argv, {
      ...opts, input: legacy ? opts.input.replace("current_setting('server_version_num')::int >= 160000", 'false') : opts.input,
    }) };
    for (const [id, expected] of [
      ['synthetic-alone', []],
      ['synthetic-chain-0', ['synthetic-chain-3', 'synthetic-chain-2', 'synthetic-chain-1']],
      ['synthetic-root', ['synthetic-sibling', 'synthetic-leaf', 'synthetic-retry']],
    ]) {
      const result = await readLaunchRequestStatusFromLedgerAsync({ ...options, launchRequestId: id });
      assert.equal(result.retryChainUnreadable, undefined, JSON.stringify(result));
      assert.deepEqual(result.retryChain.map(row => row.launch_request_id), expected);
      assert.ok(result.retryChain.every(row => !Object.hasOwn(row, 'metadata_json')));
      const plan = fixture.explainLastRead();
      assert.match(plan, /(?:Index Scan|Bitmap Index Scan).*idx_launch_requests_retry_of/);
      assert.doesNotMatch(plan, /Seq Scan on launch_requests|CTE retry_edges/);
      if (!legacy && id === 'synthetic-alone') t.diagnostic(`After (RETRYCHAIN-02):\n${plan}`);
    }
    const launchSnapshot = await readLaunchRequestSnapshotFromLedgerAsync({ ...options,
      launchRequestIds: ['synthetic-alone', 'synthetic-chain-0', 'synthetic-root'] });
    assert.equal(launchSnapshot.ok, true, JSON.stringify(launchSnapshot));
    assert.equal(launchSnapshot.rows.length, 9);
    const plan = fixture.explainLastRead();
    assert.match(plan, /(?:Index Scan|Bitmap Index Scan).*idx_launch_requests_retry_of/);
    assert.doesNotMatch(plan, /Seq Scan on launch_requests|CTE retry_edges/);
    const result = await readLaunchRequestStatusFromLedgerAsync({ ...options, launchSnapshot, launchRequestId: 'synthetic-root' });
    assert.equal(result.row.status, 'failed');
    const chain = await readLaunchRequestStatusFromLedgerAsync({ ...options, launchSnapshot,
      launchRequestId: 'synthetic-root', includeRetryChain: true });
    assert.deepEqual(chain.retryChain.map(row => row.launch_request_id),
      ['synthetic-sibling', 'synthetic-leaf', 'synthetic-retry']);
  }
});
