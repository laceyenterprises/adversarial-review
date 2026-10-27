import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverAmaAutomation } from '../src/ama/automated-recovery.mjs';
import { dispatchSafetyStopRepair } from '../src/ama/safety-stop-repair.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { bindClosureNextAction, observeClosureResult } from '../src/ama/closure-next-action.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { matrixPair, HEAD, quiet } from './helpers/next-action-matrix.mjs';

function setup(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'safety-stop-repair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const refusal = { key: 'f'.repeat(64), reasons: ['primary-change-reverted'], repairable: true,
    next: 'Repair the region while preserving the catalog contract.',
    missingEvidence: { summary: 'rejected: PRR_fixture finding=1 (original-reversal-not-proven-before-supersession: no candidate with the same commit message)',
      path: 'docs/CATALOG.md', regions: [{ start: 10, end: 12 }] } };
  const stop = { headSha: HEAD, predicate: 'primary-change-reverted', deterministic: true, refusal };
  const shared = observeClosureResult(matrixPair(), { hammerStop: stop });
  const result = bindClosureNextAction({ nextAction: shared.decision, hammerStop: stop }, shared);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const commands = [], pages = [];
  const options = { rootDir, repo: 'subject-07', prNumber: 7, headSha: HEAD, result, logger: quiet,
    now: () => now, pageImpl: async (...args) => pages.push(args),
    readRepairStatusImpl: async () => ({ ok: true, row: { status: 'running' } }),
    repairOptions: { cfg: { enabled: true, autonomousMergeExecutionEnabled: true, hammerLifetimeDispatchCeiling: 6 },
      env: { HQ_ROOT: rootDir }, fleetStopImpl: () => null, workerClassImpl: () => 'codex',
      probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
      execFileImpl: async (command, args) => {
        commands.push({ command, args });
        if (command === 'gh') return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD,
          headRefName: 'fixture/repair', isDraft: false, labels: [] }) };
        return { stdout: JSON.stringify({ launchRequestId: 'repair-07', status: 'queued' }) };
      } },
  };
  return { options, refusal, commands, pages, advance: () => { now += 31 * 60_000; } };
}

test('R05 recorded repair dispatches one scoped PR update, then pages exhaustion once', async t => {
  const f = setup(t);
  const first = await recoverAmaAutomation(f.options);
  assert.equal(first.recovery.action, 'scoped-repair');
  const launch = f.commands.find(call => call.command === 'hq');
  assert.ok(launch);
  const arg = flag => launch.args[launch.args.indexOf(flag) + 1];
  assert.equal(arg('--task-kind'), 'coding');
  assert.equal(arg('--completion-shape'), 'branch-push');
  assert.equal(arg('--required-outcome'), 'push');
  assert.equal(arg('--pr'), '7');
  assert.equal(arg('--fleet-retry-policy'), 'origin-owned');
  const brief = readFileSync(arg('--prompt'), 'utf8');
  assert.ok(brief.includes(f.refusal.missingEvidence.summary));
  assert.ok(brief.includes(JSON.stringify(f.refusal.missingEvidence, null, 2)));
  assert.ok(brief.includes(f.refusal.next));
  assert.match(brief, /Do not merge/);
  const ledger = readHammerRetryCapLedger(f.options.rootDir, f.options);
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.lifetimeAttemptCount, 1);
  // Re-observation and restart both read the durable receipt.
  await recoverAmaAutomation({ ...f.options });
  assert.equal(f.pages.length, 0);
  f.advance();
  assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
  await recoverAmaAutomation(f.options);
  assert.equal(f.commands.filter(call => call.command === 'hq').length, 1);
  assert.equal(f.pages.length, 1);
  assert.ok(f.pages[0][0].includes(f.refusal.key));
});

test('both snapshot projections carry exact refusal evidence to the R05 executor', async t => {
  const f = setup(t);
  const projected = closureOwnerShadowEvidence({ hammerStop: f.options.result.hammerStop,
    reviewState: {}, currentHead: HEAD }, { subjectKey: 'subject-07#7', candidate: { headSha: HEAD } });
  assert.deepEqual(projected.observations.controls.safetyRefusal.refusal, f.refusal);
  delete f.options.result.hammerStop;
  assert.equal((await recoverAmaAutomation(f.options)).recovery.action, 'scoped-repair');
});

for (const cause of ['dispatch-refused', 'throw', 'missing-next', 'budget', 'lifetime']) {
  test(`unavailable repair pages its refusal key without a second submission: ${cause}`, async t => {
    const f = setup(t);
    if (cause === 'missing-next') delete f.refusal.next;
    if (cause === 'dispatch-refused') f.options.dispatchRepairImpl = async () => ({ dispatched: false, reason: 'unavailable' });
    if (cause === 'throw') f.options.dispatchRepairImpl = async () => { throw new Error('synthetic submission interrupted'); };
    if (cause === 'budget' || cause === 'lifetime') {
      for (let i = 0; i < (cause === 'budget' ? 2 : 6); i++) recordHammerRetryDispatch(f.options.rootDir,
        f.options, { headSha: HEAD, jobKey: cause === 'lifetime' ? `review-${i}` : HEAD });
    }
    assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
    await recoverAmaAutomation(f.options);
    assert.equal(f.pages.length, 1);
    assert.ok(f.pages[0][0].includes(f.refusal.key));
    assert.equal(f.commands.filter(call => call.command === 'hq').length, 0);
  });
}

test('terminal repair, unknown receipt and page delivery failure retain the reservation', async t => {
  const f = setup(t);
  await recoverAmaAutomation(f.options);
  let pages = 0;
  f.options.pageImpl = async () => { if (++pages === 1) throw new Error('synthetic page outage'); };
  f.options.readRepairStatusImpl = async () => ({ ok: true, row: { status: 'failed' } });
  await recoverAmaAutomation(f.options);
  f.options.readRepairStatusImpl = async () => ({ ok: false });
  await recoverAmaAutomation(f.options);
  await recoverAmaAutomation(f.options);
  assert.equal(pages, 2);
  assert.equal(f.commands.filter(call => call.command === 'hq').length, 1);
});

for (const cause of ['hold', 'disabled', 'fleet', 'owned', 'uncertain', 'unknown-owner']) {
  test(`preflight deferral preserves budgets and resumes after release: ${cause}`, async t => {
    const f = setup(t);
    const original = { ...f.options.repairOptions };
    if (cause === 'disabled') f.options.repairOptions.cfg = { enabled: true, autonomousMergeExecutionEnabled: false };
    if (cause === 'fleet') f.options.repairOptions.fleetStopImpl = () => 'fleet-stop-active';
    if (cause === 'hold') f.options.repairOptions.execFileImpl = async () => ({ stdout: JSON.stringify({
      state: 'OPEN', headRefOid: HEAD, headRefName: 'fixture/repair', isDraft: false,
      labels: [{ name: 'no-merge-hold' }],
    }) });
    if (cause === 'owned' || cause === 'uncertain' || cause === 'unknown-owner') {
      f.options.repairOptions.probeOwnershipImpl = async () => cause === 'unknown-owner' ? null : { [cause]: true };
    }
    for (let tick = 0; tick < 3; tick++) {
      const deferred = await recoverAmaAutomation({ ...f.options });
      assert.equal(deferred.recovery.action, 'repair-deferred');
      assert.equal(deferred.recovery.attempts, 0);
      assert.equal(deferred.recovery.repairs[f.refusal.key], undefined);
      assert.equal(readHammerRetryCapLedger(f.options.rootDir, f.options), null);
      f.advance();
    }
    assert.equal(f.pages.length, 0);
    f.options.repairOptions = original;
    const resumed = await recoverAmaAutomation({ ...f.options });
    assert.equal(resumed.recovery.action, 'scoped-repair');
    assert.equal(resumed.recovery.attempts, 1);
    assert.equal(f.commands.filter(call => call.command === 'hq').length, 1);
    assert.equal(readHammerRetryCapLedger(f.options.rootDir, f.options).lifetimeAttemptCount, 1);
  });
}

for (const error of [
  Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('synthetic subprocess exit'), { stderr: 'net/http: TLS handshake timeout' }),
  Object.assign(new Error('synthetic timeout'), { killed: true, signal: 'SIGTERM' }),
  Object.assign(new Error('synthetic HTTP failure'), { stderr: 'HTTP 503 Service Unavailable' }),
]) {
  test(`transient GitHub preflight failure retries on the next poll without charging: ${error.stderr || error.code || error.signal}`, async t => {
    const f = setup(t);
    const transport = f.options.repairOptions.execFileImpl;
    let reads = 0;
    f.options.repairOptions.execFileImpl = async (...args) => {
      if (args[0] === 'gh' && ++reads === 1) throw error;
      return transport(...args);
    };
    const deferred = await recoverAmaAutomation(f.options);
    assert.equal(deferred.recovery.action, 'repair-deferred');
    assert.equal(deferred.recovery.attempts, 0);
    assert.equal(deferred.recovery.repairs[f.refusal.key], undefined);
    assert.equal(readHammerRetryCapLedger(f.options.rootDir, f.options), null);
    assert.equal(f.pages.length, 0);
    assert.equal((await recoverAmaAutomation({ ...f.options })).recovery.action, 'scoped-repair');
    assert.equal(reads, 2);
    assert.equal(f.commands.filter(call => call.command === 'hq').length, 1);
  });
}

test('permanent preflight errors and ambiguous HQ timeouts retain the one-shot reservation', async t => {
  for (const command of ['gh', 'hq']) {
    const f = setup(t);
    const transport = f.options.repairOptions.execFileImpl;
    let failures = 0;
    f.options.repairOptions.execFileImpl = async (...args) => {
      if (args[0] === command) {
        failures++;
        throw Object.assign(new Error(command === 'gh' ? 'HTTP 403 Forbidden' : 'TLS handshake timeout'),
          { code: command === 'gh' ? 1 : 'ETIMEDOUT' });
      }
      return transport(...args);
    };
    assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
    const repeated = await recoverAmaAutomation({ ...f.options });
    assert.equal(repeated.recovery.attempts, 1);
    assert.ok(repeated.recovery.repairs[f.refusal.key]);
    assert.equal(failures, 1);
    assert.equal(f.pages.length, 1);
  }
});

test('partial closure snapshots fall back to exact-head hammer refusal without crashing', async t => {
  for (const shared of [null, {}, { snapshot: {} }, { snapshot: { observations: {} } }]) {
    const f = setup(t);
    f.options.result = { ...f.options.result };
    if (shared) bindClosureNextAction(f.options.result, shared);
    assert.equal((await recoverAmaAutomation(f.options)).recovery.action, 'scoped-repair');
    assert.equal(f.pages.length, 0);
  }
});

test('missing closure observations without a recorded refusal exhaust safely', async t => {
  const f = setup(t);
  f.options.result = { nextAction: f.options.result.nextAction };
  bindClosureNextAction(f.options.result, {});
  assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
  assert.equal(f.commands.length, 0);
  assert.equal(f.pages.length, 1);
});

test('ordinary recovery tolerates a bound closure observation without a snapshot', async t => {
  const f = setup(t);
  f.options.result = { nextAction: { ...f.options.result.nextAction, reason: 'ordinary-retry' } };
  bindClosureNextAction(f.options.result, {});
  assert.equal((await recoverAmaAutomation(f.options)).outcome, 'ama-pending');
  assert.equal(f.pages.length, 0);
});

test('parallel wakes serialize; a new refusal uses remaining shared hammer budget', async t => {
  const f = setup(t);
  const results = await Promise.all([recoverAmaAutomation(f.options), recoverAmaAutomation(f.options)]);
  assert.ok(results.some(result => result.recovery.action === 'recovery-in-progress'));
  f.refusal.key = 'e'.repeat(64);
  await recoverAmaAutomation(f.options);
  assert.equal(f.commands.filter(call => call.command === 'hq').length, 2);
  f.refusal.key = 'd'.repeat(64);
  assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
  assert.equal(f.commands.filter(call => call.command === 'hq').length, 2);
});

test('recorded sibling refusal repairs retain exact multiline evidence and the same bound', async t => {
  const f = setup(t);
  f.options.result.hammerStop.predicate = 'base-changed-file-overlap';
  f.refusal.reasons = ['base-changed-file-overlap'];
  f.refusal.missingEvidence.summary += `\n${'synthetic protected-region evidence '.repeat(20)}`;
  f.refusal.next = 'Repair only the recorded region.\nPreserve the catalog contract.';
  const first = await recoverAmaAutomation(f.options);
  const path = first.recovery.repairs[f.refusal.key].promptPath;
  assert.ok(readFileSync(path, 'utf8').includes(f.refusal.missingEvidence.summary));
  assert.ok(readFileSync(path, 'utf8').includes(f.refusal.next));
  await recoverAmaAutomation(f.options);
  assert.equal(f.commands.filter(call => call.command === 'hq').length, 1);
});

test('cancellation retains the pre-submit reservation and cannot launch on restart', async t => {
  const f = setup(t);
  const error = Object.assign(new Error('synthetic cancellation'), { name: 'AbortError' });
  await assert.rejects(recoverAmaAutomation({ ...f.options, dispatchRepairImpl: async () => { throw error; } }),
    candidate => candidate === error);
  assert.equal((await recoverAmaAutomation(f.options)).outcome, 'recovery-exhausted');
  assert.equal(f.commands.length, 0);
  assert.equal(f.pages.length, 1);
});

test('live head changes, holds, disabled execution and fleet stops refuse PR update submission', async t => {
  for (const change of ['head', 'hold', 'disabled', 'fleet']) {
    const f = setup(t);
    const options = { ...f.options.repairOptions, ...f.options, refusal: f.refusal,
      dispatchKey: `fixture-${change}` };
    if (change === 'disabled') options.cfg = { enabled: false };
    if (change === 'fleet') options.fleetStopImpl = () => 'fleet-stop-active';
    if (change === 'head' || change === 'hold') options.execFileImpl = async () => ({ stdout: JSON.stringify({
      state: 'OPEN', headRefOid: change === 'head' ? 'b'.repeat(40) : HEAD,
      headRefName: 'fixture/repair', isDraft: false, labels: change === 'hold' ? [{ name: 'no-merge-hold' }] : [],
    }) });
    assert.equal((await dispatchSafetyStopRepair(options)).dispatched, false);
    assert.equal(readHammerRetryCapLedger(options.rootDir, options), null);
  }
});
