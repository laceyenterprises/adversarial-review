import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readLaunchRequestStatus, readDispatchStatus, assertTerminalLaunchPolicy } from '../src/producer-contracts/launch-status.mjs';
import { boundedDiagnostics, diagnosticValue } from '../src/producer-contracts/diagnostics.mjs';
import { AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES, isTerminalLaunchRequestStatus, withLiveLaunchRetry } from '../src/ama/launch-request-status.mjs';
import { readDispatchReceipt, parseDispatchJsonOutput } from '../src/producer-contracts/dispatch-receipt.mjs';
import { readBrokerProvider } from '../src/producer-contracts/broker-evidence.mjs';
import { readAdapterReceipt, readPrCreateReceipt } from '../src/producer-contracts/publication-receipt.mjs';
import { readReserveFloorWeeklyEvidence, reserveFloorWeeklyMeasurement, parseHqFleetQuotaSnapshot } from '../src/fleet-quota-status.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { selectCodexReviewerAccount, selectCodexWorkerAccount } from '../src/codex-account-routing.mjs';
import { selectClaudeAccountLaneFromSnapshot } from '../src/claude-account-routing.mjs';
import { afhGroundingSnapshotFromStdout, applyAfhReviewerFallback } from '../src/afh-reviewer-fallback.mjs';
import { createReviewerQuotaBlockLogger } from '../src/reviewer-quota-block-log.mjs';
import { parseHqDispatchStatus } from '../src/remediation-hq-dispatch.mjs';
import { __test__ as adapterTest } from '../src/github-adapter-client.mjs';
const { parseAdapterJson } = adapterTest;

const capture = path => JSON.parse(readFileSync(new URL(`./fixtures/producer-contracts/${path}.json`, import.meta.url), 'utf8'));

test('refresh CLI rejects missing or extra source arguments with usage, without a traceback', t => {
  const script = fileURLToPath(new URL('../scripts/contracts/refresh.py', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PYTHON')));
  const options = { encoding: 'utf8', timeout: 5000, env };
  const probe = spawnSync('python3', ['-I', '-c', 'import sys'], options);
  if (probe.error || probe.status !== 0) return t.skip('python3 is optional; no working interpreter for artifact refresh');
  for (const args of [[], ['unused-source', 'extra']]) {
    const result = spawnSync('python3', ['-I', script, ...args], options);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: python3 scripts/contracts/refresh.py <path-to-agent-os>\n');
  }
});

test('fleet captures pin shared quota sections and collapsed expired evidence', () => {
  const ready = capture('quota/fleet-ready');
  for (const scenario of ['degraded', 'unavailable', 'disabled']) {
    const other = capture(`quota/fleet-${scenario}`);
    for (const key of ['providerStatuses', 'reserveFloors']) assert.deepEqual(other[key], ready[key], key);
  }
  assert.deepEqual(capture('quota/repaired-expired'), capture('quota/repaired-five-hour-only'),
    'producer deliberately collapses expired and short-only weekly evidence');
});

test('real released fleet output admits personal Claude after local corporate exhaustion', () => {
  const fleet = capture('quota/fleet-released');
  const floor = fleet.reserveFloors['anthropic-oauth'];
  assert.equal(floor.released, true);
  for (const key of ['active', 'paused', 'nearCap']) assert.equal(floor[key], false, key);
  assert.equal(floor.weeklyMeasurement.status, 'measured');
  const route = selectClaudeAccountLaneFromSnapshot(fleet, {
    workerClass: 'claude-reviewer', blockedWorkerClasses: ['claude-reviewer-corp'],
  });
  assert.equal(route.workerClass, 'claude-reviewer');
  assert.equal(route.hold, false);
  assert.equal(route.reason, 'claude-account-ready');
  const provenance = capture('released-provenance');
  const bytes = readFileSync(new URL('./fixtures/producer-contracts/quota/fleet-released.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
  const generator = readFileSync(new URL(`../${provenance.generator}`, import.meta.url));
  assert.equal(createHash('sha256').update(generator).digest('hex'), provenance.generatorSha256);
});

test('dispatch status probes keep worker vocabulary and producer diagnostics', () => {
  for (const status of ['completed', 'not-found', 'blocked', 'stalled', 'reaped', 'rejected', 'future']) {
    const payload = { status, diagnostic: 'producer detail' };
    for (const normalize of [true, false]) {
      const result = parseHqDispatchStatus(JSON.stringify(payload), { normalize });
      assert.equal(result.status, status);
      assert.equal(result.diagnostic, 'producer detail');
    }
    assert.equal(parseHqDispatchStatus(JSON.stringify({ status })).diagnostic, undefined);
  }
});

test('post-dispatch JSON string evidence stays recordable with null identity', () => {
  const parsed = parseDispatchJsonOutput('"queued worker"');
  const result = readDispatchReceipt(parsed, { allowNonObject: true });
  assert.equal(result.payload, 'queued worker');
  assert.equal(result.launchRequestId, null);
  assert.match(result.identityDiagnostic, /\$stdout invalid type/);
});

test('terminal policies fail loudly on drift and reject legacy launch aliases', () => {
  assert.doesNotThrow(() => assertTerminalLaunchPolicy(AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES));
  assert.throws(() => assertTerminalLaunchPolicy(['future-terminal']), /terminal policy missing/);
  assert.throws(() => assertTerminalLaunchPolicy(['running']), /terminal policy missing/);
  const legacy = ['cancelled', 'completed', 'reaped', 'rejected'];
  for (const status of legacy) {
    assert.equal(isTerminalLaunchRequestStatus(status), false, status);
    assert.equal(readDispatchStatus({ status }).status, null, status);
    assert.equal(readDispatchStatus({ status }).succeeded, false, status);
  }
  const probe = withLiveLaunchRetry({ ok: true, row: { ticket_ref: 'FIXTURE' }, retryChain: [
    { status: 'failed', launch_request_id: 'dead' },
    { status: 'running', launch_request_id: 'live' },
  ] });
  assert.equal(probe.liveRetryLaunchRequestId, 'live');
  assert.equal(probe.row.ticket_ref, 'FIXTURE');
});

test('consumer modules reject producer drift before filtering terminal policy', () => {
  const vocabularyUrl = new URL('../src/producer-contracts/launch-status.mjs', import.meta.url).href;
  for (const [path, status] of [
    ['../src/ama/launch-request-status.mjs', 'reaped_stuck_requested'],
  ]) {
    const moduleUrl = new URL(path, import.meta.url).href;
    const code = `import { TERMINAL_LAUNCH_REQUEST_STATUSES } from ${JSON.stringify(vocabularyUrl)};
TERMINAL_LAUNCH_REQUEST_STATUSES.delete(${JSON.stringify(status)});
await import(${JSON.stringify(moduleUrl)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, path);
    assert.match(result.stderr, new RegExp(`terminal policy missing from producer vocabulary: ${status}`));
  }
});

test('changing broker diagnostics do not repeat the same quota deferral', () => {
  const messages = [];
  const log = createReviewerQuotaBlockLogger();
  for (const error of ['timeout at 10:00', 'timeout at 10:01']) {
    log({ repoPath: 'example/repo', prNumber: 1, logger: { warn: text => messages.push(text) },
      route: { quotaBlocked: true, reviewerModel: 'codex', quotaGrounding: {
        state: 'unknown', reason: 'broker-unavailable', diagnostics: [`unavailableSections.brokerAuth=${error}`],
      } } });
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /timeout at 10:00/);
  log({ repoPath: 'example/repo', prNumber: 1, logger: { warn: text => messages.push(text) },
    route: { quotaBlocked: true, reviewerModel: 'codex', quotaGrounding: {
      state: 'unknown', reason: 'broker-unavailable', diagnostics: ['reserveFloors.openai.weeklyMeasurement missing'],
    } } });
  assert.equal(messages.length, 2, 'a different diagnostic field is a grounding transition');
});

for (const stdout of ['', 'unavailable', 'banner\n{invalid}']) {
  test(`negative stdout mutation: ${JSON.stringify(stdout)} names producer and transport field`, () => {
    const condition = stdout ? 'invalid JSON' : 'empty';
    assert.throws(() => parseHqFleetQuotaSnapshot(stdout), new RegExp(`cwp_dispatch.cli_fleet: \\$stdout ${condition}`));
    assert.throws(() => parseHqDispatchStatus(stdout), new RegExp(`cwp_dispatch.dispatch: \\$stdout ${condition}`));
    assert.throws(() => readDispatchReceipt(stdout), new RegExp(`cwp_dispatch.dispatch: \\$stdout ${condition}`));
  });
}

test('malformed status probes retain a bounded stdout tail with and without braces', () => {
  for (const output of ['x'.repeat(4000) + 'last output', 'x'.repeat(4000) + '{invalid}']) {
    assert.throws(() => parseHqDispatchStatus(output), error => {
      assert.ok(error.message.endsWith(`stdout tail: ${output.slice(-1000)}`));
      assert.ok(error.message.length < 1200);
      return true;
    });
  }
});

test('producer diagnostics stay bounded through routing, repeated fallbacks and logs', async () => {
  const detail = 'producer stderr '.repeat(4000);
  assert.equal(diagnosticValue(detail).length, 200);
  const many = Array.from({ length: 40 }, (_, i) => `${i}: ${detail}`);
  const limited = boundedDiagnostics(many.flatMap(value => [value, value]));
  assert.equal(limited.length, 20);
  assert.ok(limited.every(value => value.length === 500));
  const fleet = capture('quota/fleet-ready');
  fleet.unavailableSections = { brokerAuth: detail };
  for (const row of fleet.providerStatuses) row.state = 'exhausted';
  for (const state of Object.values(fleet.brokerAuth.provider_states)) state.ready = false;
  const result = await resolveCloserDispatchHarness({ workerClass: 'hammer-corp',
    fallbackWorkerClasses: Array(40).fill('hammer-claude'),
    execFileImpl: async () => ({ stdout: JSON.stringify(fleet) }), env: {},
  });
  assert.equal(result.hold, true);
  for (const route of [result, selectCodexWorkerAccount(fleet),
    selectClaudeAccountLaneFromSnapshot(fleet, { workerClass: 'claude-reviewer' })]) {
    assert.ok(route.diagnostics.some(value => value.includes('unavailableSections.brokerAuth=')));
    assert.equal(new Set(route.diagnostics).size, route.diagnostics.length);
    assert.ok(route.diagnostics.length <= 20);
    assert.ok(route.diagnostics.every(value => value.length <= 500 && !value.includes(detail)));
  }
  const messages = [];
  createReviewerQuotaBlockLogger()({ repoPath: 'example/repo', prNumber: 1,
    route: { quotaBlocked: true, quotaGrounding: { diagnostics: many } },
    logger: { warn: message => messages.push(message) } });
  assert.ok(messages[0].length < 11000);
});

test('refresh removes deleted managed artifacts and preserves separately pinned captures', t => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PYTHON')));
  const options = { encoding: 'utf8', timeout: 10000, env };
  const probe = spawnSync('python3', ['-I', '-c', 'import sys'], options);
  if (probe.error || probe.status !== 0) return t.skip('python3 is optional; no working interpreter');
  const scratch = mkdtempSync(join(tmpdir(), 'producer-refresh-'));
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  try {
    const source = join(scratch, 'producer');
    const consumer = join(scratch, 'consumer');
    mkdirSync(join(consumer, 'src/producer-contracts'), { recursive: true });
    const fixtures = join(consumer, 'test/fixtures/producer-contracts');
    const provenance = capture('provenance');
    for (const [artifact, record] of Object.entries(provenance.files)) {
      put(join(source, record.source), readFileSync(new URL(`./fixtures/producer-contracts/${artifact}`, import.meta.url)));
    }
    // Definitions are inert excerpts; only this dependency-free module executes.
    put(join(source, 'platform/session-ledger/src/session_ledger/launch_request_terminal_statuses.py'),
      'LAUNCH_REQUEST_STATUSES = {"running", "succeeded"}\nTERMINAL_LAUNCH_REQUEST_STATUSES = {"succeeded"}\n');
    const script = join(consumer, 'scripts/contracts/refresh.py');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(new URL('../scripts/contracts/refresh.py', import.meta.url), script);
    for (const directory of ['quota', 'broker', 'launch', 'dispatch', 'publication', 'definitions']) {
      put(join(fixtures, directory, directory === 'definitions' ? 'deleted.py.txt' : 'deleted.json'), 'stale');
    }
    put(join(fixtures, 'quota/fleet-released.json'), 'separately pinned');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
      const git = spawnSync('git', ['-C', source, ...args], options);
      assert.ifError(git.error);
      assert.equal(git.status, 0, git.stderr);
    }
    const result = spawnSync('python3', ['-I', script, source], options);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    for (const directory of ['quota', 'broker', 'launch', 'dispatch', 'publication', 'definitions']) {
      assert.equal(existsSync(join(fixtures, directory, directory === 'definitions' ? 'deleted.py.txt' : 'deleted.json')), false);
    }
    assert.equal(readFileSync(join(fixtures, 'quota/fleet-released.json'), 'utf8'), 'separately pinned');
    const refreshed = JSON.parse(readFileSync(join(fixtures, 'provenance.json')));
    for (const [artifact, record] of Object.entries(refreshed.files)) {
      assert.equal(createHash('sha256').update(readFileSync(join(fixtures, artifact))).digest('hex'), record.sha256);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('unavailable closer evidence retains hold policy and names producer stdout', async () => {
  const result = await resolveCloserDispatchHarness({ workerClass: 'hammer', codexAccountPolicy: 'personal-first', env: {},
    execFileImpl: async () => { throw new Error('fixture transport unavailable'); }, sleepImpl: async () => {} });
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
  assert.match(result.diagnostics.join('; '), /cwp_dispatch.cli_fleet: \$stdout unavailable/);
});

for (const scenario of ['measured', 'disabled', 'absent', 'five-hour-only', 'expired', 'stale', 'unavailable']) {
  test(`producer weekly capture: ${scenario} preserves independent seven-day evidence`, () => {
    const floors = capture(`quota/repaired-${scenario}`);
    for (const [credential, floor] of Object.entries(floors)) {
      const result = readReserveFloorWeeklyEvidence(floor, credential);
      if (['measured', 'disabled'].includes(scenario)) {
        assert.equal(result.measurement.status, 'measured');
        assert.equal(result.measurement.percentRemaining, credential.endsWith('corp') ? 60 : 75);
        assert.deepEqual(result.diagnostics, []);
        assert.notEqual(result.measurement.percentRemaining, floor.measurement.percentRemaining);
      } else {
        assert.notEqual(result.measurement?.status, 'measured');
        assert.match(result.diagnostics.join('; '), /quota_reserve.snapshot: reserveFloors\./);
        assert.match(result.diagnostics.join('; '), /weeklyMeasurement/);
      }
    }
  });
}

test('legacy compatibility: pre-repair confidence/measurement fallback remains readable', () => {
  // Explicit legacy shape, not evidence of a current producer output.
  const reading = { confidence: 'measured', inferred: false, percentRemaining: 42 };
  assert.equal(reserveFloorWeeklyMeasurement({ weeklyMeasurement: null, measurement: reading }).percentRemaining, 42);
});

for (const [label, mutate, field] of [
  ['missing floor', floors => { delete floors['openai-oauth-corp']; }, 'reserveFloors.openai-oauth-corp'],
  ['null weekly', floors => { floors['openai-oauth-corp'].weeklyMeasurement = null; }, 'weeklyMeasurement'],
  ['wrong percentage type', floors => { floors['openai-oauth-corp'].weeklyMeasurement.percentRemaining = false; }, 'percentRemaining'],
  ['unknown status', floors => { floors['openai-oauth-corp'].weeklyMeasurement.status = 'future'; }, 'status="future"'],
]) test(`negative weekly mutation: ${label} names producer and field`, () => {
  const floors = capture('quota/repaired-measured');
  mutate(floors);
  const evidence = readReserveFloorWeeklyEvidence(floors['openai-oauth-corp'], 'openai-oauth-corp');
  assert.ok(evidence.diagnostics.some(d => d.includes('quota_reserve.snapshot') && d.includes(field)));
  assert.ok(evidence.measurement?.status !== 'measured' || !Number.isFinite(evidence.measurement.percentRemaining),
    'invalid weekly evidence cannot supply measured capacity through the short-window fallback');
});

// Labelled consumer mutation: owner captures deliberately use unknown OpenAI
// probes. Change only those probe states to exercise current-shape admission.
function fleetWithHealthyOpenaiProbes() {
  const fleet = capture('quota/fleet-ready');
  for (const row of fleet.providerStatuses) if (row.provider === 'openai') row.state = 'ok';
  return fleet;
}

test('consumer probe mutation admits current-shape Codex weekly evidence', () => {
  const fleet = fleetWithHealthyOpenaiProbes();
  const route = selectCodexReviewerAccount(fleet);
  assert.equal(route.hold, false);
  assert.equal(route.provider, 'codex-corp');
  assert.equal(selectCodexWorkerAccount(fleet).hold, false);
});

for (const reason of ['no-weekly-window', null]) {
  test(`weekly reason key ${JSON.stringify(reason)} holds; absent key retains legacy fallback`, () => {
    const fleet = fleetWithHealthyOpenaiProbes();
    for (const credential of ['openai-oauth', 'openai-oauth-corp']) {
      const floor = fleet.reserveFloors[credential];
      assert.equal(floor.measurement.status, 'measured');
      floor.weeklyMeasurement = null;
      floor.weeklyMeasurementReason = reason;
      assert.equal(readReserveFloorWeeklyEvidence(floor, credential).measurement, null);
    }
    for (const route of [selectCodexReviewerAccount(fleet), selectCodexWorkerAccount(fleet)]) {
      assert.equal(route.hold, true);
      assert.equal(route.reason, 'codex-account-evidence-unknown');
    }
    for (const credential of ['openai-oauth', 'openai-oauth-corp']) {
      delete fleet.reserveFloors[credential].weeklyMeasurementReason;
    }
    const legacy = selectCodexReviewerAccount(fleet);
    assert.equal(legacy.hold, false);
    assert.equal(legacy.provider, 'codex-corp');
    assert.equal(selectCodexWorkerAccount(fleet).hold, false);
  });
}

test('negative fleet mutation: wrong providerStatuses type preserves the routing exception and names its field', () => {
  const fleet = capture('quota/fleet-ready');
  fleet.providerStatuses = {};
  assert.throws(() => selectClaudeAccountLaneFromSnapshot(fleet, { workerClass: 'claude-reviewer' }),
    { name: 'TypeError', message: /cwp_dispatch.cli_fleet: \$\.providerStatuses invalid; expected array/ });
});

for (const scenario of ['ready', 'degraded', 'unavailable', 'disabled']) {
  test(`broker/fleet producer capture: ${scenario} keeps readiness distinct from servability`, () => {
    const broker = capture(`broker/readyz-${scenario}`).payload;
    const fleet = capture(`quota/fleet-${scenario}`);
    const claude = selectClaudeAccountLaneFromSnapshot(fleet, { workerClass: 'claude-reviewer' });
    assert.equal(claude.hold, scenario !== 'ready' && scenario !== 'disabled');
    const evidence = readBrokerProvider(broker, 'codex-corp');
    assert.equal(evidence.canServe, scenario !== 'unavailable');
    if (scenario === 'degraded') assert.equal(evidence.ready, false);
    // This real fleet scenario has unknown OpenAI probe state despite measured
    // weekly capacity. Do not upgrade it to a synthetic healthy account.
    for (const route of [selectCodexReviewerAccount(fleet), selectCodexWorkerAccount(fleet)]) {
      assert.equal(route.hold, true);
      assert.match(route.diagnostics.join('; '), /cwp_dispatch.cli_fleet: providerStatuses\[provider=openai,authPath=oauth-corp\].state="unknown"/);
    }
  });
}

for (const [label, mutate, field] of [
  ['missing', body => { delete body.provider_states['codex-corp']; }, 'provider_states.codex-corp'],
  ['null', body => { body.provider_states['codex-corp'] = null; }, 'provider_states.codex-corp'],
  ['wrong type', body => { body.provider_states['codex-corp'].ready = 'true'; }, '.ready'],
  ['status', body => { body.provider_states['codex-corp'].state = 'future'; }, 'unrecognized "future"'],
]) test(`negative broker mutation: ${label} names producer and field`, () => {
  const body = capture('broker/readyz-ready').payload;
  mutate(body);
  assert.ok(readBrokerProvider(body, 'codex-corp').diagnostics.some(d => d.includes('oauth_broker.server.readyz') && d.includes(field)));
});

test('hold diagnostics survive reviewer routing and transition logging', () => {
  const fleet = capture('quota/fleet-ready');
  const route = applyAfhReviewerFallback({ builderClass: 'claude-code',
    baseRoute: { reviewerModel: 'codex' }, grounding: afhGroundingSnapshotFromStdout(JSON.stringify(fleet)),
    geminiReviewerMode: 'off' });
  assert.equal(route.quotaBlocked, true);
  const messages = [];
  const log = createReviewerQuotaBlockLogger();
  log({ repoPath: 'example/repo', prNumber: 1, route, logger: { warn: text => messages.push(text) } });
  assert.match(messages[0], /diagnostic=cwp_dispatch.cli_fleet: providerStatuses/);
});

test('ledger producer rows: terminality and success follow owner vocabulary', () => {
  for (const row of Object.values(capture('launch/rows'))) {
    const evidence = readLaunchRequestStatus(row.status);
    assert.equal(evidence.diagnostic, null);
    assert.equal(evidence.terminal, row.terminal_at !== null, row.status);
    assert.equal(evidence.succeeded, row.status === 'succeeded');
  }
  assert.equal(readLaunchRequestStatus('blocked_needs_decision').terminal, true);
  assert.equal(readLaunchRequestStatus('blocked_needs_decision').succeeded, false);
  assert.equal(AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES.has('blocked_needs_decision'), false,
    'producer terminality does not expand closer retry authority');
});

for (const value of [undefined, null, false, 1, 'completed', 'cancelled', 'future']) {
  test(`negative launch-status mutation: ${String(value)}`, () => {
    const result = readLaunchRequestStatus(value);
    assert.equal(result.terminal, false);
    assert.match(result.diagnostic, /session_ledger: launch_requests.status (missing|unrecognized value)/);
  });
}

for (const scenario of ['accepted', 'queued', 'running', 'completed', 'diagnostic-error-after-enqueue']) {
  test(`dispatch producer capture: ${scenario} is evidence, independent of child exit and delivery`, () => {
    const sample = capture(`dispatch/${scenario}`);
    const result = readDispatchReceipt(sample.stdout);
    assert.equal(sample.exitCode, 0);
    assert.equal(result.launchRequestId, '<launch-request-id>');
    assert.equal(result.identityDiagnostic, null);
    assert.equal(result.status.diagnostic, null);
    assert.equal(result.status.terminal, scenario === 'completed');
    assert.equal(parseHqDispatchStatus(sample.stdout).status, result.status.status);
  });
}

test('dispatch identity fallback skips whitespace aliases and retains caller precedence', () => {
  for (const blank of ['', '   ', '\t\r\n']) {
    for (const [payload, options, expected] of [
      [{ launchRequestId: blank, dispatchId: 'disp-1', lrq: 'lrq-1' }, {}, 'disp-1'],
      [{ launchRequestId: blank, dispatchId: blank, lrq: 'lrq-1' }, {}, 'lrq-1'],
      [{ launchRequestId: 'launch-1', dispatchId: blank, lrq: 'lrq-1' },
        { identityFields: ['dispatchId', 'lrq', 'launchRequestId'] }, 'lrq-1'],
    ]) {
      const result = readDispatchReceipt({ ...payload, status: 'running' }, options);
      assert.equal(result.launchRequestId, expected);
      assert.equal(result.rawIdentity, expected);
      assert.equal(result.identityDiagnostic, null);
    }
  }
  const invalid = readDispatchReceipt({ launchRequestId: ' ', dispatchId: '\t', lrq: '\n' });
  assert.equal(invalid.launchRequestId, null);
  assert.match(invalid.identityDiagnostic, /\$\.launchRequestId invalid;.*\$\.dispatchId invalid;.*\$\.lrq invalid/);
});

for (const [label, mutate, field] of [
  ['missing identity', p => { delete p.launchRequestId; delete p.dispatchId; }, '$.launchRequestId'],
  ['null identity', p => { p.launchRequestId = null; delete p.dispatchId; }, '$.launchRequestId'],
  ['wrong identity type', p => { p.launchRequestId = 3; }, '$.launchRequestId'],
  ['missing status', p => { delete p.status; }, '$.status'],
  ['null status', p => { p.status = null; }, '$.status'],
  ['wrong status type', p => { p.status = 3; }, '$.status'],
  ['unknown status', p => { p.status = 'future'; }, '$.status'],
]) test(`negative dispatch mutation: ${label}`, () => {
  const payload = JSON.parse(capture('dispatch/accepted').stdout);
  mutate(payload);
  const result = readDispatchReceipt(payload);
  assert.match([result.identityDiagnostic, result.status.diagnostic].filter(Boolean).join('; '), /cwp_dispatch.dispatch:/);
  assert.ok([result.identityDiagnostic, result.status.diagnostic].some(d => d?.includes(field)));
});

test('publication producer captures separate remote acceptance and failed local closeout', () => {
  for (const scenario of ['accepted', 'capture-failed', 'missing-url', 'refused']) {
    const sample = capture(`publication/${scenario}`);
    const envelope = sample.adapter[0];
    const parsed = parseAdapterJson(JSON.stringify(envelope), 'publication');
    assert.deepEqual(parsed, envelope);
    assert.equal(readAdapterReceipt(parsed).accepted, scenario !== 'refused');
    const receipt = readPrCreateReceipt(parsed);
    assert.equal(receipt.accepted, scenario !== 'refused');
    if (scenario === 'missing-url') assert.match(receipt.diagnostics.join(), /create_pr: \$.url/);
    if (scenario === 'capture-failed') assert.equal(sample.returncode, 3);
    if (scenario === 'accepted') assert.equal(sample.returncode, 0);
  }
  assert.deepEqual(capture('publication/accepted').sidecar, capture('publication/capture-failed').sidecar,
    'D1 does not prove successful completion capture');
});

test('negative publication mutations preserve existing permissive read policy and diagnose drift', () => {
  for (const value of [undefined, null, 'true']) {
    const envelope = capture('publication/accepted').adapter[0];
    envelope.ok = value;
    const receipt = readAdapterReceipt(envelope);
    assert.match(receipt.diagnostics.join(), /ResultEnvelope: \$.ok missing\/invalid boolean/);
    assert.deepEqual(parseAdapterJson(JSON.stringify(envelope), 'publication'), JSON.parse(JSON.stringify(envelope)));
  }
});

for (const scenario of ['refused', 'structured-refused', 'dry-run-refused']) {
  test(`dispatch producer unavailable capture: ${scenario} never supplies launch identity`, () => {
    const sample = capture(`dispatch/${scenario}`);
    assert.notEqual(sample.exitCode, 0);
    if (!sample.stdout.trim()) assert.throws(() => readDispatchReceipt(sample.stdout), /cwp_dispatch.dispatch: \$stdout empty/);
    else {
      const result = readDispatchReceipt(sample.stdout);
      assert.equal(result.launchRequestId, null);
      assert.match(result.identityDiagnostic, /cwp_dispatch.dispatch: \$\.launchRequestId/);
    }
  });
}

test('negative dispatch receipt mutation: explicit false cannot become launch success', () => {
  const completed = JSON.parse(capture('dispatch/completed').stdout);
  for (const overrides of [
    { terminal: false }, { succeeded: false }, { terminal: false, succeeded: false },
  ]) {
    const receipt = readDispatchReceipt(JSON.stringify({ ...completed, ...overrides }));
    assert.equal(receipt.status.terminal, overrides.terminal ?? true);
    assert.equal(receipt.status.succeeded, overrides.succeeded ?? true);
  }
  const malformed = readDispatchReceipt({ ...completed, terminal: 'false', succeeded: null });
  assert.ok(malformed.status.diagnostics.some(d => d.includes('$.terminal')));
  assert.ok(malformed.status.diagnostics.some(d => d.includes('$.succeeded')));
});
