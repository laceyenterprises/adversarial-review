import './helpers/rate-limit-state-isolation.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchCapRehead, capReheadLedgerPath, probeCapReheadOwnership, capReheadCounters, resetCapReheadCountersForTesting } from '../src/ama/cap-rehead.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { operatorNoticeInFlight } from '../src/ama/operator-notice-route.mjs';
import { hammerOwnerRouteFinalOutcome } from '../src/ama/review-cycle-cap-route.mjs';
import { resolveMergeAuthorityConfigFromDomain } from '../src/domain-policy.mjs';

beforeEach(resetCapReheadCountersForTesting);

function fixture(t, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-rehead-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [], events = [];
  const args = { rootDir, repo: 'example/project', prNumber: 17, headSha: 'a'.repeat(40),
    branch: 'feature/synthetic', title: '[codex] Synthetic change',
    wake: { outcome: 'skipped', reason: 'retry-exhausted' },
    reviewState: { verdict: 'comment-only', blockingFindingState: 'known', blockingFindingCount: 0, reviewCycleExhausted: false },
    requiredChecks: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    requiredCheckContexts: ['tests'], mergeable: 'MERGEABLE', env: {},
    classifyUpdateModeImpl: async input => { assert.equal(input.rootDir, rootDir); return 'merge-main'; },
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    readLaunchImpl: async () => ({ ok: true, row: { status: 'succeeded' } }),
    logger: { info: line => events.push(JSON.parse(line)) },
    execFileImpl: async (bin, argv) => {
      const ledger = JSON.parse(readFileSync(capReheadLedgerPath(rootDir, 'example/project', 17)));
      assert.equal(ledger.attempts.at(-1).status, 'reserved', 'reservation precedes dispatch');
      calls.push({ bin, argv });
      return { stdout: JSON.stringify({ launchRequestId: `synthetic-${calls.length}`, status: 'running' }) };
    }, ...overrides };
  args.readCurrentPrImpl ||= async () => ({ state: 'OPEN', headSha: args.headSha, isDraft: false,
    statusCheckRollup: args.requiredChecks, mergeable: args.mergeable, labels: [] });
  return { args, calls, events, run: (changes = {}) => maybeDispatchCapRehead({ ...args, ...changes,
    readCurrentPrImpl: changes.readCurrentPrImpl || overrides.readCurrentPrImpl || (async () => ({ ...(await args.readCurrentPrImpl()), headSha: changes.headSha || args.headSha })) }) };
}

test('capped clean green head reserves once, emits metrics, and uses a builder PR-update', async t => {
  const f = fixture(t);
  assert.deepEqual(capReheadCounters(), { dispatched: 0, skipped: 0 });
  assert.equal((await f.run()).dispatched, true);
  assert.equal((await f.run()).reason, 'already-attempted');
  assert.equal(f.calls.length, 1);
  const argv = f.calls[0].argv;
  assert.equal(argv[argv.indexOf('--worker-class') + 1], 'codex');
  assert.equal(argv[argv.indexOf('--task-kind') + 1], 'coding');
  assert.equal(argv[argv.indexOf('--fleet-retry-policy') + 1], 'origin-owned');
  assert.equal(argv[argv.indexOf('--pr') + 1], '17');
  assert.equal(argv[argv.indexOf('--repo') + 1], 'project');
  const prompt = readFileSync(argv[argv.indexOf('--prompt') + 1], 'utf8');
  assert.match(prompt, /git merge --no-ff origin\/main/);
  assert.match(prompt, /Never rebase/);
  assert.match(prompt, /fast-forward/);
  assert.match(prompt, /git merge --squash/);
  assert.match(prompt, /--force-with-lease=/);
  assert.match(prompt, /\"updateMode\":\"merge-main\"/);
  assert.match(prompt, /\"repo\":\"example\/project\"/);
  assert.match(prompt, /no helper checkout/);
  assert.match(prompt, /no hammer or closer trailers/i);
  assert.equal(f.events[0].event, 'ama.cap_rehead.dispatched');
  assert.equal(f.events[1].event, 'ama.cap_rehead.skipped');
  assert.deepEqual(capReheadCounters(), { dispatched: 1, skipped: 1 });
});

test('counter reset clears both metrics without changing returned snapshots', async t => {
  const f = fixture(t);
  await f.run();
  await f.run();
  const snapshot = capReheadCounters();
  resetCapReheadCountersForTesting();
  assert.deepEqual(capReheadCounters(), { dispatched: 0, skipped: 0 });
  assert.deepEqual(snapshot, { dispatched: 1, skipped: 1 });
  assert.equal((await f.run()).reason, 'already-attempted', 'metrics reset preserves durable reservations');
});

for (const [reason, changes] of [
  ['cycle-exhausted', { reviewState: { reviewCycleExhausted: true } }],
  ['blocking-findings', { reviewState: { verdict: 'request-changes', reviewCycleExhausted: false } }],
  ['blocking-findings', { reviewState: { verdict: 'comment-only', blockingFindingState: 'unknown', reviewCycleExhausted: false } }],
  ['checks-red', { requiredChecks: [] }],
  ['checks-red', { requiredCheckContexts: ['missing'] }],
  ['checks-red', { mergeable: 'CONFLICTING', requiredChecks: [{ name: 'tests', conclusion: 'FAILURE' }] }],
  ['checks-red', { requiredChecks: [{ name: 'tests', status: 'IN_PROGRESS' }] }],
  ['live-owner', { probeOwnershipImpl: async () => ({ owned: true }) }],
  ['live-owner', { probeOwnershipImpl: async () => ({ owned: false, uncertain: true }) }],
  ['lifetime-cap', { lifetimeExhausted: true }],
  ['lifetime-cap', { cfg: { capReheadLifetimeCap: 0 } }],
  ['disabled', { cfg: { capReheadEnabled: false } }],
  ['builder-unavailable', { title: 'Unknown', defaultBuilder: 'hammer' }],
]) test(`skips ${reason}: ${JSON.stringify(changes)}`, async t => {
  const f = fixture(t, changes);
  const result = await f.run();
  assert.equal(result?.reason ?? (result === null ? 'disabled' : undefined), reason);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events[0].reason, reason);
});

test('comment-only conflicting head uses author class, with configured fallback for untagged titles', async t => {
  const f = fixture(t, { title: '[claude-code] Synthetic', mergeable: 'CONFLICTING' });
  f.args.reviewState.verdict = 'comment-only';
  assert.equal((await f.run()).workerClass, 'claude-code');
  assert.ok(f.calls[0].argv.includes('--allow-conflicted-base'));
  assert.equal((await f.run({ headSha: 'b'.repeat(40), title: 'Synthetic', defaultBuilder: 'gemini' })).workerClass, 'gemini');
});

test('lifetime cap holds across heads and fresh process reads', async t => {
  const f = fixture(t);
  assert.equal((await f.run()).dispatched, true);
  assert.equal((await f.run({ headSha: 'b'.repeat(40) })).dispatched, true);
  assert.equal((await maybeDispatchCapRehead({ ...f.args, headSha: 'c'.repeat(40) })).reason, 'lifetime-cap');
  assert.equal(f.calls.length, 2);
});

for (const [storedRepo, callerRepo] of [
  ['example/project', 'Example/Project'],
  ['Example/Project', 'example/project'],
]) test(`repository casing preserves reservations and lifetime cap: ${storedRepo} -> ${callerRepo}`, async t => {
  const f = fixture(t, { repo: storedRepo });
  assert.equal(capReheadLedgerPath(f.args.rootDir, storedRepo, 17),
    capReheadLedgerPath(f.args.rootDir, callerRepo, 17));
  assert.equal((await f.run()).dispatched, true);
  assert.equal((await f.run({ repo: callerRepo })).reason, 'already-attempted');
  assert.equal((await f.run({ repo: callerRepo, headSha: 'b'.repeat(40) })).dispatched, true);
  assert.equal((await f.run({ repo: storedRepo, headSha: 'c'.repeat(40) })).reason, 'lifetime-cap');
  assert.equal(f.calls.length, 2);
});

test('refused dispatch is durably charged, never retried, and unknown receipt retains custody across heads', async t => {
  const f = fixture(t);
  f.args.execFileImpl = async () => { f.calls.push('refused'); throw new Error('synthetic refusal'); };
  assert.equal((await f.run()).reason, 'dispatch-refused');
  assert.equal((await f.run()).reason, 'live-owner');
  assert.equal((await f.run({ headSha: 'b'.repeat(40) })).reason, 'live-owner');
  assert.equal(f.calls.length, 1);
  const ledger = JSON.parse(readFileSync(capReheadLedgerPath(f.args.rootDir, f.args.repo, 17)));
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].status, 'unacknowledged');
});

test('simultaneous ticks cannot reserve or dispatch twice', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(r => r.dispatched).length, 1);
  assert.equal(f.calls.length, 1);
});

test('live previous CAPREHEAD launch or retry blocks a different head', async t => {
  const f = fixture(t);
  await f.run();
  assert.equal((await f.run({ headSha: 'b'.repeat(40),
    readLaunchImpl: async () => ({ ok: true, row: { status: 'succeeded' }, retryChain: [{ status: 'running' }] }) })).reason, 'live-owner');
});

test('ownership includes independent builders/PR updates, parked retries, and incomplete inventory', async () => {
  const args = { repo: 'example/project', branch: 'feature/synthetic' };
  const seams = { probeImpl: async () => ({ owned: false, uncertain: false }),
    readWorkspacesImpl: async () => ({ ok: true, rows: [{ present: true, manifest_state: 'available',
      repo: 'project', branch: args.branch, launch_request_id: 'synthetic-owner' }] }),
    readLaunchImpl: async () => ({ ok: true, row: { status: 'running' } }) };
  assert.equal((await probeCapReheadOwnership(args, seams)).owned, true);
  assert.equal((await probeCapReheadOwnership(args, { ...seams,
    readLaunchImpl: async () => ({ ok: true, row: { status: 'succeeded' } }) })).owned, false);
  assert.equal((await probeCapReheadOwnership(args, { ...seams,
    readWorkspacesImpl: async () => ({ ok: false }) })).uncertain, true);
  assert.equal((await probeCapReheadOwnership(args, { ...seams,
    readWorkspacesImpl: async () => ({ ok: true, rows: [{ present: true }] }) })).uncertain, true);
});

test('fresh fork defaults and domain/env overrides use existing config surface', t => {
  const f = fixture(t), topPath = join(f.args.rootDir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n');
  let cfg = loadConfig({ topPath, env: {} }).getMergeAuthorityConfig();
  assert.equal(cfg.capReheadEnabled, true);
  assert.equal(cfg.capReheadLifetimeCap, 2);
  cfg = loadConfig({ topPath, env: {
    AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_CAP_REHEAD_ENABLED: 'false',
    AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_CAP_REHEAD_LIFETIME_CAP: '1',
  } }).getMergeAuthorityConfig();
  assert.equal(cfg.capReheadEnabled, false);
  assert.equal(cfg.capReheadLifetimeCap, 1);
  assert.equal(resolveMergeAuthorityConfigFromDomain({ mergeAuthority: { capReheadLifetimeCap: 3 } }, {}).capReheadLifetimeCap, 3);
});

for (const [reason, live] of [
  ['head-changed', { state: 'OPEN', headSha: 'moved', isDraft: false, labels: [] }],
  ['operator-hold', { state: 'OPEN', headSha: 'a'.repeat(40), isDraft: false, labels: ['no-merge-hold'] }],
  ['preflight-unavailable', null],
]) test(`fresh preflight refuses ${reason}`, async t => {
  const f = fixture(t, { readCurrentPrImpl: async () => live });
  const result = await f.run();
  assert.equal(result?.reason ?? (result === null ? 'disabled' : undefined), reason);
  assert.equal(f.calls.length, 0);
});

test('configured corporate builder remains a builder and terminal refused receipts spend the attempt', async t => {
  const f = fixture(t, { title: 'Synthetic', defaultBuilder: 'codex-corp' });
  assert.equal((await f.run()).workerClass, 'codex-corp');
  const refused = fixture(t, { execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-refusal', status: 'failed' }) }) });
  assert.equal((await refused.run()).reason, 'dispatch-refused');
  assert.equal((await refused.run()).reason, 'already-attempted');
  assert.equal(JSON.parse(readFileSync(capReheadLedgerPath(refused.args.rootDir, refused.args.repo, 17)))
    .attempts[0].launchRequestId, 'synthetic-refusal');
  // A known refusal still spends its attempt, but terminal custody evidence
  // allows the remaining budget on a different head.
  assert.equal((await refused.run({ headSha: 'b'.repeat(40) })).reason, 'dispatch-refused');
  assert.equal((await refused.run({ headSha: 'c'.repeat(40) })).reason, 'lifetime-cap');
});

test('unreadable and malformed reservation stores never become a fresh budget', async t => {
  const f = fixture(t);
  await f.run();
  const file = capReheadLedgerPath(f.args.rootDir, f.args.repo, 17);
  for (const content of ['{', JSON.stringify({ schemaVersion: 1, repo: f.args.repo, prNumber: 17,
    attempts: [{ headSha: 'old', status: 'invented' }] })]) {
    writeFileSync(file, content);
    assert.equal((await f.run({ headSha: 'b'.repeat(40) })).reason, 'ledger-unreadable');
  }
  assert.equal(f.calls.length, 1);
});

test('invalid or foreign repository metadata fails closed without dispatching', async t => {
  const f = fixture(t);
  await f.run();
  const file = capReheadLedgerPath(f.args.rootDir, f.args.repo, 17);
  const ledger = JSON.parse(readFileSync(file));
  for (const repo of [null, 17, {}, ['example/project'], undefined, 'example/other']) {
    writeFileSync(file, JSON.stringify({ ...ledger, repo }));
    assert.equal((await f.run({ headSha: 'b'.repeat(40) })).reason, 'ledger-unreadable');
  }
  assert.equal(f.calls.length, 1);
});

test('unknown base ownership and provisioning workspaces retain custody', async () => {
  const args = { repo: 'example/project', branch: 'feature/synthetic' };
  const seams = { probeImpl: async () => ({}),
    readWorkspacesImpl: async () => ({ ok: true, rows: [] }) };
  assert.equal((await probeCapReheadOwnership(args, seams)).owned, true);
  assert.equal((await probeCapReheadOwnership(args, { ...seams,
    probeImpl: async () => ({ owned: false, uncertain: false }),
    readWorkspacesImpl: async () => ({ ok: true, rows: [{ present: false, repo: args.repo,
      branch: args.branch, manifest_state: 'available', launch_request_id: 'synthetic-provisioning' }] }),
    readLaunchImpl: async () => ({ ok: true, row: { status: 'requested' } }),
  })).owned, true);
});

test('unrelated and terminal inventory slots do not strand a PR behind obsolete manifests', async () => {
  const args = { repo: 'example/project', branch: 'feature/synthetic' };
  const seams = { probeImpl: async () => ({ owned: false, uncertain: false }),
    readWorkspacesImpl: async () => ({ ok: true, rows: [
      { present: true, repo: 'example/other' },
      { present: true, branch: 'different/branch' },
      { present: true, manifest_state: 'missing', launch_request_id: 'synthetic-terminal' },
    ] }),
    readLaunchImpl: async () => ({ ok: true, row: { status: 'succeeded' } }) };
  assert.deepEqual(await probeCapReheadOwnership(args, seams), { owned: false, uncertain: false });
  assert.equal((await probeCapReheadOwnership(args, { ...seams,
    readLaunchImpl: async () => ({ ok: false }),
  })).uncertain, true);
});

test('offline callers cannot reach the real dispatch transport', async t => {
  const f = fixture(t);
  assert.equal((await f.run({ execFileImpl: undefined })).reason, 'offline-transport-required');
  assert.equal(f.calls.length, 0);
});


for (const verdict of ['approved', 'comment-only']) test(`canonical settled verdict admits: ${verdict}`, async t => {
  const f = fixture(t); f.args.reviewState.verdict = verdict;
  assert.equal((await f.run()).dispatched, true);
});

test('daemon binds squash mode and exact source context without a worker helper', async t => {
  const f = fixture(t, { classifyUpdateModeImpl: async input => {
    assert.equal(input.repo, 'example/project'); assert.equal(input.prNumber, 17);
    assert.equal(input.headSha, 'a'.repeat(40)); assert.ok(input.rootDir); return 'squash';
  } });
  assert.equal((await f.run()).dispatched, true);
  const prompt = readFileSync(f.calls[0].argv[f.calls[0].argv.indexOf('--prompt') + 1], 'utf8');
  assert.match(prompt, /"updateMode":"squash"/);
  const ledger = JSON.parse(readFileSync(capReheadLedgerPath(f.args.rootDir, f.args.repo, 17)));
  assert.equal(ledger.attempts[0].updateMode, 'squash');
});

test('unreadable history does not reserve or dispatch a maintenance attempt', async t => {
  const f = fixture(t, { classifyUpdateModeImpl: async () => { throw new Error('synthetic'); } });
  assert.equal((await f.run()).reason, 'history-unavailable'); assert.equal(f.calls.length, 0);
  assert.throws(() => readFileSync(capReheadLedgerPath(f.args.rootDir, f.args.repo, 17)), { code: 'ENOENT' });
});

test('dispatch uses the coexistence budget and preserves uncertain receipt custody', async t => {
  const f = fixture(t, { operationTimeoutMs: 37, execFileImpl: async (_bin, _argv, options) => {
    assert.equal(options.timeout, 37); throw new Error('synthetic transport timeout');
  } });
  assert.equal((await f.run()).reason, 'dispatch-refused');
  const ledger = JSON.parse(readFileSync(capReheadLedgerPath(f.args.rootDir, f.args.repo, 17)));
  assert.equal(ledger.attempts[0].status, 'unacknowledged');
});


for (const status of ['requested', 'running', 'suspended', 'succeeded', 'failed']) {
  test(`notification custody follows the canonical CAPREHEAD launch: ${status}`, async t => {
    const f = fixture(t); await f.run();
    const held = await operatorNoticeInFlight(f.args.rootDir, f.args, {
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status } }),
    });
    assert.equal(held, ['requested', 'running', 'suspended'].includes(status) ? 'cap-rehead-in-flight' : null);
  });
}

test('live CAPREHEAD custody prevents a duplicate attempt and retry-cap page projection', async t => {
  const f = fixture(t); await f.run();
  const live = await f.run({ readLaunchImpl: async () => ({ ok: true, row: { status: 'running' } }) });
  assert.equal(live.custody, true); assert.equal(f.calls.length, 1);
  const decision = { actor: 'closure-recovery', reason: 'retry-exhausted', queue: { intent: 'reconcile' } };
  assert.equal(hammerOwnerRouteFinalOutcome({ capRehead: live, nextAction: decision }), null);
  assert.equal(hammerOwnerRouteFinalOutcome({ capRehead: { dispatched: false, reason: 'lifetime-cap' }, nextAction: decision }), 'hammer-cap-exhausted');
});


test('a later cycle cap retains an already running CAPREHEAD owner', async t => {
  const f = fixture(t); await f.run();
  const live = await f.run({ reviewState: { reviewCycleExhausted: true },
    readLaunchImpl: async () => ({ ok: true, row: { status: 'running' } }) });
  assert.equal(live.custody, true); assert.equal(f.calls.length, 1);
});
