import './helpers/rate-limit-state-isolation.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchCapRehead, capReheadLedgerPath, probeCapReheadOwnership, capReheadCounters } from '../src/ama/cap-rehead.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { resolveMergeAuthorityConfigFromDomain } from '../src/domain-policy.mjs';

function fixture(t, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-rehead-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [], events = [];
  const args = { rootDir, repo: 'example/project', prNumber: 17, headSha: 'a'.repeat(40),
    branch: 'feature/synthetic', title: '[codex] Synthetic change',
    wake: { outcome: 'skipped', reason: 'retry-exhausted' },
    reviewState: { verdict: 'clean', blockingFindingState: 'known', blockingFindingCount: 0, reviewCycleExhausted: false },
    requiredChecks: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    requiredCheckContexts: ['tests'], mergeable: 'MERGEABLE', env: {},
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
  const f = fixture(t), before = capReheadCounters();
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
  assert.match(prompt, /no hammer or closer trailers/i);
  assert.equal(f.events[0].event, 'ama.cap_rehead.dispatched');
  assert.equal(f.events[1].event, 'ama.cap_rehead.skipped');
  assert.equal(capReheadCounters().dispatched, before.dispatched + 1);
});

for (const [reason, changes] of [
  ['cycle-exhausted', { reviewState: { reviewCycleExhausted: true } }],
  ['blocking-findings', { reviewState: { verdict: 'request-changes', reviewCycleExhausted: false } }],
  ['blocking-findings', { reviewState: { verdict: 'clean', blockingFindingState: 'unknown', reviewCycleExhausted: false } }],
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
  assert.equal((await f.run()).reason, reason);
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

test('refused dispatch is durably charged, never retried, and unknown receipt retains custody across heads', async t => {
  const f = fixture(t);
  f.args.execFileImpl = async () => { f.calls.push('refused'); throw new Error('synthetic refusal'); };
  assert.equal((await f.run()).reason, 'dispatch-refused');
  assert.equal((await f.run()).reason, 'already-attempted');
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
  assert.equal((await f.run()).reason, reason);
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
