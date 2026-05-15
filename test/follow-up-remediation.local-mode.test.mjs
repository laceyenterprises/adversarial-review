import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  consumeNextFollowUpJob,
  reconcileFollowUpJob,
} from '../src/follow-up-remediation.mjs';
import {
  createFollowUpJob,
} from '../src/follow-up-jobs.mjs';

async function withLocalReplyEnv(workDir, run) {
  const authDir = path.join(workDir, '.codex');
  const authPath = path.join(authDir, 'auth.json');
  const repliesRoot = path.join(workDir, 'local-replies');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(repliesRoot, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
  }), 'utf8');

  const previous = {
    ADV_REPLIES_ROOT: process.env.ADV_REPLIES_ROOT,
    CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    HQ_ROOT: process.env.HQ_ROOT,
  };

  process.env.ADV_REPLIES_ROOT = repliesRoot;
  process.env.CODEX_AUTH_PATH = authPath;
  process.env.CODEX_CLI_PATH = '/usr/bin/true';
  process.env.CODEX_HOME = authDir;
  process.env.HOME = workDir;
  delete process.env.HQ_ROOT;

  try {
    return await run(repliesRoot);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeValidReply(replyPath, job) {
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Applied the remediation changes.',
    validation: ['node --test test/follow-up-remediation.local-mode.test.mjs'],
    addressed: [],
    pushback: [],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Local-mode reply path now matches prompt and reconcile expectations.',
    },
  }, null, 2)}\n`, 'utf8');
}

test('local-mode consume, prompt build, and reconcile agree on the same reply path', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-local-'));

  await withLocalReplyEnv(rootDir, async (repliesRoot) => {
    createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 428,
      reviewerModel: 'claude',
      linearTicketId: 'LAC-428',
      reviewBody: '## Summary\nFix local-mode remediation reply landing.\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-05-04T08:00:00.000Z',
      critical: false,
    });

    let capturedEnv;
    const consumed = await consumeNextFollowUpJob({
      rootDir,
      promptTemplate: 'Reply path: ${REPLY_PATH}',
      now: () => '2026-05-04T09:30:00.000Z',
      execFileImpl: async (command, args) => {
        if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
          mkdirSync(path.join(args[3], '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
      },
      spawnImpl: (_command, _args, options) => {
        capturedEnv = options.env;
        return { pid: 7777, unref() {} };
      },
    });

    assert.equal(consumed.consumed, true);
    const replyPath = path.join(repliesRoot, consumed.job.replyStorageKey, 'remediation-reply.json');
    const prompt = readFileSync(path.join(rootDir, consumed.job.remediationWorker.promptPath), 'utf8');
    assert.equal(capturedEnv.REMEDIATION_REPLY_PATH, replyPath);
    assert.equal(capturedEnv.ADV_REPLY_DIR, path.dirname(replyPath));
    assert.equal(capturedEnv.HQ_ROOT, undefined);
    assert.equal(capturedEnv.LRQ_ID, consumed.job.replyStorageKey);
    assert.match(prompt, new RegExp(replyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(prompt, /dispatch\/remediation-replies/);

    writeValidReply(replyPath, consumed.job);

    const reconciled = await reconcileFollowUpJob({
      rootDir,
      job: consumed.job,
      jobPath: consumed.jobPath,
      now: () => '2026-05-04T09:45:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      requestReviewRereviewImpl: () => ({
        triggered: true,
        status: 'pending',
        reason: 'review-status-reset',
        reviewRow: {
          repo: consumed.job.repo,
          pr_number: consumed.job.prNumber,
          pr_state: 'open',
          review_status: 'pending',
        },
      }),
      auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
      log: { warn: () => {}, error: () => {} },
    });

    assert.equal(reconciled.action, 'completed');
    assert.equal(reconciled.job.remediationReply.path, replyPath);
  });
});
