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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchMergeAgentForPR } from '../src/follow-up-merge-agent.mjs';
import {
  MERGE_AGENT_HARNESS_GROUNDED_REASON,
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
