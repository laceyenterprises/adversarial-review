import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { classifyGithubAuthOperationalBlocker, extractCommitShaFromOperationalBlocker, preserveUnpushedCommit, recoverGithubAuthOperationalBlocker, retryGithubAuthPushOnce } from '../src/github-auth-recovery.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { claimNextFollowUpJob, createFollowUpJob, markFollowUpJobSpawned } from '../src/follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);
const oldHead = 'a'.repeat(40);
const fixedHead = 'b'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };

function fixture(t, { paths = '.github/workflows/repair.yml\0', remote, headBefore = oldHead, headAfter = fixedHead,
  brokerFails = false, pushFails = false, failDiff = false, killSwitch = false, headReads = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wfdrift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['modules/worker-pool/lib/hq-gh.sh',
    'modules/worker-pool/lib/shims/gh', 'modules/worker-pool/bin/git-safe']) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  const env = { HQ_REPO_ROOT: root, OAUTH_BROKER_SHARED_SECRET_FILE: '/fixture/secret',
    GH_TOKEN: 'physical-harness-token', WORKER_CLASS: 'codex',
    ...(killSwitch ? { ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT: 'false' } : {}) };
  const calls = [];
  let observedHead = remote || headBefore;
  const args = { workspaceDir: '/fixture/workspace', branch: 'feature', workerClass: 'codex',
    repo: 'example/repo', prNumber: 42, commitSha: headAfter, expectedRemoteSha: headBefore,
    requiresWorkflowPush: true, jobId: 'fixture-job', env, retryDelaysMs: [], log: quiet,
    sleepImpl: async (ms) => { calls.push({ type: 'sleep', ms }); },
    readFileImpl: () => 'fixture-secret',
    fetchImpl: async (url) => {
      calls.push({ type: 'mint', url });
      if (brokerFails) throw new Error('broker HTTP 503 unavailable');
      return { ok: true, json: async () => ({ access_token: 'ghs_fixture-scoped-token',
        provider: 'github-app-merge-agent' }) };
    },
    execFileImpl: async (command, argv, options) => {
      calls.push({ type: command, argv, env: options?.env });
      if (command === 'git' && argv.includes('log')) {
        if (failDiff) throw new Error('missing commit object');
        return { stdout: paths };
      }
      if (command === 'gh') {
        const read = headReads.length ? headReads.shift() : observedHead;
        if (read instanceof Error) throw read;
        return { stdout: read + '\n' };
      }
      if (command === 'bash') {
        assert.equal(options.env.WORKER_CLASS, 'merge-agent');
        assert.equal(options.env.GH_TOKEN, 'ghs_fixture-scoped-token');
        assert.equal(options.env.MERGE_AGENT_GH_TOKEN, 'ghs_fixture-scoped-token');
        assert.equal(options.env.MERGE_AGENT_BROKER_REQUIRED, '1');
        assert.equal(options.env.OAUTH_BROKER_MERGE_AGENT_PROVIDER, 'github-app-merge-agent');
        assert.equal(options.env.PUSH_REMOTE, 'https://github.com/example/repo.git');
        assert.equal(options.env.EXPECTED_REMOTE_SHA, headBefore);
        assert.match(argv[1], /--force-with-lease/);
        observedHead = headAfter;
        const transcript = '   ' + headBefore.slice(0, 7) + '..' + headAfter.slice(0, 7) + ' fixture -> feature\n';
        if (pushFails) throw Object.assign(new Error('secondary transport rejected'), { stderr: transcript + 'stale info' });
        return { stdout: '', stderr: transcript };
      }
      throw new Error('Unexpected fixture command: ' + command);
    },
  };
  return { args, calls, env };
}

test('WFDRIFT-01: an explicit late workflow denial is a bounded recovery candidate', () => {
  const result = classifyGithubAuthOperationalBlocker({ title: 'github-auth',
    reasoning: 'GitHub rejected updating .github/workflows/repo-guards.yml without workflows permission.' });
  assert.equal(result.kind, 'workflow-push-candidate');
  assert.equal(classifyGithubAuthOperationalBlocker({ category: 'github-auth',
    detail: "refusing to update workflow 'repair.yml' without 'workflows' permission" }).kind, 'workflow-push-candidate');
  assert.equal(classifyGithubAuthOperationalBlocker({ category: 'github-auth',
    detail: 'workflow scope was verified, but the token expired' }).kind, 'recoverable');
  for (const reason of ['403 forbidden', 'revoked entitlement', 'contents permission denied',
    'revoked entitlement and missing workflows permission']) {
    assert.equal(classifyGithubAuthOperationalBlocker({ category: 'github-auth', detail: reason }).kind, 'terminal');
  }
});

test('WFDRIFT-01: preflight retries transient head reads with bounded backoff', async (t) => {
  const { args, calls } = fixture(t, { headReads: [new Error('TLS handshake timeout'),
    new Error('HTTP 503 service unavailable'), oldHead] });
  args.retryDelaysMs = [1, 2];
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.deepEqual(calls.filter((call) => call.type === 'sleep').map((call) => call.ms), [1, 2]);
  assert.equal(calls.filter((call) => call.type === 'gh').length, 4);
  assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
});

test('WFDRIFT-01: exhausted and permanent preflight failures never push', async (t) => {
  for (const [headReads, expectedReads] of [
    [Array.from({ length: 3 }, () => new Error('connection reset')), 3],
    [[new Error('HTTP 403 forbidden')], 1],
    [['unreadable'], 1],
  ]) {
    const { args, calls } = fixture(t, { headReads });
    args.retryDelaysMs = [1, 2];
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.reason, 'workflow-push-remote-head-unproven');
    assert.equal(result.pushed, false);
    assert.equal(calls.filter((call) => call.type === 'gh').length, expectedReads);
    assert.equal(calls.filter((call) => call.type === 'bash').length, 0);
  }
});

test('WFDRIFT-01: verification retries stale and transient reads without losing native update proof', async (t) => {
  for (const pushFails of [false, true]) {
    const { args, calls } = fixture(t, { pushFails,
      headReads: [oldHead, new Error('TLS handshake timeout'), oldHead, fixedHead] });
    args.retryDelaysMs = [1, 2];
    let recorded = null;
    args.recordNativePublicationImpl = (proof) => {
      assert.equal(calls.filter((call) => call.type === 'gh').length, 1);
      assert.equal(proof.method, 'git-update');
      recorded = proof;
    };
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.pushed, true);
    assert.equal(result.nativePublicationReceipt.headSha, fixedHead);
    assert.equal(result.nativePublicationReceipt.method, 'git-update-and-live-pr-head');
    assert.deepEqual(result.pendingNativePublication, recorded);
    assert.deepEqual(calls.filter((call) => call.type === 'sleep').map((call) => call.ms), [1, 2]);
    assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
  }
});

test('WFDRIFT-01: exhausted verification resumes from retained proof without another push', async (t) => {
  for (const verificationRead of [oldHead, new Error('HTTP 503 service unavailable')]) {
    const { args, calls } = fixture(t, { headReads: [oldHead,
      verificationRead, verificationRead, verificationRead] });
    args.retryDelaysMs = [1, 2];
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.pushed, false);
    assert.equal(result.retryLater, true);
    assert.equal(result.nativePublicationReceipt, undefined);
    assert.equal(result.pendingNativePublication.headSha, fixedHead);
    const resumed = await retryGithubAuthPushOnce({ ...args,
      pendingNativePublication: JSON.parse(JSON.stringify(result.pendingNativePublication)) });
    assert.equal(resumed.pushed, true);
    assert.equal(resumed.nativePublicationReceipt.headSha, fixedHead);
    assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
  }
});

test('WFDRIFT-01: permanent verification errors and expired holds retain proof without active retries', async (t) => {
  for (const verificationRead of [new Error('HTTP 403 forbidden'), oldHead]) {
    const headReads = [oldHead, verificationRead];
    const { args, calls } = fixture(t, { headReads });
    const first = await retryGithubAuthPushOnce(args);
    const pending = { ...first.pendingNativePublication, observedAt: '2020-01-01T00:00:00.000Z' };
    headReads.push(verificationRead);
    const result = await retryGithubAuthPushOnce({ ...args, pendingNativePublication: pending });
    assert.equal(result.pushed, false);
    assert.equal(result.retryLater, false);
    assert.deepEqual(result.pendingNativePublication, pending);
    assert.equal(result.nativePublicationReceipt, undefined);
    const resumed = await retryGithubAuthPushOnce({ ...args, pendingNativePublication: pending });
    assert.equal(resumed.pushed, true);
    assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
  }
});

test('WFDRIFT-01: retained native evidence must match the full recovery identity', async (t) => {
  const f = fixture(t);
  const initial = await retryGithubAuthPushOnce(f.args);
  for (const changed of [{ schemaVersion: 2 }, { source: 'operator' }, { method: 'unknown' },
    { jobId: 'other-job' }, { repo: 'other/repo' }, { prNumber: 43 }, { branch: 'other' },
    { expectedRemoteSha: 'c'.repeat(40) }, { headSha: 'c'.repeat(40) }, { observedAt: 'invalid' }]) {
    const { args, calls } = fixture(t, { remote: fixedHead });
    const result = await retryGithubAuthPushOnce({ ...args,
      pendingNativePublication: { ...initial.pendingNativePublication, ...changed } });
    assert.equal(result.pushed, false);
    assert.equal(result.reason, 'already-published');
    assert.equal(result.nativePublicationReceipt, undefined);
    assert.equal(calls.filter((call) => call.type === 'bash').length, 0);
  }
});

test('WFDRIFT-01: successful push exit without a native transcript never creates publication proof', async (t) => {
  for (const liveHead of [oldHead, fixedHead]) {
    const { args } = fixture(t, { headReads: [oldHead, liveHead] });
    const mocked = args.execFileImpl;
    args.execFileImpl = async (command, argv, options) => {
      const result = await mocked(command, argv, options);
      return command === 'bash' ? { stdout: '', stderr: '' } : result;
    };
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.pushed, false);
    assert.equal(result.nativePublicationReceipt, undefined);
    assert.equal(result.pendingNativePublication, undefined);
    assert.equal(result.alreadyPublished, liveHead === fixedHead ? true : undefined);
  }
});

test('WFDRIFT-01: daemon persists update proof and resumes verification on the next reconcile tick', async (t) => {
  const { env, calls, args } = fixture(t, { headReads: [oldHead,
    ...Array.from({ length: 3 }, () => new Error('TLS handshake timeout'))] });
  const rootDir = env.HQ_REPO_ROOT;
  const stamp = new Date().toISOString();
  createFollowUpJob({ rootDir, repo: args.repo, prNumber: args.prNumber, reviewerModel: 'claude',
    reviewBody: '## Blocking Issues\n- None.\n\n## Verdict\nRequest changes', reviewPostedAt: stamp });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: stamp, launcherPid: process.pid });
  const workspaceDir = join(rootDir, 'data/follow-up-jobs/workspaces', claimed.job.jobId);
  mkdirSync(workspaceDir, { recursive: true });
  const outputPath = join(workspaceDir, 'last-message.md');
  const replyPath = join(rootDir, 'hq/dispatch/remediation-replies', claimed.job.jobId, 'remediation-reply.json');
  mkdirSync(join(replyPath, '..'), { recursive: true });
  const secretPath = join(rootDir, 'secret');
  writeFileSync(secretPath, 'fixture-secret');
  writeFileSync(outputPath, 'GitHub denied the workflow push.\n');
  const reply = { kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
    jobId: claimed.job.jobId, repo: args.repo, prNumber: args.prNumber, outcome: 'blocked',
    summary: 'Workflow push denied.', validation: [], addressed: [], pushback: [], blockers: [],
    operationalBlockers: [{ title: 'github-auth', finding: 'GitHub rejected the workflow without workflows permission.',
      reasoning: 'The physical worker credential cannot publish workflows.',
      commitSha: fixedHead, expectedRemoteSha: oldHead }], reReview: { requested: false, reason: null } };
  writeFileSync(replyPath, JSON.stringify(reply));
  const spawned = markFollowUpJobSpawned({ jobPath: claimed.jobPath, spawnedAt: stamp,
    worker: { model: 'codex', processId: 9004, state: 'spawned', workspaceDir: relative(rootDir, workspaceDir),
      outputPath: relative(rootDir, outputPath), replyPath, logPath: relative(rootDir, join(workspaceDir, 'worker.log')) } });
  const job = { ...spawned.job, branch: args.branch, revisionRef: oldHead };
  writeFileSync(claimed.jobPath, JSON.stringify(job));
  const testEnv = { HQ_REPO_ROOT: rootDir, HQ_ROOT: join(rootDir, 'hq'),
    OAUTH_BROKER_SHARED_SECRET_FILE: secretPath,
    ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT: 'true' };
  const previousEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, testEnv);
  globalThis.fetch = args.fetchImpl;
  let rereviews = 0;
  const reconcile = (currentJob) => reconcileFollowUpJob({ rootDir, job: currentJob,
    jobPath: claimed.jobPath, isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => null, postCommentImpl: async () => ({ posted: true }),
    requestRereviewWakeImpl: () => ({ requested: true }),
    requestReviewRereviewImpl: () => {
      rereviews += 1;
      return { triggered: true, status: 'pending' };
    },
    execFileImpl: async (command, argv, options) => {
      if (command === 'git' && !argv.includes('log')) return { stdout: '' };
      if (command === 'gh' && calls.filter((call) => call.type === 'gh').length > 0) {
        const persisted = JSON.parse(readFileSync(claimed.jobPath, 'utf8'));
        assert.equal(persisted.operationalBlockerRecovery.retry.pendingNativePublication.headSha, fixedHead);
        assert.equal(persisted.operationalBlockerRecovery.retry.nativePublicationReceipt, undefined);
      }
      return args.execFileImpl(command, argv, options);
    }, log: quiet,
  });
  const first = await reconcile(job);
  assert.equal(first.action, 'active', first.reason);
  assert.equal(first.reason, 'workflow-publication-verification-pending');
  assert.equal(rereviews, 0);
  const persisted = JSON.parse(readFileSync(claimed.jobPath, 'utf8'));
  assert.equal(persisted.status, 'in_progress');
  assert.deepEqual(persisted.remediationPlan, job.remediationPlan);
  assert.equal(persisted.operationalBlockerRecovery.retry.pushed, false);
  const result = await reconcile(persisted);
  assert.equal(result.action, 'completed');
  assert.equal(result.job.operationalBlockerRecovery.retry.pushed, true);
  assert.equal(result.job.operationalBlockerRecovery.retry.nativePublicationReceipt.headSha, fixedHead);
  assert.equal(rereviews, 1);
  assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(replyPath, 'utf8')), reply);
});

test('WFDRIFT-01: outgoing workflow commits choose scoped transport despite stale job paths', async (t) => {
  const { args, calls, env } = fixture(t);
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.equal(result.workflowPush.source, 'workspace-commits');
  assert.equal(result.workflowPush.provider, 'github-app-merge-agent');
  assert.ok(calls.find((call) => call.type === 'git' && call.argv.includes(oldHead + '..' + fixedHead)));
  assert.equal(env.GH_TOKEN, 'physical-harness-token');
  assert.equal(env.WORKER_CLASS, 'codex');
  assert.equal(JSON.stringify(result).includes('fixture-scoped-token'), false);
});

test('WFDRIFT-01: uncertain, empty, malformed or unrelated outgoing paths never mint or push', async (t) => {
  for (const options of [{ failDiff: true }, { paths: '' }, { paths: 'src/code.mjs\0' },
    { paths: '.github/workflows/repair.yml' }, { killSwitch: true }]) {
    const { args, calls } = fixture(t, options);
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.pushed, false);
    assert.equal(calls.some((call) => ['mint', 'bash'].includes(call.type)), false);
  }
});

test('WFDRIFT-01: broker uncertainty withholds publication', async (t) => {
  const { args, calls } = fixture(t, { brokerFails: true });
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, false);
  assert.equal(calls.filter((call) => call.type === 'mint').length, 1);
  assert.equal(calls.some((call) => call.type === 'bash'), false);
});

test('WFDRIFT-01: existing target never claims a new push and moved heads never publish', async (t) => {
  for (const remote of [fixedHead, 'c'.repeat(40)]) {
    const { args, calls } = fixture(t, { remote });
    const result = await retryGithubAuthPushOnce(args);
    assert.equal(result.pushed, false);
    assert.equal(result.reason, remote === fixedHead ? 'already-published' : 'pr-head-moved');
    assert.equal(calls.some((call) => call.type === 'bash'), false);
  }
});

test('WFDRIFT-01: ambiguous push failure requires a fresh exact target read', async (t) => {
  const { args, calls } = fixture(t, { pushFails: true });
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.equal(result.reason, 'push-succeeded-remote-confirmed');
  assert.equal(calls.filter((call) => call.type === 'bash').length, 1);
  assert.equal(calls.filter((call) => call.type === 'gh').length, 2);
});

test('WFDRIFT-01: ordinary auth recovery preserves the physical entitlement', async (t) => {
  const { args, calls } = fixture(t);
  args.requiresWorkflowPush = false;
  args.env.WORKFLOW_PUSH_SCOPED = '1';
  args.execFileImpl = async (command, argv, options) => {
    calls.push({ type: command });
    assert.equal(command, 'bash');
    assert.equal(options.env.WORKER_CLASS, 'codex');
    assert.equal(options.env.WORKFLOW_PUSH_SCOPED, '0');
    assert.equal(options.env.PUSH_REMOTE, 'origin');
    return { stdout: '' };
  };
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.equal(calls.length, 1);
});

test('WFDRIFT-01: native Git history retains an intermediate workflow edit reverted at the tip', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'wfdrift-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init']);
  git(['config', 'user.name', 'Fixture Worker']);
  git(['config', 'user.email', 'fixture@example.com']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '.']); git(['commit', '-m', 'base']);
  const headBefore = git(['rev-parse', 'HEAD']);
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/repair.yml'), 'name: fixture\n');
  git(['add', '.']); git(['commit', '-m', 'workflow repair']);
  git(['rm', '.github/workflows/repair.yml']); git(['commit', '-m', 'reverted repair']);
  const headAfter = git(['rev-parse', 'HEAD']);
  const { args, calls } = fixture(t, { headBefore, headAfter });
  args.workspaceDir = repo;
  const mocked = args.execFileImpl;
  args.execFileImpl = (command, argv, options) => command === 'git'
    ? execFileAsync(command, argv, options) : mocked(command, argv, options);
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.deepEqual(result.workflowPush.paths, ['.github/workflows/repair.yml']);
  assert.equal(calls.filter((call) => call.type === 'mint').length, 1);
});


test('WFDRIFT-01: native ownership guard is scoped to the workspace across preservation and history reads', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'wfdrift-trusted-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init', '-b', 'feature']); git(['config', 'user.name', 'Fixture Worker']);
  git(['config', 'user.email', 'fixture@example.com']);
  writeFileSync(join(repo, 'base'), 'base\n'); git(['add', '.']); git(['commit', '-m', 'base']);
  const headBefore = git(['rev-parse', 'HEAD']);
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/repair.yml'), 'name: fixture\n');
  git(['add', '.']); git(['commit', '-m', 'workflow repair']);
  const headAfter = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/feature', headBefore]);
  git(['replace', headAfter, headBefore]);
  const guardEnv = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0' };
  await assert.rejects(execFileAsync('git', ['-C', repo, 'cat-file', '-e', headAfter + '^{commit}'],
    { env: guardEnv, timeout: 15000 }), /dubious ownership|unsafe repository/i);
  const rawCalls = [];
  const nativeGit = (command, argv, options = {}) => {
    rawCalls.push(argv);
    return execFileAsync(command, argv, { ...options, env: guardEnv });
  };
  const preserved = await preserveUnpushedCommit({ hqRoot: join(repo, 'hq'), workspaceDir: repo,
    repo: 'example/repo', prNumber: 42, jobId: 'fixture-job', commitSha: headAfter,
    observedAt: '2026-10-09T03:15:00.000Z', execFileImpl: nativeGit });
  assert.equal(preserved.preserved, true);
  assert.match((await execFileAsync('git', ['bundle', 'list-heads', preserved.path])).stdout, new RegExp(headAfter));
  const { args } = fixture(t, { headBefore, headAfter });
  const mocked = args.execFileImpl;
  args.workspaceDir = repo; args.branch = ''; args.expectedRemoteSha = null;
  args.execFileImpl = (command, argv, options) => command === 'git'
    ? nativeGit(command, argv, options) : mocked(command, argv, options);
  const recovered = await retryGithubAuthPushOnce(args);
  assert.equal(recovered.pushed, true);
  assert.deepEqual(recovered.workflowPush.paths, ['.github/workflows/repair.yml'],
    'replacement refs cannot hide actual outgoing workflow history');
  assert.equal(rawCalls.length, 8, 'cat-file, two update-ref, two bundle, log and two rev-parse siblings');
  for (const argv of rawCalls) {
    assert.ok(argv.includes('--no-replace-objects'));
    assert.ok(argv.includes('safe.directory=' + resolve(repo)));
    assert.equal(argv.includes('safe.directory=*'), false);
  }
});

test('WFDRIFT-01: authentic localized Git suffix never relaxes native publication proof', async (t) => {
  const { args } = fixture(t);
  const mocked = args.execFileImpl;
  args.execFileImpl = async (command, argv, options) => {
    const result = await mocked(command, argv, options);
    // The phrase is Git's French gettext translation. The installed Git's
    // native forced-push line remained English; this is a refusal fixture.
    return command === 'bash' ? { stdout: '', stderr: ' + ' + oldHead.slice(0, 7) + '...'
      + fixedHead.slice(0, 7) + ' fixture -> feature (mise à jour forcée)\n' } : result;
  };
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, false);
  assert.equal(result.reason, 'publication-observed-without-native-update-proof');
  assert.equal(result.nativePublicationReceipt, undefined);
});

test('WFDRIFT-01: scoped push shell never reselects physical credentials', async (t) => {
  const { args, calls, env } = fixture(t);
  const marker = join(env.HQ_REPO_ROOT, 'shell-marker');
  const shim = join(env.HQ_REPO_ROOT, 'modules/worker-pool/bin/git-safe');
  writeFileSync(shim, '#!/bin/sh\n[ "$GH_TOKEN" = ghs_fixture-scoped-token ] || exit 71\n[ "$WORKER_CLASS" = merge-agent ] || exit 72\n[ "$GIT_CONFIG_VALUE_1" = "!gh auth git-credential" ] || exit 73\n[ "$LC_ALL:$LANG:$LANGUAGE" = C:C:C ] || exit 75\ntouch "$SHELL_MARKER"\necho "$EXPECTED_REMOTE_SHA..$COMMIT_SHA fixture -> $TARGET_BRANCH" >&2\n');
  chmodSync(shim, 0o755);
  writeFileSync(join(env.HQ_REPO_ROOT, 'modules/worker-pool/lib/hq-gh.sh'), 'exit 74\n');
  args.env = { ...env, SHELL_MARKER: marker, LC_ALL: 'fr_FR.UTF-8',
    LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr', LC_MESSAGES: 'fr_FR.UTF-8' };
  const mocked = args.execFileImpl;
  args.execFileImpl = async (command, argv, options) => {
    const result = await mocked(command, argv, options);
    return command === 'bash' ? execFileAsync(command, argv, options) : result;
  };
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.equal(existsSync(marker), true);
  assert.equal(args.env.LC_ALL, 'fr_FR.UTF-8', 'publisher locale is isolated from its parent');
  assert.equal(calls.filter((call) => call.type === 'mint').length, 1);
});

test('WFDRIFT-01: reconcile preserves bundle, final-round suppression and the 2/2 cap', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'wfdrift-reconcile-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init']); git(['config', 'user.name', 'Fixture Worker']);
  git(['config', 'user.email', 'fixture@example.com']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '.']); git(['commit', '-m', 'base']);
  const headBefore = git(['rev-parse', 'HEAD']);
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/repair.yml'), 'name: fixture\n');
  git(['add', '.']); git(['commit', '-m', 'workflow repair']);
  const headAfter = git(['rev-parse', 'HEAD']);
  const f = fixture(t, { headBefore, headAfter });
  let retryRequests = 0;
  const job = { repo: 'example/repo', prNumber: 42, jobId: 'fixture-job', branch: 'feature',
    revisionRef: headBefore, changedPaths: ['base.txt'], finalRound: 'comment-only',
    remediationPlan: { currentRound: 2, maxRounds: 2 } };
  const result = await recoverGithubAuthOperationalBlocker({
    reply: { operationalBlockers: [{ title: 'github-auth', commitSha: headAfter,
      expectedRemoteSha: headBefore, reasoning: 'GitHub rejected the workflow repair without workflows permission.' }] },
    hqRoot: join(repo, 'hq'), workspaceDir: repo, job, worker: { model: 'codex' },
    completedAt: '2026-10-09T01:30:00.000Z', rootDir: repo,
    resolveWorkerClass: () => 'codex', buildRereviewResult: () => { throw new Error('no rereview'); },
    requestReviewRereviewImpl: () => { throw new Error('no rereview'); },
    execFileImpl: execFileAsync, env: f.env,
    retryGithubAuthPushOnceImpl: async (params) => {
      retryRequests += 1;
      assert.equal(params.requiresWorkflowPush, true);
      assert.equal(params.commitSha, headAfter);
      return retryGithubAuthPushOnce({ ...f.args, ...params,
        fetchImpl: f.args.fetchImpl, readFileImpl: f.args.readFileImpl,
        execFileImpl: f.args.execFileImpl, retryDelaysMs: [] });
    },
  });
  assert.equal(retryRequests, 1);
  assert.equal(result.operationalBlockerRecovery.rescue.preserved, true);
  assert.equal(result.operationalBlockerRecovery.retry.pushed, true);
  assert.equal(result.rereview, null);
  assert.deepEqual(result.job.remediationPlan, { currentRound: 2, maxRounds: 2 });
  assert.equal(result.job.completion, undefined);
});

test('WFDRIFT-01: extraction selects preserved work rather than the preceding explicit lease', () => {
  assert.equal(extractCommitShaFromOperationalBlocker({ title: 'github-auth', expectedRemoteSha: oldHead,
    reasoning: 'Lease used ' + oldHead + '. Local remediation is preserved through ' + fixedHead + '.' }), fixedHead);
  assert.equal(extractCommitShaFromOperationalBlocker({ title: 'github-auth', expectedRemoteSha: oldHead,
    reasoning: 'Lease ' + oldHead + '; local commits ' + fixedHead + ' and ' + 'c'.repeat(40) }), null);
});

test('WFDRIFT-01: operator publication during an unsuccessful native push never gets a native receipt', async (t) => {
  const { args } = fixture(t);
  const mocked = args.execFileImpl;
  args.execFileImpl = async (command, argv, options) => {
    if (command === 'bash') {
      await mocked(command, argv, options);
      throw Object.assign(new Error('native push rejected; another owner published'), { stderr: 'stale info' });
    }
    return mocked(command, argv, options);
  };
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, false);
  assert.equal(result.reason, 'publication-observed-without-native-update-proof');
  assert.equal(result.nativePublicationReceipt, undefined);
});
