// REMFALLBACK-01 item 5 — replay of SEV3 agent-os#7327 through the real consume
// and reconcile paths.
//
// On 2026-09-29 the remediation for agent-os#7325 (a [claude-code] PR, reviewed
// by gemini while codex was capped) routed to codex, hit the gpt-6-sol weekly
// cap (reset 2026-10-04T12:52Z) and was held with
// `Held laceyenterprises/agent-os#7325 -> quota-exhausted (codex) until 02:45:15Z`.
// Each hour it would respawn codex, hit the cap and hold again until the shared
// retry budget parked it as `quota-exhausted-budget-exhausted`. Meanwhile
// `hq fleet quota status` was failing on the host (session-ledger schema error),
// and the provider row read openai `unknown` / `model_only_exhaustion`.
//
// The SEV's test list: a capped codex with a reset 5 days out spawns claude-code
// on the next claim; a short hold keeps codex; AFH grounding re-routes; no
// fallback means a hold with no respawn, never a terminal park while a fallback
// exists; and the `fallbackFrom` audit.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './helpers/role-config-cache-reset.mjs';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
  readFollowUpJob,
  requeueInProgressFollowUpJobForRetry,
} from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';
import { resetOAuthPreflightCache } from '../src/remediation-oauth-preflight.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 7325;
const WEEKLY_RESET = '2026-10-04T12:52:00.000Z';
const ISOLATED_ENV_KEYS = [
  'AGENT_OS_CONFIG_PATH',
  'AGENT_OS_ROLES_REMEDIATOR',
  'ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR',
  'AGENT_OS_ROLES_REMEDIATOR_FALLBACK',
  'ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK',
  'AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE',
  'ADV_WITH_HQ_INTEGRATION',
  'ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT',
  'ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES',
  'CLAUDE_CODE_CLI_PATH',
  'CODEX_AUTH_PATH',
  'CODEX_CLI_PATH',
  'CODEX_HOME',
  'HOME',
  'HQ_ROOT',
];

let rootDir;

beforeEach((context) => {
  resetOAuthPreflightCache();
  const previous = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-replay-'));
  const codexHome = path.join(rootDir, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
  }), 'utf8');
  Object.assign(process.env, {
    // Hermetic role config: the checked-in module config.yaml only.
    AGENT_OS_CONFIG_PATH: '/dev/null',
    ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'keychain',
    CLAUDE_CODE_CLI_PATH: '/usr/bin/true',
    CODEX_AUTH_PATH: path.join(codexHome, 'auth.json'),
    CODEX_CLI_PATH: '/usr/bin/true',
    CODEX_HOME: codexHome,
    HOME: rootDir,
    HQ_ROOT: path.join(rootDir, 'hq'),
  });
  mkdirSync(process.env.HQ_ROOT, { recursive: true });
  context.after(() => {
    resetOAuthPreflightCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

function createJob({ builderTag = 'claude-code', reviewerModel = 'gemini' } = {}) {
  return createFollowUpJob({
    rootDir,
    repo: REPO,
    prNumber: PR,
    reviewerModel,
    builderTag,
    linearTicketId: null,
    reviewBody: '## Summary\nDEPHYDRATE-01 hydrates dependencies in the wrong order.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-09-29T01:40:00.000Z',
    critical: true,
  });
}

// The job as the host held it at 01:45:15Z: a codex worker that hit the weekly
// cap, requeued by the reconcile quota hold (one retry spent, as on the host).
function heldOnCodexCap({ providerResetAt = WEEKLY_RESET, requeuedAt = '2026-09-29T01:45:15.389Z' } = {}) {
  createJob();
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T01:42:11.343Z' });
  return requeueInProgressFollowUpJobForRetry({
    rootDir,
    jobPath: claimed.jobPath,
    requeuedAt,
    retryReason: 'Provider usage cap hit (codex harness); holding remediation.',
    retryAfterOverride: providerResetAt,
    allowDirectWorkerRetry: true,
    remediationWorker: { model: 'codex', state: 'spawned', processId: 4242 },
    retryMetadata: {
      code: 'quota-exhausted',
      harness: 'codex',
      resetAt: providerResetAt,
      providerResetAt,
      source: 'provider-reported',
      maxUnvalidatedHoldMs: 3600000,
    },
  });
}

const OPENAI_MODEL_ONLY_EXHAUSTION = {
  provider: 'openai',
  authPath: 'oauth',
  state: 'unknown',
  lastErrorSignature: 'model_only_exhaustion',
  models: [{ model: 'gpt-6-sol', state: 'exhausted', resetAtUtc: WEEKLY_RESET }],
};

// The daemon's production resolver, with `hq fleet quota status` stubbed.
function daemonResolver(fleet) {
  const execFileImpl = fleet === 'unavailable'
    ? async () => {
      throw new Error('session-ledger runtime open failed: PostgresSchemaVersionError');
    }
    : async () => ({ stdout: JSON.stringify({ providerStatuses: fleet }) });
  return (args) => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl });
}

function workspaceExecFileImpl() {
  const calls = [];
  const impl = async (command, args = []) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'clone') {
      mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
    }
    if (command === 'gh' && args[0] === 'api' && /\/pulls\//.test(String(args[1]))) {
      return {
        stdout: JSON.stringify({
          base: { ref: 'main' },
          head: { ref: 'claude-code-dephydrate-01/DEPHYDRATE-01', repo: { full_name: REPO } },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  impl.calls = calls;
  return impl;
}

function recordingSpawn() {
  const spawned = [];
  const spawnImpl = (command, args) => {
    spawned.push({ command, args });
    return { pid: 5000 + spawned.length, detached: true, unref() {}, stdout: { destroy() {} }, stderr: { destroy() {} } };
  };
  spawnImpl.spawned = spawned;
  return spawnImpl;
}

function refusingSpawn() {
  return () => {
    throw new Error('a capped remediator must not be respawned');
  };
}

async function consumeAt(now, { resolveRemediationWorkerClassImpl, spawnImpl, quotaHoldRevalidator } = {}) {
  return consumeNextFollowUpJob({
    rootDir,
    spawnImpl,
    now: () => now,
    promptTemplate: 'Remediation prompt template.',
    resolvePRLifecycleImpl: async () => null,
    execFileImpl: workspaceExecFileImpl(),
    resolveRemediationWorkerClassImpl,
    quotaHoldRevalidator,
    log: { log() {}, info() {}, warn() {}, error() {} },
  });
}

test('#7325 replay: a codex remediator capped 5 days out spawns claude-code on the next claim, even with fleet status down', async () => {
  heldOnCodexCap();
  const spawnImpl = recordingSpawn();
  const result = await consumeAt('2026-09-29T02:45:16.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver('unavailable'),
    spawnImpl,
  });

  assert.equal(result.consumed, true, `expected a spawn, got ${result.reason}`);
  const job = readFollowUpJob(result.jobPath);
  assert.equal(job.remediationWorker.model, 'claude-code');
  assert.equal(spawnImpl.spawned.length, 1);
  assert.equal(spawnImpl.spawned[0].command, '/usr/bin/true', 'the claude-code CLI (CLAUDE_CODE_CLI_PATH) ran');
  assert.ok(spawnImpl.spawned[0].args.includes('--print'), 'claude-code argv, not codex exec');
  // The fallbackFrom audit.
  assert.equal(job.remediationWorker.fallbackFrom, 'codex');
  assert.equal(job.remediationWorker.fallbackReason, 'provider-reset-past-hold-window');
  assert.equal(job.remediationWorker.fallbackResolution.resetAt, WEEKLY_RESET);
  assert.equal(job.remediationWorker.fallbackResolution.candidateState, 'unverified');
});

test('#7325 replay: model_only_exhaustion of gpt-6-sol re-routes a fresh codex claim before any codex spawn', async () => {
  createJob();
  const spawnImpl = recordingSpawn();
  const result = await consumeAt('2026-09-29T01:42:11.343Z', {
    resolveRemediationWorkerClassImpl: daemonResolver([
      OPENAI_MODEL_ONLY_EXHAUSTION,
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
    spawnImpl,
  });

  assert.equal(result.consumed, true, `expected a spawn, got ${result.reason}`);
  const job = readFollowUpJob(result.jobPath);
  assert.equal(job.remediationWorker.model, 'claude-code');
  assert.equal(job.remediationWorker.fallbackFrom, 'codex');
  assert.equal(job.remediationWorker.fallbackReason, 'model-exhausted');
});

test('a short hold (reset inside the window) keeps codex: an early claim holds, the claim after the reset spawns codex', async () => {
  heldOnCodexCap({ providerResetAt: '2026-09-29T02:30:00.000Z' });

  const early = await consumeAt('2026-09-29T02:10:00.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver('unavailable'),
    spawnImpl: refusingSpawn(),
    quotaHoldRevalidator: () => ({ available: true, state: 'ok', source: 'test-live-quota' }),
  });
  assert.equal(early.consumed, false);
  assert.equal(early.reason, 'remediator-capped-hold');
  const held = readFollowUpJob(early.jobPath);
  assert.equal(held.status, 'pending');
  assert.equal(held.remediationPlan.retryAfter, '2026-09-29T02:30:00.000Z');
  assert.equal(held.remediationPlan.retryHistory.at(-1).retryMetadata.workerClass, 'codex');

  const spawnImpl = recordingSpawn();
  const afterReset = await consumeAt('2026-09-29T02:30:01.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver('unavailable'),
    spawnImpl,
  });
  assert.equal(afterReset.consumed, true, `expected a spawn, got ${afterReset.reason}`);
  const job = readFollowUpJob(afterReset.jobPath);
  assert.equal(job.remediationWorker.model, 'codex');
  assert.equal(job.remediationWorker.fallbackFrom, undefined);
});

test('AFH grounding re-routes the remediator lane', async () => {
  createJob({ reviewerModel: 'codex' });
  const spawnImpl = recordingSpawn();
  const result = await consumeAt('2026-09-29T01:42:11.343Z', {
    resolveRemediationWorkerClassImpl: daemonResolver([
      {
        provider: 'openai',
        authPath: 'oauth',
        state: 'unknown',
        afhGrounding: { grounded: true, signals: 5, threshold: 3, reason: 'quota_exhausted_kills' },
      },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
    spawnImpl,
  });

  assert.equal(result.consumed, true, `expected a spawn, got ${result.reason}`);
  const job = readFollowUpJob(result.jobPath);
  assert.equal(job.remediationWorker.model, 'claude-code');
  assert.equal(job.remediationWorker.fallbackFrom, 'codex');
  assert.equal(job.remediationWorker.fallbackReason, 'afh-soft-grounded');
});

test('no fallback available means a hold with no respawn and no budget spent', async () => {
  const before = heldOnCodexCap();
  const result = await consumeAt('2026-09-29T02:45:16.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver([
      OPENAI_MODEL_ONLY_EXHAUSTION,
      { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
    ]),
    spawnImpl: refusingSpawn(),
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'remediator-capped-hold');
  const job = readFollowUpJob(result.jobPath);
  assert.equal(job.status, 'pending');
  assert.equal(job.failure, null);
  assert.equal(job.remediationPlan.transientRetries, before.job.remediationPlan.transientRetries);
  assert.equal(job.remediationPlan.currentRound, 0);
  assert.equal(job.remediationPlan.retryAfter, '2026-09-29T03:45:16.000Z');
  const entry = job.remediationPlan.retryHistory.at(-1);
  assert.equal(entry.retryMetadata.noRespawn, true);
  assert.deepEqual(entry.retryMetadata.skipped, [
    { workerClass: 'remediator-codex-corp', reason: 'unavailable:missing-provider-status' },
    { workerClass: 'remediator-claude', reason: 'capped:provider-grounded' },
  ]);
});

test('never a terminal park while a fallback exists: a spent retry budget still moves to claude-code', async () => {
  process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = '0';
  createJob();
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T01:42:11.343Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  writeFileSync(
    logPath,
    '{"type":"error","message":"You\'ve hit your usage limit. Try again at 2026-10-04T12:52:00Z or purchase more credits."}',
    'utf8',
  );
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-09-29T01:43:00.000Z',
    worker: {
      model: 'codex',
      resolvedModel: 'gpt-6-sol',
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, logPath),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });
  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-09-29T01:45:15.389Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });
  assert.equal(reconciled.reason, 'quota-exhausted');
  assert.equal(reconciled.job.status, 'pending', 'held, not parked for operator action');
  assert.equal(reconciled.job.failure, null);

  const spawnImpl = recordingSpawn();
  const result = await consumeAt('2026-09-29T02:45:16.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver('unavailable'),
    spawnImpl,
  });
  assert.equal(result.consumed, true, `expected a spawn, got ${result.reason}`);
  assert.equal(readFollowUpJob(result.jobPath).remediationWorker.model, 'claude-code');
});

test('with the interim host pin (roles.remediator: claude-code) the held job runs claude-code as routed', async () => {
  process.env.AGENT_OS_ROLES_REMEDIATOR = 'claude-code';
  heldOnCodexCap();
  const spawnImpl = recordingSpawn();
  const result = await consumeAt('2026-09-29T02:45:16.000Z', {
    resolveRemediationWorkerClassImpl: daemonResolver('unavailable'),
    spawnImpl,
  });

  assert.equal(result.consumed, true, `expected a spawn, got ${result.reason}`);
  const job = readFollowUpJob(result.jobPath);
  assert.equal(job.remediationWorker.model, 'claude-code');
  assert.equal(job.remediationWorker.fallbackFrom, undefined, 'the pin routed it; no fallback was needed');
});
