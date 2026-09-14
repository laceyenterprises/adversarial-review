import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REMEDIATION_LEGACY_UNSTAGE_COMMANDS,
  WORKSPACE_ARTIFACT_EXCLUDE_ENTRY,
  buildRemediationPrompt,
  classifyGithubAuthOperationalBlocker,
  consumeNextFollowUpJob,
  extractCommitShaFromOperationalBlocker,
  preserveUnpushedCommit,
  prepareHqReplyLandingPad,
  reconcileFollowUpJob,
  resolveHqReplyPath,
  retryGithubAuthPushOnce,
} from '../src/follow-up-remediation.mjs';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'laceyenterprises__agent-os-pr-428-2026-05-04T08-00-00-000Z',
    repo: 'laceyenterprises/agent-os',
    prNumber: 428,
    baseBranch: 'main',
    reviewerModel: 'claude',
    linearTicketId: 'LAC-428',
    reviewSummary: 'Stop committing remediation replies from the worktree.',
    reviewBody: '## Summary\nStop committing remediation replies from the worktree.\n\n## Verdict\nRequest changes',
    createdAt: '2026-05-04T08:00:00.000Z',
    critical: true,
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 3,
      currentRound: 0,
      rounds: [],
    },
    ...overrides,
  };
}

function writeValidReply(replyPath, job, overrides = {}) {
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Applied the remediation changes.',
    validation: ['npm test'],
    addressed: [],
    pushback: [],
    blockers: [],
    reReview: {
      requested: false,
      reason: null,
    },
    ...overrides,
  }, null, 2)}\n`, 'utf8');
}

function greenCiGate() {
  return {
    state: 'green',
    conclusion: 'SUCCESS',
    headSha: 'ci-green-head',
    totalExternalChecks: 3,
    failedChecks: [],
    pendingChecks: [],
  };
}

async function withHqRootEnv(hqRoot, run) {
  const previous = process.env.HQ_ROOT;
  mkdirSync(hqRoot, { recursive: true });
  process.env.HQ_ROOT = hqRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HQ_ROOT;
    else process.env.HQ_ROOT = previous;
  }
}

async function withOAuthTestEnv(workDir, run) {
  const authDir = path.join(workDir, '.codex');
  const authPath = path.join(authDir, 'auth.json');
  const hqRoot = path.join(workDir, 'hq');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hqRoot, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
  }), 'utf8');

  const previous = {
    CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    HQ_ROOT: process.env.HQ_ROOT,
  };

  process.env.CODEX_AUTH_PATH = authPath;
  process.env.CODEX_CLI_PATH = '/usr/bin/true';
  process.env.CODEX_HOME = authDir;
  process.env.HOME = workDir;
  process.env.HQ_ROOT = hqRoot;

  try {
    return await run(hqRoot);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeQueuedJob(rootDir, overrides = {}) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 428,
    reviewerModel: 'claude',
    linearTicketId: 'LAC-428',
    reviewBody: '## Summary\nStop committing remediation replies from the worktree.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-04T08:00:00.000Z',
    critical: true,
    ...overrides,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-05-04T09:00:00.000Z',
    launcherPid: 4242,
  });
  return { created, claimed };
}

test('buildRemediationPrompt instructs workers to use only the HQ reply path and forbids the legacy worktree path', () => {
  const prompt = buildRemediationPrompt(makeJob(), {
    remediationReplyPath: '/tmp/hq/dispatch/remediation-replies/lrq_428/remediation-reply.json',
    hqRoot: '/tmp/hq',
    launchRequestId: 'lrq_428',
  });

  assert.match(prompt, /\/tmp\/hq\/dispatch\/remediation-replies\/lrq_428\/remediation-reply\.json/);
  assert.match(prompt, /Do NOT write or commit `.adversarial-follow-up\/remediation-reply\.json`/);
  for (const command of REMEDIATION_LEGACY_UNSTAGE_COMMANDS) {
    assert.match(prompt, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('prepareHqReplyLandingPad creates the canonical HQ directory', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-hq-'));
  const landingPad = prepareHqReplyLandingPad({
    hqRoot,
    launchRequestId: 'lrq_428',
  });

  assert.equal(
    landingPad.replyPath,
    path.join(hqRoot, 'dispatch', 'remediation-replies', 'lrq_428', 'remediation-reply.json'),
  );
  assert.equal(existsSync(landingPad.replyDir), true);
});

test('consumeNextFollowUpJob exports the canonical reply env, pre-creates the HQ landing pad, and excludes workspace artifacts from staging', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  await withOAuthTestEnv(rootDir, async (hqRoot) => {
    createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 428,
      reviewerModel: 'claude',
      linearTicketId: 'LAC-428',
      reviewBody: '## Summary\nStop committing remediation replies from the worktree.\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-05-04T08:00:00.000Z',
      critical: true,
    });

    let capturedEnv;
    const result = await consumeNextFollowUpJob({
      rootDir,
      promptTemplate: 'Reply path: ${REPLY_PATH}',
      now: () => '2026-05-04T09:30:00.000Z',
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
      spawnImpl: (_command, _args, options) => {
        capturedEnv = options.env;
        return { pid: 7777, unref() {} };
      },
    });

    const lrqId = result.job.replyStorageKey;
    const replyDir = path.join(hqRoot, 'dispatch', 'remediation-replies', lrqId);
    const promptPath = path.join(rootDir, result.job.remediationWorker.promptPath);
    const prompt = readFileSync(promptPath, 'utf8');
    const excludePath = path.join(rootDir, result.job.workspaceDir, '.git', 'info', 'exclude');

    assert.equal(result.consumed, true);
    assert.equal(capturedEnv.REMEDIATION_REPLY_PATH, path.join(replyDir, 'remediation-reply.json'));
    assert.equal(capturedEnv.ADV_REPLY_DIR, replyDir);
    assert.equal(capturedEnv.HQ_ROOT, hqRoot);
    assert.equal(capturedEnv.LRQ_ID, lrqId);
    assert.equal(existsSync(replyDir), true);
    assert.match(readFileSync(excludePath, 'utf8'), new RegExp(`^${WORKSPACE_ARTIFACT_EXCLUDE_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(prompt, new RegExp(`${hqRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dispatch/remediation-replies/${lrqId}/remediation-reply\\.json`));
  });
});

test('legacy cleanup commands keep the worktree remediation reply out of the commit', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-git-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(path.join(repoDir, 'keep.txt'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'keep.txt'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'ignore' });

  mkdirSync(path.join(repoDir, '.adversarial-follow-up'), { recursive: true });
  writeFileSync(path.join(repoDir, '.adversarial-follow-up', 'remediation-reply.json'), '{"legacy":true}\n', 'utf8');
  writeFileSync(path.join(repoDir, '.adversarial-follow-up', 'prompt.md'), 'prompt\n', 'utf8');
  writeFileSync(path.join(repoDir, '.adversarial-follow-up', 'codex-last-message.md'), 'last message\n', 'utf8');
  writeFileSync(path.join(repoDir, '.adversarial-follow-up', 'codex-worker.log'), 'worker log\n', 'utf8');
  writeFileSync(path.join(repoDir, 'keep.txt'), 'updated\n', 'utf8');
  execFileSync('git', ['add', 'keep.txt', '.adversarial-follow-up'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('sh', ['-lc', REMEDIATION_LEGACY_UNSTAGE_COMMANDS.join('\n')], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'remediation'], { cwd: repoDir, stdio: 'ignore' });

  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' });
  assert.match(diff, /^keep\.txt$/m);
  assert.doesNotMatch(diff, /\.adversarial-follow-up\//);
});

test('reconcileFollowUpJob prefers the HQ reply path and rejects the legacy fallback', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = path.join(rootDir, 'hq');
  const { claimed } = makeQueuedJob(rootDir);
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'worker output\n', 'utf8');

  const { replyDir, replyPath } = resolveHqReplyPath({
    hqRoot,
    launchRequestId: claimed.job.jobId,
  });
  mkdirSync(replyDir, { recursive: true });
  writeValidReply(replyPath, claimed.job, {
    reReview: { requested: true, reason: 'Ready for another adversarial pass.' },
  });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-04T09:01:00.000Z',
    worker: {
      model: 'codex',
      processId: 9001,
      state: 'spawned',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      replyPath,
    },
  });

  await withHqRootEnv(hqRoot, async () => {
    const result = await reconcileFollowUpJob({
      rootDir,
      job: spawned.job,
      jobPath: spawned.jobPath,
      now: () => '2026-05-04T09:30:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      requestReviewRereviewImpl: () => ({
        triggered: true,
        status: 'pending',
        reason: 'review-status-reset',
        reviewRow: { repo: claimed.job.repo, pr_number: claimed.job.prNumber, pr_state: 'open', review_status: 'pending' },
      }),
      auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
      inspectRemediationCiRegressionImpl: async () => greenCiGate(),
      log: { warn: () => {}, error: () => {} },
    });

    assert.equal(result.action, 'completed');
    assert.equal(result.job.remediationReply.path, replyPath);
  });

  const fallbackRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const fallbackHqRoot = path.join(fallbackRoot, 'hq');
  const { claimed: fallbackClaimed } = makeQueuedJob(fallbackRoot, { prNumber: 429 });
  const fallbackWorkspaceDir = path.join(fallbackRoot, 'data', 'follow-up-jobs', 'workspaces', fallbackClaimed.job.jobId);
  const fallbackArtifactDir = path.join(fallbackWorkspaceDir, '.adversarial-follow-up');
  mkdirSync(fallbackArtifactDir, { recursive: true });
  const fallbackOutputPath = path.join(fallbackArtifactDir, 'codex-last-message.md');
  const legacyReplyPath = path.join(fallbackArtifactDir, 'remediation-reply.json');
  writeFileSync(fallbackOutputPath, 'worker output\n', 'utf8');
  writeValidReply(legacyReplyPath, fallbackClaimed.job, {
    reReview: { requested: false, reason: null },
  });

  const fallbackSpawned = markFollowUpJobSpawned({
    jobPath: fallbackClaimed.jobPath,
    spawnedAt: '2026-05-04T09:01:00.000Z',
    worker: {
      model: 'codex',
      processId: 9002,
      state: 'spawned',
      workspaceDir: path.relative(fallbackRoot, fallbackWorkspaceDir),
      outputPath: path.relative(fallbackRoot, fallbackOutputPath),
      logPath: path.relative(fallbackRoot, path.join(fallbackArtifactDir, 'codex-worker.log')),
      replyPath: path.relative(fallbackRoot, legacyReplyPath),
    },
  });

  await withHqRootEnv(fallbackHqRoot, async () => {
    const result = await reconcileFollowUpJob({
      rootDir: fallbackRoot,
      job: fallbackSpawned.job,
      jobPath: fallbackSpawned.jobPath,
      now: () => '2026-05-04T09:30:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      log: { warn: () => {}, error: () => {} },
    });

    assert.equal(result.action, 'failed');
    assert.equal(result.reason, 'invalid-remediation-reply');
    assert.equal(result.job.failure.code, 'invalid-remediation-reply');
    assert.match(result.job.failure.message, /legacy remediation reply path is forbidden/i);
  });
});

test('GitHub-auth commit extraction does not fall back to the original job head', () => {
  assert.equal(
    extractCommitShaFromOperationalBlocker(
      { category: 'github-auth', finding: 'bad credentials' },
      { headSha: 'a8d151c82639f6ff67d5a646e34c789f5e066504' },
    ),
    null,
  );
  assert.equal(
    extractCommitShaFromOperationalBlocker({
      category: 'github-auth',
      finding: 'preserved unpushed commit a8d151c82639f6ff67d5a646e34c789f5e066504 after bad credentials',
    }),
    'a8d151c82639f6ff67d5a646e34c789f5e066504',
  );
});

test('preserveUnpushedCommit creates a fetchable bundle for a raw commit SHA', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-github-auth-bundle-'));
  const repoDir = path.join(rootDir, 'repo');
  const hqRoot = path.join(rootDir, 'hq');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(path.join(repoDir, 'rescued.txt'), 'rescued commit\n', 'utf8');
  execFileSync('git', ['add', 'rescued.txt'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'rescued commit'], { cwd: repoDir, stdio: 'ignore' });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  const rescue = await preserveUnpushedCommit({
    hqRoot,
    workspaceDir: repoDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 431,
    jobId: 'job/raw-sha-bundle',
    commitSha,
    observedAt: '2026-05-04T10:00:00.000Z',
  });

  assert.equal(rescue.preserved, true);
  assert.equal(existsSync(rescue.path), true);
  execFileSync('git', ['-C', repoDir, 'bundle', 'verify', rescue.path], { stdio: 'ignore' });

  const fetchedDir = path.join(rootDir, 'fetched');
  mkdirSync(fetchedDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: fetchedDir, stdio: 'ignore' });
  execFileSync('git', ['fetch', rescue.path, `${rescue.ref}:refs/heads/rescued`], { cwd: fetchedDir, stdio: 'ignore' });
  const fetchedSha = execFileSync('git', ['rev-parse', 'refs/heads/rescued'], { cwd: fetchedDir, encoding: 'utf8' }).trim();
  assert.equal(fetchedSha, commitSha);
});

test('retryGithubAuthPushOnce retries transient reminted push failures only within the bounded ladder', async () => {
  const transientCalls = [];
  const transientResult = await retryGithubAuthPushOnce({
    workspaceDir: '/tmp/workspace',
    workerClass: 'codex-remediation',
    branch: 'auth-rescue',
    commitSha: '2222222222222222222222222222222222222222',
    retryDelaysMs: [1, 1],
    sleepImpl: async () => {},
    execFileImpl: async (command, args) => {
      transientCalls.push({ command, args });
      if (transientCalls.length < 3) {
        const err = new Error('Command failed: git push');
        err.stderr = 'fatal: unable to access https://github.com/laceyenterprises/agent-os.git/: TLS handshake timeout';
        throw err;
      }
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(transientResult.pushed, true);
  assert.equal(transientResult.reason, 'push-succeeded');
  assert.equal(transientResult.attempts, 3);
  assert.equal(transientCalls.length, 3);

  const terminalCalls = [];
  const terminalResult = await retryGithubAuthPushOnce({
    workspaceDir: '/tmp/workspace',
    workerClass: 'codex-remediation',
    branch: 'auth-rescue',
    commitSha: '3333333333333333333333333333333333333333',
    retryDelaysMs: [1, 1],
    sleepImpl: async () => {
      throw new Error('non-transient push must not sleep for retry');
    },
    execFileImpl: async () => {
      terminalCalls.push(true);
      const err = new Error('Command failed: git push');
      err.stderr = '! [rejected] HEAD -> auth-rescue (stale info)\nerror: failed to push some refs';
      throw err;
    },
  });

  assert.equal(terminalResult.pushed, false);
  assert.equal(terminalResult.reason, 'push-failed-after-remint');
  assert.equal(terminalResult.transient, false);
  assert.equal(terminalResult.attempts, 1);
  assert.equal(terminalCalls.length, 1);
});

test('recoverable GitHub-auth retry routes unmapped worker identities through the canonical remediator class', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = path.join(rootDir, 'hq');
  const { claimed } = makeQueuedJob(rootDir, {
    prNumber: 430,
    builderTag: 'clio-agent',
    reviewerModel: 'codex',
  });
  const job = {
    ...claimed.job,
    branch: 'clio-authblock-rescue',
    headSha: '1111111111111111111111111111111111111111',
  };
  writeFileSync(claimed.jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'worker hit GitHub auth while pushing\n', 'utf8');

  const { replyDir, replyPath } = resolveHqReplyPath({
    hqRoot,
    launchRequestId: job.jobId,
  });
  mkdirSync(replyDir, { recursive: true });
  writeValidReply(replyPath, job, {
    outcome: 'blocked',
    operationalBlockers: [{
      title: 'github-auth',
      category: 'github-auth',
      finding: 'bad credentials while pushing remediated commit',
      commitSha: '2222222222222222222222222222222222222222',
      reasoning: 'token expired',
    }],
    reReview: { requested: false, reason: null },
  });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-04T09:01:00.000Z',
    worker: {
      model: 'clio-agent',
      processId: 9003,
      state: 'spawned',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      replyPath,
    },
  });

  const execCalls = [];
  const rereviewCalls = [];
  await withHqRootEnv(hqRoot, async () => {
    const result = await reconcileFollowUpJob({
      rootDir,
      job: spawned.job,
      jobPath: spawned.jobPath,
      now: () => '2026-05-04T09:30:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      requestReviewRereviewImpl: (args) => {
        rereviewCalls.push(args);
        return {
          triggered: true,
          status: 'pending',
          reason: 'review-status-reset',
          reviewRow: { repo: job.repo, pr_number: job.prNumber, pr_state: 'open', review_status: 'pending' },
        };
      },
      execFileImpl: async (command, args, options = {}) => {
        execCalls.push({ command, args, options });
        return { stdout: '', stderr: '' };
      },
      log: { warn: () => {}, error: () => {} },
    });

    assert.equal(result.action, 'completed');
    assert.equal(result.job.operationalBlockerRecovery.retry.pushed, true);
    assert.equal(result.job.operationalBlockerRecovery.retry.reason, 'push-succeeded');
  });

  const retryCall = execCalls.find((call) => call.command === 'bash');
  assert.ok(retryCall, 'expected a GitHub-auth retry push');
  assert.equal(
    retryCall.options.env.WORKER_CLASS,
    'claude-code',
    'unmapped worker.model must fall through to pickRemediationWorkerClass(job) for retry token resolution',
  );
  assert.equal(rereviewCalls.length, 1);
  assert.equal(rereviewCalls[0].targetRevisionRef, '2222222222222222222222222222222222222222');
});
