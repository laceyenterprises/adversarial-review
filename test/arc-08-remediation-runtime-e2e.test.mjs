// ARC-08 — remediation dispatch e2e through both AgentRuntime runtimes.
//
// Drives `consumeNextFollowUpJob` end to end with the health router forcing
// each mode, proving the single collapsed port call reaches:
//   - the `local` runtime (self-spawn descriptor), and
//   - the `os` runtime (hq-dispatch stub descriptor),
// and that the round-budget gate still fires ahead of dispatch (v1 parity).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import {
  createFollowUpJob,
  readFollowUpJob,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';

const ROUTER_LOCAL = { getMode: () => 'local' };
const ROUTER_OS = { getMode: () => 'os' };

function seedCodexAuth(homeDir) {
  const codexHome = path.join(homeDir, '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
  }), 'utf8');
  return { codexHome, authPath };
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── local runtime e2e (router forces local) ────────────────────────────────

test('router local mode routes consume through the local self-spawn runtime', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'arc08-local-'));
  const repliesRoot = path.join(rootDir, 'local-replies');
  mkdirSync(repliesRoot, { recursive: true });
  const { authPath, codexHome } = seedCodexAuth(rootDir);

  const previous = {
    ADV_REPLIES_ROOT: process.env.ADV_REPLIES_ROOT,
    CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    HQ_ROOT: process.env.HQ_ROOT,
    ADV_WITH_HQ_INTEGRATION: process.env.ADV_WITH_HQ_INTEGRATION,
  };
  process.env.ADV_REPLIES_ROOT = repliesRoot;
  process.env.CODEX_AUTH_PATH = authPath;
  process.env.CODEX_CLI_PATH = '/usr/bin/true';
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = rootDir;
  delete process.env.HQ_ROOT;
  delete process.env.ADV_WITH_HQ_INTEGRATION;

  try {
    createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 501,
      reviewerModel: 'claude',
      linearTicketId: 'ARC-501',
      reviewBody: '## Summary\nFix it.\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-07-01T08:00:00.000Z',
      critical: false,
    });

    let spawnCalled = false;
    const consumed = await consumeNextFollowUpJob({
      rootDir,
      promptTemplate: 'Reply path: ${REPLY_PATH}',
      now: () => '2026-07-01T09:30:00.000Z',
      healthRouter: ROUTER_LOCAL,
      resolvePRLifecycleImpl: async () => null,
      execFileImpl: async (command, args) => {
        if (command === 'git' && args[0] === 'clone') {
          mkdirSync(path.join(args[2], '.git'), { recursive: true });
        }
        if (command === 'gh' && args[0] === 'api' && /\/pulls\//.test(args[1])) {
          return {
            stdout: JSON.stringify({
              base: { ref: 'main' },
              head: { ref: 'remediation-head', repo: { full_name: 'laceyenterprises/agent-os' } },
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
      spawnImpl: () => {
        spawnCalled = true;
        return { pid: 7777, unref() {} };
      },
    });

    assert.equal(consumed.consumed, true);
    assert.equal(spawnCalled, true, 'local runtime must self-spawn the worker');
    const worker = consumed.job.remediationWorker;
    // Bare (local) descriptor: a live process, no hq dispatch identity.
    assert.equal(worker.processId, 7777);
    assert.equal(worker.dispatchMode, undefined);
    assert.equal(worker.dispatchId, undefined);
    assert.equal(consumed.job.remediationPlan.dispatchPath, 'bare');
  } finally {
    restoreEnv(previous);
  }
});

// ── os runtime e2e (router forces os; hq dispatch stubbed) ─────────────────

test('router os mode routes consume through the os hq-dispatch runtime', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'arc08-os-'));
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({
    ownerUser: process.env.USER || process.env.LOGNAME || 'unknown',
  }), 'utf8');
  const { authPath, codexHome } = seedCodexAuth(rootDir);

  const previous = {
    HOME: process.env.HOME,
    CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    HQ_ROOT: process.env.HQ_ROOT,
    HQ_PARENT_SESSION: process.env.HQ_PARENT_SESSION,
    HQ_PROJECT: process.env.HQ_PROJECT,
    // Leave orchestration_mode unset so the CONFIG fallback would be `local`.
    // The router — not env — is what promotes this run to `os`.
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: process.env.AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE,
    ADV_WITH_HQ_INTEGRATION: process.env.ADV_WITH_HQ_INTEGRATION,
  };
  process.env.HOME = rootDir;
  process.env.CODEX_AUTH_PATH = authPath;
  process.env.CODEX_CLI_PATH = 'codex';
  process.env.CODEX_HOME = codexHome;
  process.env.HQ_ROOT = hqRoot;
  process.env.HQ_PARENT_SESSION = 'sess_parent_arc08';
  process.env.HQ_PROJECT = 'adversarial-review';
  delete process.env.AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE;
  delete process.env.ADV_WITH_HQ_INTEGRATION;

  try {
    const { job: created } = createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/clio',
      prNumber: 502,
      reviewerModel: 'claude',
      linearTicketId: 'ARC-502',
      reviewBody: '## Summary\nFix the dispatch path.\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-07-01T08:00:00.000Z',
      critical: true,
    });

    const result = await consumeNextFollowUpJob({
      rootDir,
      promptTemplate: 'You are a remediation worker.',
      now: () => '2026-07-01T10:00:00.000Z',
      healthRouter: ROUTER_OS,
      resolvePRLifecycleImpl: async () => null,
      execFileImpl: async (command, args) => {
        if (command === 'gh' && args[0] === 'api' && /\/pulls\//.test(args[1])) {
          return {
            stdout: JSON.stringify({
              base: { ref: 'main' },
              head: { ref: 'codex/fix-pr-502', repo: { full_name: 'laceyenterprises/clio' } },
            }),
            stderr: '',
          };
        }
        if (command === 'hq' && args[0] === 'dispatch' && args[1] === 'status') {
          return {
            stdout: JSON.stringify({
              status: 'queued',
              workspacePath: path.join(hqRoot, 'workers', 'lrq_arc08'),
            }),
            stderr: '',
          };
        }
        if (command === 'hq' && args[0] === 'dispatch') {
          return {
            stdout: JSON.stringify({
              launchRequestId: 'lrq_arc08',
              dispatchId: 'dispatch_arc08',
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
      spawnImpl: () => {
        throw new Error('os mode must not self-spawn a local worker');
      },
    });

    assert.equal(result.consumed, true);
    const worker = result.job.remediationWorker;
    assert.equal(worker.dispatchMode, 'hq');
    assert.equal(worker.launchRequestId, 'lrq_arc08');
    assert.equal(worker.dispatchId, 'dispatch_arc08');
    assert.equal(worker.requestId, created.jobId);
    assert.equal(result.job.remediationPlan.dispatchPath, 'hq');
  } finally {
    restoreEnv(previous);
  }
});

// ── round/budget parity: the gate fires before dispatch, router or not ─────

test('round-budget exhaustion stops the job before any port dispatch (v1 parity)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'arc08-budget-'));
  const { authPath, codexHome } = seedCodexAuth(rootDir);

  const previous = {
    ADV_REPLIES_ROOT: process.env.ADV_REPLIES_ROOT,
    CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    HQ_ROOT: process.env.HQ_ROOT,
    ADV_WITH_HQ_INTEGRATION: process.env.ADV_WITH_HQ_INTEGRATION,
  };
  process.env.ADV_REPLIES_ROOT = path.join(rootDir, 'local-replies');
  mkdirSync(process.env.ADV_REPLIES_ROOT, { recursive: true });
  process.env.CODEX_AUTH_PATH = authPath;
  process.env.CODEX_CLI_PATH = '/usr/bin/true';
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = rootDir;
  delete process.env.HQ_ROOT;
  delete process.env.ADV_WITH_HQ_INTEGRATION;

  try {
    const { jobPath } = createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 503,
      reviewerModel: 'claude',
      linearTicketId: 'ARC-503',
      reviewBody: '## Summary\nFix.\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-07-01T08:00:00.000Z',
      critical: false,
    });
    // Force the job past its riskClass-derived round budget so the consume-time
    // pre-dispatch gate must deny. (No persisted maxRounds — that would trip the
    // earlier claim-time `max-rounds-reached` stop instead of the round-budget
    // gate in the dispatch path we're exercising.)
    const job = readFollowUpJob(jobPath);
    writeFollowUpJob(jobPath, {
      ...job,
      remediationPlan: { ...(job.remediationPlan || {}), currentRound: 99 },
    });

    const result = await consumeNextFollowUpJob({
      rootDir,
      promptTemplate: 'noop',
      now: () => '2026-07-01T09:30:00.000Z',
      healthRouter: ROUTER_LOCAL,
      resolvePRLifecycleImpl: async () => null,
      postCommentImpl: async () => ({ ok: true }),
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
      spawnImpl: () => {
        throw new Error('round-budget-exhausted must not reach the dispatch port');
      },
    });

    // The budget gate (whether the claim-time max-rounds stop or the
    // consume-time riskClass round-budget stop) denies the run before the port
    // is ever reached — the throwing spawnImpl above proves no dispatch ran.
    assert.equal(result.consumed, false);
    assert.ok(
      ['round-budget-exhausted', 'max-rounds-reached'].includes(result.reason),
      `expected a budget stop, got ${result.reason}`,
    );
    // No remediation worker was ever spawned for this round (either the record
    // is absent, or it is the `never-spawned` sentinel from the consume-time
    // gate) — the round burned no dispatch budget.
    const worker = result.job.remediationWorker;
    assert.ok(worker == null || worker.state === 'never-spawned');
  } finally {
    restoreEnv(previous);
  }
});
