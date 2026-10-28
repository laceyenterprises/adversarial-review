import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Compose before production imports: no host config, process, network or ledger.
const sandbox = mkdtempSync(join(os.tmpdir(), 'host-identity-tests-'));
const previousConfig = process.env.AGENT_OS_CONFIG_PATH;
const configPath = join(sandbox, 'config.yaml');
writeFileSync(configPath, 'version: 1\n');
process.env.AGENT_OS_CONFIG_PATH = configPath;
const loadMock = test.mock.method(os, 'loadavg', () => [0, 0, 0]);
const processMocks = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']
  .map(method => test.mock.method(childProcess, method, () => assert.fail('no child processes in identity fixtures')));
syncBuiltinESMExports();
test.after(() => {
  if (previousConfig === undefined) delete process.env.AGENT_OS_CONFIG_PATH;
  else process.env.AGENT_OS_CONFIG_PATH = previousConfig;
  loadMock.mock.restore();
  for (const mock of processMocks) mock.mock.restore();
  syncBuiltinESMExports();
  rmSync(sandbox, { recursive: true, force: true });
});
const { dispatchReadTransport } = await import('../src/dispatch-read-client.mjs');
const { readHostIdentitySync } = await import('../src/dispatch-files-client.mjs');
const { assertAmaAuditOwner, maybeDispatchAmaCloser } = await import('../src/ama/dispatch-closer.mjs');
const { acquireAmaCloserLease, updateAmaCloserLease, amaCloserLeaseFilePath } = await import('../src/ama/closer-lease.mjs');
const { readClosureNextAction, closureOwnerFromDecision } = await import('../src/ama/closure-next-action.mjs');

const found = { schema_version: 1, status: 'found', ownerUser: 'fixture-owner' };
function reader(t, implementation) {
  t.mock.method(dispatchReadTransport, 'observationSync', implementation);
  // A distinct synthetic authority per test isolates the process-lifetime cache.
  return extra => readHostIdentitySync({ hqRoot: `/fixture/${t.name}`, env: {}, ...extra });
}

test('reproduction: a timeout followed by success does not refuse the closer owner check', t => {
  let calls = 0;
  const read = reader(t, () => {
    if (++calls === 1) throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
    return found;
  });
  assert.doesNotThrow(() => assertAmaAuditOwner({ ...read(), currentUser: 'fixture-owner' }));
  assert.equal(calls, 2);
});

test('successful identity is cached and callers cannot mutate it', t => {
  let calls = 0;
  const read = reader(t, () => { calls++; return found; });
  read().ownerUser = 'changed-by-caller';
  for (let i = 0; i < 5; i++) assert.deepEqual(read(), { ownerUser: 'fixture-owner' });
  assert.equal(calls, 1);
});

test('transient failures stop at three attempts and are never cached', t => {
  let calls = 0;
  const read = reader(t, () => { calls++; return { schema_version: 1, status: 'unavailable' }; });
  assert.deepEqual(read(), { ownerUser: null, reason: 'unavailable' });
  assert.equal(calls, 3);
  assert.deepEqual(read(), { ownerUser: null, reason: 'unavailable' });
  assert.equal(calls, 6);
  t.mock.method(dispatchReadTransport, 'observationSync', () => { calls++; return found; });
  assert.deepEqual(read(), { ownerUser: 'fixture-owner' });
  assert.deepEqual(read(), { ownerUser: 'fixture-owner' });
  assert.equal(calls, 7);
});

for (const [reason, error, reply] of [
  ['timeout', { code: 'ETIMEDOUT' }],
  ['spawn-failure', { code: 'ENOENT', syscall: 'spawnSync node' }],
  ['unavailable', { code: 'ECONNREFUSED' }],
  ['denied', { status: 403 }],
  ['denied', { message: 'app-contract scope_denied: synthetic private detail' }],
  ['malformed', new SyntaxError('synthetic private detail')],
  ['denied', null, { schema_version: 1, status: 'scope_denied' }],
  ['denied', null, { schema_version: 1, status: 'not_found' }],
  ['malformed', null, { schema_version: 2, status: 'found', ownerUser: 'fixture-owner' }],
  ['malformed', null, { schema_version: 1, status: 'found', ownerUser: ' ' }],
  ['malformed', null, null],
]) {
  test(`fixed reason ${reason}: ${JSON.stringify(error ?? reply)}`, t => {
    let calls = 0;
    const read = reader(t, () => { calls++; if (error) throw error; return reply; });
    assert.deepEqual(read(), { ownerUser: null, reason });
    assert.equal(calls, ['denied', 'malformed'].includes(reason) ? 1 : 3);
  });
}

test('retries share the caller deadline and reduce the physical timeout', t => {
  let now = 1000;
  const timeouts = [];
  const delays = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Atomics, 'wait', (_array, _index, _value, delay) => { delays.push(delay); now += delay; });
  const read = reader(t, (_selector, args) => {
    timeouts.push(args.timeoutMs);
    now += 100;
    throw { code: 'ETIMEDOUT' };
  });
  assert.equal(read({ timeoutMs: 8000, deadlineMs: 1250 }).reason, 'timeout');
  assert.deepEqual(timeouts, [250, 100]);
  assert.deepEqual(delays, [50]);
  assert.equal(now, 1250);
});

test('an expired deadline never starts a physical read', t => {
  const read = reader(t, () => assert.fail('expired read'));
  assert.equal(read({ deadlineMs: Date.now() - 1 }).reason, 'timeout');
});

test('launch token stays the first choice with its existing default timeout', t => {
  t.mock.method(Date, 'now', () => 1000);
  let calls = 0;
  const read = reader(t, () => assert.fail('must use own launch token'));
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ readHcpDispatchLookupSync: (request, options) => {
    calls++;
    assert.deepEqual(request, { observation: 'host_identity' });
    assert.equal(options.request_timeout_ms, 8000);
    assert.equal(options.token, 'synthetic-token');
    return found;
  } }));
  const args = { env: { HQ_LAUNCH_REQUEST_ID: 'synthetic-launch', HCP_TOKEN: 'synthetic-token' } };
  assert.deepEqual(read(args), { ownerUser: 'fixture-owner' });
  assert.deepEqual(read(args), { ownerUser: 'fixture-owner' });
  assert.equal(calls, 1);
});

test('owner mismatch still refuses', t => {
  const read = reader(t, () => found);
  assert.throws(() => assertAmaAuditOwner({ ...read(), currentUser: 'other-fixture-user' }), /does not match/);
});

function closerFixture(t, observe) {
  const rootDir = mkdtempSync(join(sandbox, 'closer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example-org/example-repo', prNumber: 42, headSha: 'c'.repeat(40) };
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid, host: 'fixture-host',
    dispatchTimeoutMs: 60000, now: '2026-01-01T00:00:00.000Z' });
  updateAmaCloserLease({ rootDir, ...identity, status: 'handed-to-review', now: '2026-01-01T00:00:00.000Z' });
  const leasePath = amaCloserLeaseFilePath(rootDir, identity);
  const before = readFileSync(leasePath, 'utf8');
  let calls = 0;
  const fail = () => { calls++; return observe(); };
  t.mock.method(dispatchReadTransport, 'observationSync', fail);
  const sdk = dispatchReadTransport.sdk();
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk, readHcpDispatchLookupSync: fail }));
  const deadlineMs = Date.now() + 60000;
  const args = {
    env: { AGENT_OS_CONFIG_PATH: configPath },
    reviewState: { verdict: 'comment-only', reviewCycleExhausted: true, headSha: identity.headSha,
      riskClass: 'low', remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'fixture-builder' },
    prMetadata: { ...identity, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
      author: 'fixture-builder', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['test'] } },
    cfg: { enabled: true, workerClass: 'hammer', eligibility: { riskClasses: ['low'] } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: 'test' }, primaryChange: { headSha: identity.headSha, ciCost: { headSha: identity.headSha, ok: true },
      hasHammerCommits: false } },
    dispatchContext: { rootDir, hqRoot: rootDir, repo: identity.repo, reviewedSha: identity.headSha, requiredGateContext: 'test',
      currentUser: 'fixture-owner', deadlineMs, dispatchedAt: '2026-01-01T00:00:01.000Z' },
    readTemplateImpl: () => 'synthetic prompt',
    execFileImpl: async () => assert.fail('identity defer must precede dispatch'),
    logger: { log() {}, warn() {}, info() {}, error() {} },
  };
  return { args, leasePath, before, deadlineMs, calls: () => calls };
}

for (const status of ['not_found', 'scope_denied', 'denied', 'unknown']) {
  test(`closer refuses definitive ${status} identity evidence`, async t => {
    const fixture = closerFixture(t, () => ({ schema_version: 1, status }));
    await assert.rejects(maybeDispatchAmaCloser(fixture.args), /AMA audit bootstrap refused:.*host-identity-(?:denied|malformed)/);
    assert.equal(readFileSync(fixture.leasePath, 'utf8'), fixture.before);
    assert.equal(fixture.calls(), 1);
  });
}

test('closer mismatch refuses with the existing owner-mismatch diagnostic', async t => {
  const fixture = closerFixture(t, () => found);
  fixture.args.dispatchContext.currentUser = 'other-fixture-user';
  // Admit the hammer findings path so its existing ownership assertion runs.
  fixture.args.reviewState.nonBlockingFindingCount = 1;
  await assert.rejects(maybeDispatchAmaCloser(fixture.args), /current user 'other-fixture-user' does not match HQ ownerUser 'fixture-owner'/);
  assert.equal(readFileSync(fixture.leasePath, 'utf8'), fixture.before);
});

for (const reason of ['timeout', 'spawn-failure', 'unavailable']) {
  test(`closer ${reason} defer preserves its closure owner, lease and deadline across polls`, async t => {
    const fixture = closerFixture(t, () => {
      if (reason === 'unavailable') return { schema_version: 1, status: 'unavailable' };
      throw { code: reason === 'timeout' ? 'ETIMEDOUT' : 'ENOENT' };
    });
    const { args, leasePath, before, deadlineMs } = fixture;
    const first = await maybeDispatchAmaCloser(args);
    assert.equal(first.reason, `host-identity-${reason}`);
    assert.equal(first.dispatched, false);
    assert.equal(first.recoveryWait, true);
    assert.equal(first.skipMergeAgent, true);
    assert.equal(first.retryable, true);
    assert.equal(first.preservePredecessorArtifacts, true);
    const shared = readClosureNextAction(first);
    assert.ok(shared);
    const second = await maybeDispatchAmaCloser({ ...args, sharedNextAction: shared });
    assert.deepEqual(closureOwnerFromDecision(readClosureNextAction(second).decision), closureOwnerFromDecision(shared.decision));
    assert.deepEqual(readClosureNextAction(second).decision.deadline, shared.decision.deadline);
    assert.equal(args.dispatchContext.deadlineMs, deadlineMs);
    assert.equal(readFileSync(leasePath, 'utf8'), before);
    assert.equal(fixture.calls(), 6, 'next poll tries again; no failure was cached');
  });
}
