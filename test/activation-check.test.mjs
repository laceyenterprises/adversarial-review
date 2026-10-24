import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess, { spawnSync } from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { hammerTokenSession } from '../src/hammer-token.mjs';
import { main, reservationEvidence } from '../src/activation-check.mjs';

const secret = 'ghs_' + 'synthetic'.repeat(6);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t, output, fail = false) {
  const root = mkdtempSync(join(tmpdir(), 'activation-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'refresh.cjs');
  writeFileSync(script, `process.stderr.write(${JSON.stringify(secret)}); process.stdout.write(${JSON.stringify(output)}); process.exit(${fail ? 1 : 0});`);
  return { HAMMER_LACEY_GH_TOKEN: secret,
    HAMMER_LACEY_GH_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00Z',
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: `${quote(process.execPath)} ${quote(script)}` };
}
function exportsOutput() {
  return `export HAMMER_LACEY_GH_TOKEN=${secret}\nexport GH_TOKEN=${secret}\nexport GITHUB_TOKEN=${secret}\nexport GH_TOKEN_EXPIRES_AT='2099-01-01T00:00:00Z'\n`;
}
function run(env, argv = ['hammer-token']) {
  let out = '', err = '';
  const code = main({ env, argv, write: value => { out += value; }, error: value => { err += value; } });
  assert.ok(!out.includes(secret) && !err.includes(secret));
  return { code, out, err };
}

test('real refresh export lines pass, force refresh despite healthy held token, and emit only safe metadata', t => {
  const env = fixture(t, exportsOutput());
  const result = run(env);
  assert.equal(result.code, 0);
  const evidence = JSON.parse(result.out);
  assert.deepEqual(Object.keys(evidence), ['parsed', 'source', 'expiresInSeconds']);
  assert.equal(evidence.parsed, true);
  assert.equal(evidence.source, 'exports');
  assert.ok(evidence.expiresInSeconds > 0);
  // The old prepare()-only check skips this failing refresh on the held expiry.
  assert.equal(run(fixture(t, exportsOutput(), true)).code, 126);
});

test('refresh check accepts numeric timestamps and callable clocks with identical expiry evidence', t => {
  const env = fixture(t, exportsOutput());
  const session = hammerTokenSession({ credentialEnv: env, hammerToken: true });
  const now = Date.parse('2098-12-31T23:58:59.500Z');
  const expected = { parsed: true, source: 'exports', expiresInSeconds: 60 };
  assert.deepEqual(session.checkRefresh(now), expected);
  assert.deepEqual(session.checkRefresh(() => now), expected);
});

test('symlinked CLI executes checks and reports unsupported commands instead of silently succeeding', t => {
  const root = mkdtempSync(join(tmpdir(), 'activation-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'activation check #link.mjs');
  symlinkSync(fileURLToPath(new URL('../src/activation-check.mjs', import.meta.url)), link);
  // The sandbox preserves symlinks globally; exercise Node's ordinary CLI
  // resolution so sibling imports resolve beside the actual script target.
  const nodeArgs = ['--no-preserve-symlinks', '--no-preserve-symlinks-main', link];
  const command = spawnSync(process.execPath, [...nodeArgs, 'daemon-reservation'],
    { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(command.status, 0, command.stderr);
  const evidence = JSON.parse(command.stdout);
  assert.equal(evidence.pollSeconds, reservationEvidence().pollSeconds);
  assert.ok(evidence.reservationSeconds > evidence.pollSeconds);
  assert.equal(command.stderr, '');

  const invalid = spawnSync(process.execPath, [...nodeArgs, 'unsupported'],
    { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(invalid.status, 126);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'activation check unavailable\n');
});

test('HAMTOKEN-05 whitespace-rejecting parser fails on exactly the same export fixture', async t => {
  const env = fixture(t, exportsOutput());
  const source = readFileSync(new URL('../src/hammer-token.mjs', import.meta.url), 'utf8')
    .replace("'./load-aware-timeout.mjs'", JSON.stringify(new URL('../src/load-aware-timeout.mjs', import.meta.url).href))
    .replace('const text = output.trim();', 'const text = output.trim(); if (/\\s/.test(text)) return null;');
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const result = legacy.hammerTokenSession({ credentialEnv: env, hammerToken: true }).checkRefresh();
  assert.deepEqual(result, { parsed: false, source: 'invalid', expiresInSeconds: null });
  assert.equal(hammerTokenSession({ credentialEnv: env, hammerToken: true }).checkRefresh().parsed, true);
});

test('invalid, expired and bare refresh output cannot satisfy the declared export/expiry expectation', t => {
  for (const output of [secret + '\n' + secret, '', `export GH_TOKEN=${secret}\nexport GH_TOKEN_EXPIRES_AT='2000-01-01T00:00:00Z'\n`, secret]) {
    const result = run(fixture(t, output));
    assert.equal(result.code, 0);
    const data = JSON.parse(result.out);
    assert.equal(data.parsed && data.source === 'exports' && data.expiresInSeconds > 0, false);
  }
});

test('missing entitlement, command failures and unsupported check emit fixed errors without credentials', t => {
  for (const env of [{}, fixture(t, exportsOutput(), true), { HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND: `exit 1 # ${secret}` }]) {
    assert.deepEqual(run(env), { code: 126, out: '', err: 'activation check unavailable\n' });
  }
  assert.equal(run({}, [secret]).code, 126);
});

test('reservation uses the effective poll reader and real sizing; incident 120 vs 300 fails', () => {
  const healthy = reservationEvidence({ pollIntervalMs: 300_000 });
  assert.ok(healthy.reservationSeconds > healthy.pollSeconds);
  const incident = reservationEvidence({ pollIntervalMs: 300_000, reservation: () => 120 });
  assert.equal(incident.reservationSeconds > incident.pollSeconds, false);
  assert.deepEqual(reservationEvidence({ pollIntervalMs: 900_000, reservation: ms => ms / 500 }),
    { reservationSeconds: 1800, pollSeconds: 900 });
  const command = spawnSync(process.execPath, ['src/activation-check.mjs', 'daemon-reservation'],
    { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(command.status, 0);
  const observed = JSON.parse(command.stdout);
  assert.equal(observed.pollSeconds, reservationEvidence().pollSeconds);
  assert.ok(observed.reservationSeconds > observed.pollSeconds);
});


test('refresh check scales its timeout once at maximum load and stays below the timer ceiling', t => {
  let calls = 0;
  let refreshOptions;
  const originalExec = childProcess.execFileSync;
  t.mock.method(os, 'loadavg', () => [Number.MAX_SAFE_INTEGER, 0, 0]);
  t.mock.method(childProcess, 'execFileSync', (_file, _args, options) => {
    // Corroborate maximum load without reading the host's current CPU usage.
    if (_file === '/bin/ps') return '1000000\n';
    if (_file !== '/bin/sh') return originalExec(_file, _args, options);
    calls++;
    refreshOptions = options;
    return exportsOutput();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const env = { HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'synthetic-refresh' };
  assert.equal(hammerTokenSession({ credentialEnv: env, hammerToken: true }).checkRefresh().parsed, true);
  assert.equal(calls, 1);
  assert.equal(refreshOptions.timeout, 60_000);
  assert.ok(refreshOptions.timeout <= 2 ** 31 - 1);
  assert.equal(refreshOptions.maxBuffer, 16 * 1024);
  assert.equal(refreshOptions.stdio, 'pipe');
});
