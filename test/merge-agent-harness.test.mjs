// CLOSERREUSE-01: the merge-agent fallback resolves its worker class through
// the AMA closer's grounding and fallback, and never dispatches a class whose
// harness is quota-grounded. This host pins roles.merge_agent_worker_class to
// `hammer` (codex); during the codex weekly cap every fallback hammer was
// refused as harness_unhealthy (agent-os#7348) or crashed (agent-os#7349).
//
// The dispatch tests run the real dispatchMergeAgentForPR and the real HHR
// resolver. Only `hq` is stubbed: `hq fleet quota status --json` and `hq dispatch`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchMergeAgentForPR } from '../src/follow-up-merge-agent.mjs';
import {
  MERGE_AGENT_HARNESS_DEFERRAL_EVENT,
  MERGE_AGENT_HARNESS_GROUNDED_REASON,
  mergeAgentHarnessDeferralFilePath,
  mergeAgentHarnessRecordFields,
  resolveMergeAgentDispatchHarness,
} from '../src/merge-agent-harness.mjs';

// This host's config: merge_agent_worker_class hammer, and the schema's
// merge-authority fallback `[hammer-claude]` (config.local.yaml pins the same).
const HAMMER_ENV = {
  AGENT_OS_CONFIG_PATH: '/dev/null',
  ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS: 'hammer',
};

// `hq fleet quota status --json`, shaped like cwp_dispatch/cli_fleet.py's output.
function fleetQuotaStdout(states) {
  return JSON.stringify({
    providerStatuses: Object.entries(states).map(([provider, state]) => ({
      provider,
      authPath: 'oauth',
      state,
      lastProbeAt: '2026-09-29T12:00:00Z',
      lastGoodAt: '2026-09-27T12:52:00Z',
    })),
    lastProbeAt: '2026-09-29T12:00:00Z',
  });
}

function hqStub(fleetStdout) {
  const calls = [];
  const impl = async (cmd, args) => {
    calls.push([...args]);
    if (args[0] === 'fleet' && args[1] === 'quota') {
      if (fleetStdout instanceof Error) throw fleetStdout;
      return { stdout: fleetStdout, stderr: '' };
    }
    if (args[0] === 'dispatch') {
      return { stdout: '{"dispatchId":"disp_fallback","lrq":"lrq_fallback"}\n', stderr: '' };
    }
    throw new Error(`unexpected hq call: ${args.join(' ')}`);
  };
  return { impl, calls };
}

function dispatchedWorkerClass(calls) {
  const dispatch = calls.find((args) => args[0] === 'dispatch');
  if (!dispatch) return null;
  return dispatch[dispatch.indexOf('--worker-class') + 1];
}

// agent-os#7348 at 12:04Z: comment-only, mergeable, green, remediation budget spent.
async function dispatchFallback(t, hq, env = HAMMER_ENV) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-merge-agent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const warnings = [];
  const result = await dispatchMergeAgentForPR({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 7348,
    branch: 'claude-code-sewstreak-01/SEWSTREAK-01',
    baseBranch: 'main',
    headSha: 'a21e8ed3c8080a03ca734cdcc422be7dfb1a3f5c',
    lastVerdict: 'Comment only',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 1,
    remediationMaxRounds: 1,
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    env,
    hqPath: '/bin/hq-test',
    execFileImpl: hq.impl,
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    agentOsDetectImpl: () => ({ present: true, source: 'test' }),
    prepareOriginalWorkerImpl: async () => ({ decision: 'ready', reason: 'no-derived-worker-id' }),
    now: '2026-09-29T12:04:22.000Z',
    logger: { log() {}, info() {}, warn: (line) => warnings.push(String(line)), error() {} },
  });
  return { result, warnings };
}

test('while openai/oauth is grounded, the merge-agent fallback dispatches hammer as hammer-claude', async (t) => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'ok' }));
  const { result, warnings } = await dispatchFallback(t, hq);

  assert.equal(result.decision, 'dispatch', JSON.stringify(result));
  assert.equal(result.launchRequestId, 'lrq_fallback');
  assert.equal(dispatchedWorkerClass(hq.calls), 'hammer-claude');
  assert.ok(warnings.some((line) => line.includes('harness fallback: hammer -> hammer-claude')), warnings.join('\n'));
});

test('once openai recovers, the merge-agent fallback returns to hammer', async (t) => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'ok', anthropic: 'ok' }));
  const { result } = await dispatchFallback(t, hq);

  assert.equal(result.decision, 'dispatch', JSON.stringify(result));
  assert.equal(dispatchedWorkerClass(hq.calls), 'hammer');
});

test('with every harness grounded, the merge-agent defers instead of dispatching a grounded class', async (t) => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'suspended' }));
  const { result } = await dispatchFallback(t, hq);

  assert.equal(result.decision, 'dispatch-deferred', JSON.stringify(result));
  assert.equal(result.reason, MERGE_AGENT_HARNESS_GROUNDED_REASON);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(dispatchedWorkerClass(hq.calls), null, 'no hq dispatch');
});

test('an unreadable quota status is not grounding: the configured class dispatches, as on the closer', async (t) => {
  const hq = hqStub(new Error('hq: fleet quota status timed out'));
  const { result } = await dispatchFallback(t, hq);

  assert.equal(result.decision, 'dispatch', JSON.stringify(result));
  assert.equal(dispatchedWorkerClass(hq.calls), 'hammer');
});

test('the default merge-agent class has no quota provider and never reads fleet quota', async (t) => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'exhausted' }));
  const { result } = await dispatchFallback(t, hq, { AGENT_OS_CONFIG_PATH: '/dev/null' });

  assert.equal(result.decision, 'dispatch', JSON.stringify(result));
  assert.equal(dispatchedWorkerClass(hq.calls), 'merge-agent');
  assert.equal(hq.calls.some((args) => args[0] === 'fleet'), false);
});

test('a grounded class with no fallback configured is still probed, and defers', async () => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'ok' }));
  const harness = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: [],
    hqPath: '/bin/hq-test',
    execFileImpl: hq.impl,
    logger: { warn() {} },
  });
  assert.equal(harness.deferred, true);
  assert.equal(harness.reason, MERGE_AGENT_HARNESS_GROUNDED_REASON);
  assert.equal(harness.provider, 'openai');
  assert.equal(harness.primaryState, 'exhausted');

  const healthy = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: [],
    hqPath: '/bin/hq-test',
    execFileImpl: hqStub(fleetQuotaStdout({ openai: 'ok' })).impl,
    logger: { warn() {} },
  });
  assert.equal(healthy.deferred, false);
  assert.equal(healthy.workerClass, 'hammer');
});

test('a resolver fault fails open to the configured class', async () => {
  const harness = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    resolveHarnessImpl: async () => {
      throw new Error('boom');
    },
    logger: { warn() {} },
  });
  assert.equal(harness.deferred, false);
  assert.equal(harness.workerClass, 'hammer');
  assert.equal(harness.reason, 'harness-fallback-resolver-error');
});

test('fallback candidates are screened on soft grounding too: a soft-grounded hammer-claude defers', async () => {
  const seen = [];
  const harness = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    resolveHarnessImpl: async (args) => {
      seen.push(args);
      return { workerClass: 'hammer', fellBack: false, reason: 'all-fallbacks-grounded', groundedBy: 'hard', provider: 'openai' };
    },
    logger: { warn() {} },
  });
  assert.equal(seen[0].screenSoftGroundedFallbacks, true);
  assert.equal(seen[0].probeWithoutFallbacks, true);
  assert.equal(harness.deferred, true);
  assert.equal(harness.harnessReason, 'all-fallbacks-grounded');

  // End to end through the real resolver: openai hard-exhausted, anthropic soft-grounded.
  const hq = hqStub(JSON.stringify({
    providerStatuses: [
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
      {
        provider: 'anthropic',
        authPath: 'oauth',
        state: 'ok',
        afhGrounding: { grounded: true, signals: 4, threshold: 3, reason: 'sustained_provider_quota_exhausted_kills' },
      },
    ],
  }));
  const real = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    hqPath: '/bin/hq-test',
    execFileImpl: hq.impl,
    logger: { warn() {} },
  });
  assert.equal(real.deferred, true);
  assert.equal(real.workerClass, 'hammer');
});

test('a grounded deferral is recorded durably, counted, and escalates once after 30 minutes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'closerreuse-deferral-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const job = { repo: 'laceyenterprises/agent-os', prNumber: 7348, headSha: 'a21e8ed3c8080a03ca734cdcc422be7dfb1a3f5c' };
  const filePath = mergeAgentHarnessDeferralFilePath(dir, job);
  const warnings = [];
  const logger = { warn: (line) => warnings.push(String(line)) };
  const grounded = hqStub(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'suspended' }));
  const resolveAt = (now, hq = grounded) => resolveMergeAgentDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    hqPath: '/bin/hq-test',
    execFileImpl: hq.impl,
    logger,
    deferral: { dir, job, now },
  });

  const first = await resolveAt('2026-09-29T12:00:00.000Z');
  assert.equal(first.deferred, true);
  assert.equal(first.deferralRecord.deferralCount, 1);
  assert.equal(first.deferralRecord.firstDeferredAt, '2026-09-29T12:00:00.000Z');
  assert.equal(first.deferralRecord.escalatedAt, null);
  assert.equal(first.deferralRecord.provider, 'openai');

  await resolveAt('2026-09-29T12:10:00.000Z');
  assert.equal(warnings.some((line) => line.includes(MERGE_AGENT_HARNESS_DEFERRAL_EVENT)), false);

  const late = await resolveAt('2026-09-29T12:31:00.000Z');
  assert.equal(late.deferralRecord.deferralCount, 3);
  assert.equal(late.deferralRecord.firstDeferredAt, '2026-09-29T12:00:00.000Z');
  assert.equal(late.deferralRecord.escalatedAt, '2026-09-29T12:31:00.000Z');
  const events = warnings.filter((line) => line.includes(MERGE_AGENT_HARNESS_DEFERRAL_EVENT));
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]);
  assert.equal(event.prNumber, 7348);
  assert.equal(event.ageMinutes, 31);
  assert.equal(event.deferralCount, 3);

  await resolveAt('2026-09-29T12:45:00.000Z');
  assert.equal(warnings.filter((line) => line.includes(MERGE_AGENT_HARNESS_DEFERRAL_EVENT)).length, 1, 'escalated once');
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).deferralCount, 4);

  // Recovery: the next resolution dispatches and clears the record.
  const recovered = await resolveAt('2026-09-29T13:00:00.000Z', hqStub(fleetQuotaStdout({ openai: 'ok' })));
  assert.equal(recovered.deferred, false);
  assert.equal(recovered.deferralRecord, undefined);
  assert.equal(existsSync(filePath), false);
});

test('a dispatch-deferred merge-agent tick writes the deferral record under data/follow-up-jobs', async (t) => {
  const hq = hqStub(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'suspended' }));
  const { result } = await dispatchFallback(t, hq);
  assert.equal(result.decision, 'dispatch-deferred');
  assert.equal(result.harness.deferralRecord.deferralCount, 1);
  assert.equal(result.harness.deferralRecord.prNumber, 7348);
});

test('the dispatch record fields name the class that actually ran and why', () => {
  assert.deepEqual(mergeAgentHarnessRecordFields(null), { dispatchWorkerClass: null, harness: null });
  assert.deepEqual(mergeAgentHarnessRecordFields({
    workerClass: 'hammer-claude',
    fellBack: true,
    from: 'hammer',
    to: 'hammer-claude',
    provider: 'openai',
    groundedBy: 'hard',
    reason: 'primary-grounded',
    deferred: false,
  }), {
    dispatchWorkerClass: 'hammer-claude',
    harness: {
      fellBack: true,
      from: 'hammer',
      to: 'hammer-claude',
      provider: 'openai',
      groundedBy: 'hard',
      reason: 'primary-grounded',
    },
  });
});
