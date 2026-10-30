import './helpers/registry-session-fixture.mjs';
// REMEDIATORLANE-01: remediation lane selection never returns a lane the
// active orchestration mode cannot run. Native mode ('local') cannot bind the
// corporate Claude account, so that lane falls through to the next runnable
// lane, and with none left the job holds with a named reason instead of being
// claimed and failed as a worker failure. OS mode is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';
import {
  remediationLaneModeRefusal,
  remediatorFallbackAudit,
  resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback,
} from '../src/remediation-worker-class-fallback.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';

const quiet = { info() {}, warn() {}, log() {}, error() {} };
const execFor = snapshot => async () => ({ stdout: JSON.stringify(snapshot) });
const CORPORATE_REFUSAL = Object.freeze({ workerClass: 'remediator-claude-corp', mode: 'local',
  reason: 'requires-account-bound-hq-dispatch' });
const resolve = (snapshot, options = {}) => resolveRemediationWorkerClassWithFallback({
  codexAccountPolicy: 'pinned', env: {}, execFileImpl: snapshot ? execFor(snapshot) : null, ...options });

test('the capability check refuses only the account-bound lane, and only outside OS mode', () => {
  assert.equal(remediationLaneModeRefusal('remediator-claude-corp', 'local'), 'requires-account-bound-hq-dispatch');
  assert.equal(remediationLaneModeRefusal('remediator-claude-corp', 'os'), null);
  assert.equal(remediationLaneModeRefusal('remediator-claude-corp', null), null);
  for (const workerClass of ['codex', 'remediator-codex', 'remediator-codex-corp', 'claude-code', 'remediator-claude', 'gemini']) {
    assert.equal(remediationLaneModeRefusal(workerClass, 'local'), null, workerClass);
  }
});

test('native mode: a projection that selects the corporate Claude lane runs the personal lane, with the audit field', async () => {
  const snapshot = claudeAccountFixture();
  const native = await resolve(snapshot, { primary: 'remediator-claude', remediationMode: 'local' });
  assert.equal(native.workerClass, 'remediator-claude');
  assert.equal(native.hold, false);
  assert.deepEqual(native.modeRefusals, [CORPORATE_REFUSAL]);
  assert.deepEqual(remediatorFallbackAudit(native).modeRefusals, [CORPORATE_REFUSAL]);

  // Unknown corporate evidence holds in OS mode; native mode never runs that
  // lane, so its evidence cannot hold the job.
  const unknown = await resolve(claudeAccountFixture({ corp: 'unknown' }),
    { primary: 'remediator-claude', remediationMode: 'local' });
  assert.equal(unknown.workerClass, 'remediator-claude');
  assert.equal(unknown.hold, false);
  assert.deepEqual(unknown.modeRefusals, [CORPORATE_REFUSAL]);
});

test('OS mode, and callers that name no mode, keep selecting the corporate Claude lane exactly as before', async () => {
  for (const remediationMode of ['os', null]) {
    const routed = await resolve(claudeAccountFixture(), { primary: 'remediator-claude', remediationMode });
    assert.equal(routed.workerClass, 'remediator-claude-corp');
    assert.equal(routed.hold, false);
    assert.equal(routed.modeRefusals, undefined);
    assert.equal(remediatorFallbackAudit(routed).modeRefusals, undefined);
    const unknown = await resolve(claudeAccountFixture({ corp: 'unknown' }), { primary: 'remediator-claude', remediationMode });
    assert.equal(unknown.hold, true);
    assert.equal(unknown.reason, 'claude-account-evidence-unknown');
  }
});

test('native mode with no runnable lane holds with the named reason', async () => {
  // Corporate Claude has headroom, personal Claude and Codex are exhausted.
  const snapshot = claudeAccountFixture({ primary: 'exhausted' });
  const held = await resolve(snapshot, { primary: 'remediator-claude', fallbackWorkerClasses: ['codex'],
    remediationMode: 'local' });
  assert.equal(held.hold, true);
  assert.equal(held.reason, 'remediation-lane-unrunnable-in-mode');
  assert.ok(Date.parse(held.holdUntil) > Date.now());
  assert.deepEqual(held.modeRefusals, [CORPORATE_REFUSAL]);
  assert.ok(held.skipped.some(entry => entry.workerClass === 'codex'), JSON.stringify(held.skipped));
  assert.equal((await resolve(snapshot, { primary: 'remediator-claude', fallbackWorkerClasses: ['codex'],
    remediationMode: 'os' })).workerClass, 'remediator-claude-corp');

  // A pinned corporate primary is refused even without fleet evidence.
  const pinned = await resolve(null, { primary: 'remediator-claude-corp', fallbackWorkerClasses: [], remediationMode: 'local' });
  assert.equal(pinned.hold, true);
  assert.equal(pinned.reason, 'remediation-lane-unrunnable-in-mode');
  assert.equal(pinned.capSource, 'remediation-lane-unrunnable-in-mode');
  assert.deepEqual(pinned.modeRefusals, [CORPORATE_REFUSAL]);
  const pinnedOs = await resolve(null, { primary: 'remediator-claude-corp', fallbackWorkerClasses: [], remediationMode: 'os' });
  assert.equal(pinnedOs.reason, 'fleet-quota-status-unavailable');
});

test('native mode: a Codex-capped fallback never lands on the corporate Claude lane', async () => {
  const fallback = (options, remediationMode) => resolve(claudeAccountFixture(options), { primary: 'codex',
    fallbackWorkerClasses: ['remediator-claude', 'remediator-claude-corp'], reviewerModels: ['codex'], remediationMode });
  const os = await fallback({}, 'os');
  assert.equal(os.workerClass, 'remediator-claude-corp');
  assert.equal(os.fellBack, true);

  const native = await fallback({}, 'local');
  assert.equal(native.workerClass, 'remediator-claude');
  assert.equal(native.fellBack, true);
  assert.equal(native.from, 'codex');
  assert.deepEqual(native.modeRefusals, [CORPORATE_REFUSAL]);
  assert.deepEqual(remediatorFallbackAudit(native).modeRefusals, [CORPORATE_REFUSAL]);

  const held = await fallback({ primary: 'exhausted' }, 'local');
  assert.equal(held.hold, true);
  assert.equal(held.workerClass, 'codex');
  assert.equal(held.reason, 'remediation-lane-unrunnable-in-mode');
  assert.deepEqual(held.modeRefusals, [CORPORATE_REFUSAL]);
});

test('claim-time routing passes the mode through and logs the refused lane', async () => {
  const warnings = [];
  const routing = await resolveClaimedRemediatorRouting({ primary: 'remediator-claude',
    job: { builderTag: 'codex', reviewerModel: 'codex' }, env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    remediationMode: 'local', log: { ...quiet, warn: line => warnings.push(line) },
    resolveImpl: args => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl: execFor(claudeAccountFixture()) }) });
  assert.equal(routing.workerClass, 'remediator-claude');
  assert.ok(warnings.some(line => line.includes('remediator-claude-corp refused in local mode')), warnings.join('\n'));
});

function nativeConsumeFixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediatorlane-01-'));
  mkdirSync(join(rootDir, 'hq'));
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined, ADV_WITH_HQ_INTEGRATION: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', HQ_ROOT: join(rootDir, 'hq') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(overrides);
  t.after(() => { apply(previous); rmSync(rootDir, { recursive: true, force: true }); });
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/project', prNumber: 42,
    builderTag: 'codex', reviewerModel: 'codex', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-19T00:00:00Z' });
  return rootDir;
}

const consumeNative = (rootDir, resolveRemediationWorkerClassImpl) => consumeNextFollowUpJob({ rootDir,
  promptTemplate: 'Synthetic remediation prompt.', resolveRemediationWorkerClassImpl,
  guardStackedBaseImpl: async () => null, resolvePRLifecycleImpl: async () => null,
  execFileImpl: async (command, args) => {
    if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/pulls/42')) {
      return { stdout: JSON.stringify({ base: { ref: 'main' },
        head: { ref: 'synthetic-branch', repo: { full_name: 'sample/project' } } }) };
    }
    return { stdout: '' };
  },
  spawnImpl: () => assert.fail('no worker spawns in these scenarios'),
  postCommentImpl: async () => {}, deliverAlertImpl: async () => {}, log: quiet,
});

test('native consume with no runnable lane holds the job: no claim burned, no worker-failure', async t => {
  const rootDir = nativeConsumeFixture(t);
  const result = await consumeNative(rootDir, args => {
    assert.equal(args.remediationMode, 'local');
    return resolveRemediationWorkerClassWithFallback({ ...args,
      execFileImpl: execFor(claudeAccountFixture({ primary: 'exhausted' })) });
  });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'remediator-capped-hold');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 0);
  assert.equal(result.job.failureCode, undefined);
  const hold = result.job.remediationPlan.retryHistory.at(-1).retryMetadata;
  assert.equal(hold.fallbackReason, 'remediation-lane-unrunnable-in-mode');
  assert.equal(hold.noRespawn, true);
  assert.deepEqual(hold.modeRefusals, [CORPORATE_REFUSAL]);
});

test('the native-mode refusal stays as a backstop that names the lane and the mode', async t => {
  const rootDir = nativeConsumeFixture(t);
  // A selector defect that ignores the mode still never reaches a spawn.
  const error = await consumeNative(rootDir, async () => ({ workerClass: 'remediator-claude-corp',
    hold: false, fellBack: false, reason: 'synthetic-selector-defect' })).then(
    () => assert.fail('the backstop must refuse the corporate lane in native mode'), err => err);
  assert.match(error.message,
    /requires account-bound HQ dispatch \(selected lane remediator-claude-corp, mode local: requires-account-bound-hq-dispatch\)/);
  assert.match(error.followUpJobPath, /follow-up-jobs\/failed\//);
});
