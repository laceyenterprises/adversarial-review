import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLaunchRequestStatus } from '../src/producer-contracts/launch-status.mjs';
import { AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES } from '../src/ama/launch-request-status.mjs';
import { readDispatchReceipt } from '../src/producer-contracts/dispatch-receipt.mjs';
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

test('refresh CLI rejects missing or extra source arguments with usage, without a traceback', () => {
  const script = fileURLToPath(new URL('../scripts/contracts/refresh.py', import.meta.url));
  for (const args of [[], ['unused-source', 'extra']]) {
    const result = spawnSync('python3', [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: python3 scripts/contracts/refresh.py <path-to-agent-os>\n');
  }
});

for (const stdout of ['', 'unavailable', 'banner\n{invalid}']) {
  test(`negative stdout mutation: ${JSON.stringify(stdout)} names producer and transport field`, () => {
    assert.throws(() => parseHqFleetQuotaSnapshot(stdout), /cwp_dispatch.cli_fleet: \$stdout (empty|invalid JSON)/);
    assert.throws(() => parseHqDispatchStatus(stdout), /cwp_dispatch.dispatch: \$stdout (empty|invalid JSON)/);
  });
}

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
});

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
    if (!sample.stdout.trim()) assert.throws(() => readDispatchReceipt(sample.stdout), /cwp_dispatch.dispatch: \$stdout invalid JSON/);
    else {
      const result = readDispatchReceipt(sample.stdout);
      assert.equal(result.launchRequestId, null);
      assert.match(result.identityDiagnostic, /cwp_dispatch.dispatch: \$\.launchRequestId/);
    }
  });
}
