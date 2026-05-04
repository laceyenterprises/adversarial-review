import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LEGACY_REPLY_PRE_COMMIT_HOOK_SRC,
  REMEDIATION_LEGACY_UNSTAGE_COMMANDS,
  REMEDIATION_REPLY_SENTINEL_FILENAME,
  buildRemediationPrompt,
  consumeNextFollowUpJob,
  installLegacyReplyGuardHook,
  prepareHqReplyLandingPad,
  reconcileFollowUpJob,
  resolveHqReplyPath,
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
    template: [
      'Reply path: ${HQ_ROOT}/dispatch/remediation-replies/${LRQ_ID}/remediation-reply.json',
      'Do NOT write or commit `.adversarial-follow-up/remediation-reply.json`.',
      'Cleanup:',
      `- ${REMEDIATION_LEGACY_UNSTAGE_COMMANDS[0]}`,
      `- ${REMEDIATION_LEGACY_UNSTAGE_COMMANDS[1]}`,
    ].join('\n'),
    remediationReplyPath: '/tmp/hq/dispatch/remediation-replies/lrq_428/remediation-reply.json',
    hqRoot: '/tmp/hq',
    launchRequestId: 'lrq_428',
  });

  assert.match(prompt, /Reply path: \/tmp\/hq\/dispatch\/remediation-replies\/lrq_428\/remediation-reply\.json/);
  assert.match(prompt, /Do NOT write or commit `.adversarial-follow-up\/remediation-reply\.json`/);
  for (const command of REMEDIATION_LEGACY_UNSTAGE_COMMANDS) {
    assert.match(prompt, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('buildRemediationPrompt throws when HQ reply interpolation inputs are missing', () => {
  assert.throws(
    () => buildRemediationPrompt(makeJob(), {
      template: 'Reply path: ${HQ_ROOT}/dispatch/remediation-replies/${LRQ_ID}/remediation-reply.json',
      launchRequestId: 'lrq_428',
    }),
    /buildRemediationPrompt requires hqRoot and launchRequestId/
  );
});

test('prepareHqReplyLandingPad creates the canonical HQ directory, removes stale replies, and writes the sentinel', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-hq-'));
  const staleReplyPath = path.join(hqRoot, 'dispatch', 'remediation-replies', 'lrq_428', 'remediation-reply.json');
  mkdirSync(path.dirname(staleReplyPath), { recursive: true });
  writeFileSync(staleReplyPath, '{"stale":true}\n', 'utf8');
  const landingPad = prepareHqReplyLandingPad({
    hqRoot,
    launchRequestId: 'lrq_428',
  });

  assert.equal(
    landingPad.replyPath,
    path.join(hqRoot, 'dispatch', 'remediation-replies', 'lrq_428', 'remediation-reply.json'),
  );
  assert.equal(existsSync(landingPad.replyPath), false);
  assert.equal(existsSync(landingPad.sentinelPath), true);
  assert.equal(
    readFileSync(landingPad.sentinelPath, 'utf8'),
    'Use the sibling remediation-reply.json path; do not write .adversarial-follow-up/remediation-reply.json.\n',
  );
  assert.equal(path.basename(landingPad.sentinelPath), REMEDIATION_REPLY_SENTINEL_FILENAME);
});

test('consumeNextFollowUpJob exports HQ_ROOT/LRQ_ID and pre-creates the HQ landing pad', async () => {
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
      promptTemplate: [
        'Reply path: ${HQ_ROOT}/dispatch/remediation-replies/${LRQ_ID}/remediation-reply.json',
        'Do NOT write or commit `.adversarial-follow-up/remediation-reply.json`; that path is forbidden.',
      ].join('\n'),
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

    const lrqId = result.job.replyStorageKey;
    const replyDir = path.join(hqRoot, 'dispatch', 'remediation-replies', lrqId);
    const promptPath = path.join(rootDir, result.job.remediationWorker.promptPath);
    const prompt = readFileSync(promptPath, 'utf8');

    assert.equal(result.consumed, true);
    assert.equal(capturedEnv.HQ_ROOT, hqRoot);
    assert.equal(capturedEnv.LRQ_ID, lrqId);
    assert.equal(existsSync(path.join(replyDir, REMEDIATION_REPLY_SENTINEL_FILENAME)), true);
    assert.match(prompt, new RegExp(`${hqRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dispatch/remediation-replies/${lrqId}/remediation-reply\\.json`));
    assert.match(prompt, /that path is forbidden/i);
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
  writeFileSync(path.join(repoDir, 'keep.txt'), 'updated\n', 'utf8');
  execFileSync('git', ['add', 'keep.txt', '.adversarial-follow-up/remediation-reply.json'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('sh', ['-lc', REMEDIATION_LEGACY_UNSTAGE_COMMANDS.join('\n')], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'remediation'], { cwd: repoDir, stdio: 'ignore' });

  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: repoDir, encoding: 'utf8' });
  assert.match(diff, /^keep\.txt$/m);
  assert.doesNotMatch(diff, /\.adversarial-follow-up\/remediation-reply\.json/);
});

test('installLegacyReplyGuardHook rejects staged legacy remediation replies in real git commits', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  installLegacyReplyGuardHook(repoDir);

  const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
  assert.equal(existsSync(hookPath), true);
  assert.equal(
    readFileSync(hookPath, 'utf8'),
    readFileSync(LEGACY_REPLY_PRE_COMMIT_HOOK_SRC, 'utf8')
  );

  writeFileSync(path.join(repoDir, 'keep.txt'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'keep.txt'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'ignore' });

  mkdirSync(path.join(repoDir, '.adversarial-follow-up'), { recursive: true });
  writeFileSync(path.join(repoDir, '.adversarial-follow-up', 'remediation-reply.json'), '{"legacy":true}\n', 'utf8');
  execFileSync('git', ['add', '.adversarial-follow-up/remediation-reply.json'], { cwd: repoDir, stdio: 'ignore' });

  const result = spawnSync('git', ['commit', '-m', 'forbidden'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to commit staged \.adversarial-follow-up artifacts/i);
});

test('reconcileFollowUpJob prefers the HQ reply path, rejects forbidden legacy replies, and warns only on migration-window fallback', async () => {
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
    const warnings = [];
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
      log: { warn: (message) => warnings.push(message), error: () => {} },
    });

    assert.equal(result.action, 'completed');
    assert.equal(result.job.remediationReply.path, replyPath);
    assert.deepEqual(warnings, []);
  });

  const forbiddenRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const forbiddenHqRoot = path.join(forbiddenRoot, 'hq');
  const { claimed: forbiddenClaimed } = makeQueuedJob(forbiddenRoot, { prNumber: 430 });
  const forbiddenWorkspaceDir = path.join(forbiddenRoot, 'data', 'follow-up-jobs', 'workspaces', forbiddenClaimed.job.jobId);
  const forbiddenArtifactDir = path.join(forbiddenWorkspaceDir, '.adversarial-follow-up');
  mkdirSync(forbiddenArtifactDir, { recursive: true });
  const forbiddenOutputPath = path.join(forbiddenArtifactDir, 'codex-last-message.md');
  const forbiddenLegacyReplyPath = path.join(forbiddenArtifactDir, 'remediation-reply.json');
  writeFileSync(forbiddenOutputPath, 'worker output\n', 'utf8');
  writeValidReply(forbiddenLegacyReplyPath, forbiddenClaimed.job, {
    addressed: [{ finding: 'legacy path used', action: 'worker wrote the wrong artifact path' }],
    reReview: { requested: true, reason: 'should not matter' },
  });
  const forbiddenReply = resolveHqReplyPath({
    hqRoot: forbiddenHqRoot,
    launchRequestId: forbiddenClaimed.job.jobId,
  });
  mkdirSync(forbiddenReply.replyDir, { recursive: true });

  const forbiddenSpawned = markFollowUpJobSpawned({
    jobPath: forbiddenClaimed.jobPath,
    spawnedAt: '2026-05-04T09:01:00.000Z',
    worker: {
      model: 'codex',
      processId: 9003,
      state: 'spawned',
      workspaceDir: path.relative(forbiddenRoot, forbiddenWorkspaceDir),
      outputPath: path.relative(forbiddenRoot, forbiddenOutputPath),
      logPath: path.relative(forbiddenRoot, path.join(forbiddenArtifactDir, 'codex-worker.log')),
      replyPath: forbiddenReply.replyPath,
    },
  });

  await withHqRootEnv(forbiddenHqRoot, async () => {
    const warnings = [];
    const result = await reconcileFollowUpJob({
      rootDir: forbiddenRoot,
      job: forbiddenSpawned.job,
      jobPath: forbiddenSpawned.jobPath,
      now: () => '2026-05-04T09:30:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      log: { warn: (message) => warnings.push(message), error: () => {} },
    });

    assert.equal(result.action, 'failed');
    assert.equal(result.job.failure.code, 'legacy-remediation-reply-forbidden');
    assert.deepEqual(warnings, []);
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
    const warnings = [];
    const result = await reconcileFollowUpJob({
      rootDir: fallbackRoot,
      job: fallbackSpawned.job,
      jobPath: fallbackSpawned.jobPath,
      now: () => '2026-05-04T09:30:00.000Z',
      isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => null,
      log: { warn: (message) => warnings.push(message), error: () => {} },
    });

    assert.equal(result.action, 'stopped');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /legacy remediation reply fallback used/i);
  });
});
