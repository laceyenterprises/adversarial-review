import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGithubAuthOperationalBlocker, extractCommitShaFromOperationalBlocker, recoverGithubAuthOperationalBlocker, retryGithubAuthPushOnce } from '../src/github-auth-recovery.mjs';

const execFileAsync = promisify(execFile);
const oldHead = 'a'.repeat(40);
const fixedHead = 'b'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };

function fixture(t, { paths = '.github/workflows/repair.yml\0', remote, headBefore = oldHead, headAfter = fixedHead,
  brokerFails = false, pushFails = false, failDiff = false, killSwitch = false } = {}) {
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
      if (command === 'gh') return { stdout: observedHead + '\n' };
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

test('WFDRIFT-01: scoped push shell never reselects physical credentials', async (t) => {
  const { args, calls, env } = fixture(t);
  const marker = join(env.HQ_REPO_ROOT, 'shell-marker');
  const shim = join(env.HQ_REPO_ROOT, 'modules/worker-pool/bin/git-safe');
  writeFileSync(shim, '#!/bin/sh\n[ "$GH_TOKEN" = ghs_fixture-scoped-token ] || exit 71\n[ "$WORKER_CLASS" = merge-agent ] || exit 72\n[ "$GIT_CONFIG_VALUE_1" = "!gh auth git-credential" ] || exit 73\ntouch "$SHELL_MARKER"\necho "$EXPECTED_REMOTE_SHA..$COMMIT_SHA fixture -> $TARGET_BRANCH" >&2\n');
  chmodSync(shim, 0o755);
  writeFileSync(join(env.HQ_REPO_ROOT, 'modules/worker-pool/lib/hq-gh.sh'), 'exit 74\n');
  args.env = { ...env, SHELL_MARKER: marker };
  const mocked = args.execFileImpl;
  args.execFileImpl = async (command, argv, options) => {
    const result = await mocked(command, argv, options);
    return command === 'bash' ? execFileAsync(command, argv, options) : result;
  };
  const result = await retryGithubAuthPushOnce(args);
  assert.equal(result.pushed, true);
  assert.equal(existsSync(marker), true);
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
