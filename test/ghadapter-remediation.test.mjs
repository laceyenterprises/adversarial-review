import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyMergeAgentBrokerEnv, installWorkerAdapterEnv } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { retryGithubAuthPushOnce } from '../src/github-auth-recovery.mjs';

const execFileAsync = promisify(execFile);

function fakeAgentOs(prefix = join(tmpdir(), 'ghadapter-')) {
  const root = mkdtempSync(prefix);
  const lib = join(root, 'modules/worker-pool/lib');
  const shims = join(lib, 'shims');
  const bin = join(root, 'modules/worker-pool/bin');
  mkdirSync(shims, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of ['gh', 'git-safe']) {
    const file = join(shims, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  writeFileSync(join(lib, 'hq-gh.sh'), 'hq_resolve_worker_class_gh_token() { export HQ_ENTITLEMENT_GH_TOKEN=fresh-token; }\n');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(bin, 'git-safe'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'git-safe'), 0o755);
  return { root, shims, bin };
}

test('each remediation harness resolves gh and git-safe from the agent-os shims', () => {
  const { root, shims } = fakeAgentOs();
  for (const [physical, trailer] of [
    ['codex', 'codex-remediation'],
    ['claude-code', 'claude-code-remediation'],
    ['gemini', 'gemini-remediation'],
  ]) {
    const env = { PATH: '/usr/bin:/bin' };
    installWorkerAdapterEnv(env, { HQ_REPO_ROOT: root }, physical, trailer, 'example/repo');
    assert.equal(env.WORKER_CLASS, physical);
    assert.equal(env.WORKER_TRAILER_CLASS, trailer);
    assert.ok(env.HQ_ENTITLEMENT_GH_TOKEN_VAR?.endsWith('_WORKER_GH_TOKEN'));
    assert.equal(env.GITHUB_REPOSITORY, 'example/repo');
    for (const command of ['gh', 'git-safe']) {
      assert.equal(execFileSync('/usr/bin/which', [command], { env, encoding: 'utf8' }).trim(), join(shims, command));
    }
  }
  const workflowEnv = { PATH: '/usr/bin:/bin' };
  installWorkerAdapterEnv(workflowEnv, { HQ_REPO_ROOT: root }, 'codex', 'codex-remediation', 'example/repo', console, { requiresWorkflowPush: true });
  assert.equal(workflowEnv.WORKER_CLASS, 'merge-agent');
  assert.equal(workflowEnv.HQ_ENTITLEMENT_GH_TOKEN_VAR, 'MERGE_AGENT_GH_TOKEN');
  assert.equal(workflowEnv.WORKER_TRAILER_CLASS, 'codex-remediation');
});

test('workflow-push kill switch keeps the physical worker entitlement', () => {
  const { root } = fakeAgentOs();
  const sourceEnv = {
    HQ_REPO_ROOT: root,
    MERGE_AGENT_AUTH_VIA_BROKER: 'true',
    ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT: 'false',
    ADVERSARIAL_REMEDIATION_WORKER_REQUIRES_WORKFLOW_PUSH: 'true',
  };
  const env = { PATH: '/usr/bin:/bin' };
  const evidence = applyMergeAgentBrokerEnv(env, sourceEnv, { workerClass: 'codex', requiresWorkflowPush: true });
  installWorkerAdapterEnv(env, sourceEnv, 'codex', 'codex-remediation', 'example/repo', console, evidence);
  assert.equal(Boolean(evidence.requiresWorkflowPush), false);
  assert.equal(evidence.provider, 'github-app-codex-agent');
  assert.equal(env.WORKER_CLASS, 'codex');
  assert.equal(env.HQ_ENTITLEMENT_GH_TOKEN_VAR, 'CODEX_WORKER_GH_TOKEN');
});

test('missing shims warn on every spawn and do not claim a fresh token mint', () => {
  const sourceEnv = { HQ_REPO_ROOT: '/nonexistent/agent-os' };
  const warnings = [];
  const log = { warn: (message) => warnings.push(message) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const env = { PATH: '/usr/bin:/bin', WORKER_CLASS: 'codex-remediation' };
    installWorkerAdapterEnv(env, sourceEnv, 'codex', 'codex-remediation', 'example/repo', log);
    assert.equal(env.WORKER_CLASS, 'codex-remediation');
  }
  assert.equal(warnings.length, 2);
  const { root } = fakeAgentOs();
  const env = { PATH: '/usr/bin:/bin', HQ_WORKER_TOKEN_MINTED_AT: 'stale-value' };
  installWorkerAdapterEnv(env, { HQ_REPO_ROOT: root }, 'codex', 'codex-remediation', 'example/repo');
  assert.equal(env.HQ_WORKER_TOKEN_MINTED_AT, undefined);
});

test('worker git-safe push replaces an expired spawn token through the credential helper', () => {
  const { root, shims } = fakeAgentOs();
  const helper = join(root, 'mock-push-credential');
  const pushed = join(root, 'pushed');
  writeFileSync(helper, '#!/bin/sh\n[ "$WORKER_CLASS" = codex ] || exit 75\nprintf "export GH_TOKEN=fresh-token\\nexport GITHUB_TOKEN=fresh-token\\n"\n');
  chmodSync(helper, 0o755);
  writeFileSync(join(shims, 'git-safe'), '#!/bin/sh\nplan=$("$AGENT_OS_WORKER_PUSH_CREDENTIAL_HELPER") || exit 75\neval "$plan"\n[ "$GH_TOKEN" = fresh-token ] || exit 76\n[ "$GITHUB_TOKEN" = fresh-token ] || exit 77\ntouch "$PUSH_MARKER"\n');
  chmodSync(join(shims, 'git-safe'), 0o755);
  const env = {
    ...process.env,
    GH_TOKEN: 'expired-token',
    GITHUB_TOKEN: 'expired-token',
    AGENT_OS_WORKER_PUSH_CREDENTIAL_HELPER: helper,
    PUSH_MARKER: pushed,
  };
  installWorkerAdapterEnv(env, { HQ_REPO_ROOT: root }, 'codex', 'codex-remediation', 'example/repo');
  execFileSync('git-safe', ['push', 'origin', 'HEAD'], { env });
  assert.equal(existsSync(pushed), true);
});

test('expired spawn token is replaced before recovery push and missing branch comes from workspace', async () => {
  const { root, bin } = fakeAgentOs();
  const push = join(bin, 'git-safe');
  writeFileSync(push, '#!/bin/sh\n[ "$GH_TOKEN" = fresh-token ] || exit 75\n[ "$GITHUB_TOKEN" = fresh-token ] || exit 75\n[ "$EXPECTED_REMOTE_SHA" = "$EXPECTED" ] || exit 76\ncase " $* " in *--force-with-lease=refs/heads/feature/fix:*) exit 0;; esac\nexit 77\n');
  chmodSync(push, 0o755);
  const calls = [];
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    branch: null,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root, GH_TOKEN: 'expired-token', EXPECTED: 'b'.repeat(40) },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args });
      if (command === 'git') return { stdout: 'feature/fix\n' };
      return execFileAsync(command, args, options);
    },
  });
  assert.equal(result.pushed, true);
  assert.equal(calls[0].command, 'git');
  assert.ok(calls.at(-1).args[1].includes('--force-with-lease='));
  assert.ok(!calls.at(-1).args[1].includes('merge-base'));
  assert.deepEqual(calls[0].args.slice(-3), ['rev-parse', '--abbrev-ref', 'HEAD']);
});

test('moved PR head is rejected by the lease on the recovery push', async () => {
  const { root, bin } = fakeAgentOs();
  const marker = join(root, 'pushed');
  writeFileSync(join(bin, 'git-safe'), `#!/bin/sh\ntouch '${marker}'\necho 'stale info' >&2\nexit 1\n`);
  chmodSync(join(bin, 'git-safe'), 0o755);
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    branch: 'feature/fix',
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root },
  });
  assert.equal(result.reason, 'pr-head-moved');
  assert.equal(result.pushed, false);
  assert.equal(existsSync(marker), true);
});

test('recovery publishes a rebased commit whose old PR head is not its ancestor', async (t) => {
  const { root, bin } = fakeAgentOs();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const workspace = join(root, 'workspace');
  const git = (args, cwd = workspace) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '--bare', remote], root);
  git(['clone', remote, workspace], root);
  git(['config', 'user.name', 'Test Worker']);
  git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(workspace, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  git(['branch', '-M', 'main']);
  git(['push', '-u', 'origin', 'main']);
  git(['switch', '-c', 'feature']);
  writeFileSync(join(workspace, 'feature.txt'), 'before rebase\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature']);
  const oldHead = git(['rev-parse', 'HEAD']);
  git(['push', '-u', 'origin', 'feature']);
  git(['switch', 'main']);
  writeFileSync(join(workspace, 'base.txt'), 'main advanced\n');
  git(['commit', '-am', 'main advanced']);
  git(['push', 'origin', 'main']);
  git(['switch', 'feature']);
  git(['rebase', 'main']);
  writeFileSync(join(workspace, 'fix.txt'), 'remediation\n');
  git(['add', '.']);
  git(['commit', '-m', 'remediation']);
  const rescuedHead = git(['rev-parse', 'HEAD']);
  assert.throws(() => git(['merge-base', '--is-ancestor', oldHead, rescuedHead]));
  writeFileSync(join(bin, 'git-safe'), '#!/bin/sh\nexec git "$@"\n');
  chmodSync(join(bin, 'git-safe'), 0o755);

  const result = await retryGithubAuthPushOnce({
    workspaceDir: workspace,
    workerClass: 'codex',
    branch: 'feature',
    commitSha: rescuedHead,
    expectedRemoteSha: oldHead,
    env: { ...process.env, HQ_REPO_ROOT: root },
  });
  assert.equal(result.pushed, true);
  assert.equal(git(['rev-parse', 'refs/heads/feature'], remote), rescuedHead);
});

test('detached workspace resolves PR head through the gh shim', async () => {
  const { root, shims, bin } = fakeAgentOs();
  writeFileSync(join(shims, 'gh'), '#!/bin/sh\n[ "$GH_TOKEN" = fresh-token ] || exit 75\nprintf "feature/from-gh\\n"\n');
  chmodSync(join(shims, 'gh'), 0o755);
  writeFileSync(join(bin, 'git-safe'), '#!/bin/sh\n[ "$TARGET_BRANCH" = feature/from-gh ]\n');
  chmodSync(join(bin, 'git-safe'), 0o755);
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    branch: null,
    repo: 'example/repo',
    prNumber: 42,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root, GH_TOKEN: 'expired-token' },
    execFileImpl: async (command, args, options) => {
      if (command === 'git') return { stdout: 'HEAD\n' };
      return execFileAsync(command, args, options);
    },
  });
  assert.equal(result.pushed, true);
});

test('detached branch lookup retries a transient gh timeout before pushing', async () => {
  const { root } = fakeAgentOs();
  const calls = [];
  const delays = [];
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    repo: 'example/repo',
    prNumber: 42,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, HQ_REPO_ROOT: root },
    retryDelaysMs: [1],
    sleepImpl: async (ms) => { delays.push(ms); },
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (command === 'git') return { stdout: 'HEAD\n' };
      if (args[1].includes('pr view')) {
        if (calls.filter((call) => call.args[1]?.includes('pr view')).length === 1) {
          const err = new Error('TLS handshake timeout');
          err.stderr = 'TLS handshake timeout';
          throw err;
        }
        return { stdout: 'feature/rebased\n' };
      }
      return { stdout: '' };
    },
  });
  assert.equal(result.pushed, true);
  assert.equal(calls.filter((call) => call.args[1]?.includes('pr view')).length, 2);
  assert.deepEqual(delays, [1]);
});

test('detached branch lookup reports definitive 404 without retry', async () => {
  const { root } = fakeAgentOs();
  let viewCalls = 0;
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    repo: 'example/repo',
    prNumber: 42,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, HQ_REPO_ROOT: root },
    retryDelaysMs: [1],
    execFileImpl: async (command) => {
      if (command === 'git') return { stdout: 'HEAD\n' };
      viewCalls += 1;
      const err = new Error('HTTP 404: Not Found');
      err.stderr = 'HTTP 404: Not Found';
      throw err;
    },
  });
  assert.equal(result.reason, 'pr-lookup-not-found');
  assert.equal(result.workerClass, 'codex');
  assert.match(result.error, /HTTP 404/);
  assert.equal(viewCalls, 1);
});

test('an empty head branch from a successful lookup reports missing-pr-branch', async () => {
  const { root } = fakeAgentOs();
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    repo: 'example/repo',
    prNumber: 42,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, HQ_REPO_ROOT: root },
    execFileImpl: async (command) => (command === 'git' ? { stdout: 'HEAD\n' } : { stdout: 'null\n' }),
  });
  assert.equal(result.reason, 'missing-pr-branch');
});

test('recovery reports each missing adapter file instead of a credential failure', async () => {
  for (const missing of ['modules/worker-pool/lib/hq-gh.sh', 'modules/worker-pool/lib/shims/gh', 'modules/worker-pool/bin/git-safe']) {
    const { root } = fakeAgentOs();
    rmSync(join(root, missing));
    let execCalls = 0;
    const result = await retryGithubAuthPushOnce({
      workspaceDir: '/unused/workspace',
      workerClass: 'codex',
      branch: 'feature/fix',
      commitSha: 'a'.repeat(40),
      expectedRemoteSha: 'b'.repeat(40),
      env: { ...process.env, HQ_REPO_ROOT: root },
      execFileImpl: async () => { execCalls += 1; return { stdout: '' }; },
    });
    assert.equal(result.reason, 'missing-gh-adapter');
    assert.deepEqual(result.missingAdapterFiles, [missing]);
    assert.equal(execCalls, 0);
  }
});

test('recovery passes the agent-os root through env, so shell metacharacters in the path stay inert', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ghadapter-meta-'));
  const weird = join(parent, 'root "$(touch pwned)" `x`');
  mkdirSync(weird);
  const { root, shims, bin } = fakeAgentOs(join(weird, 'agent-os-'));
  writeFileSync(join(shims, 'gh'), '#!/bin/sh\nprintf "feature/from-gh\\n"\n');
  chmodSync(join(shims, 'gh'), 0o755);
  writeFileSync(join(bin, 'git-safe'), '#!/bin/sh\n[ "$TARGET_BRANCH" = feature/from-gh ]\n');
  chmodSync(join(bin, 'git-safe'), 0o755);
  const result = await retryGithubAuthPushOnce({
    workspaceDir: parent,
    workerClass: 'codex',
    branch: null,
    repo: 'example/repo',
    prNumber: 42,
    commitSha: 'a'.repeat(40),
    expectedRemoteSha: 'b'.repeat(40),
    env: { ...process.env, HQ_REPO_ROOT: root },
    execFileImpl: async (command, args, options) => {
      if (command === 'git') return { stdout: 'HEAD\n' };
      assert.ok(!args[1].includes(root), 'script must reference $AGENT_OS_ROOT, not the interpolated path');
      assert.equal(options.env.AGENT_OS_ROOT, root);
      return execFileAsync(command, args, { ...options, cwd: parent });
    },
  });
  assert.equal(result.pushed, true);
  assert.equal(existsSync(join(parent, 'pwned')), false);
});

test('recovery lease falls back to the workspace tracking ref, then the reviewed revision', async (t) => {
  const { root, bin } = fakeAgentOs();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const workspace = join(root, 'workspace');
  const git = (args, cwd = workspace) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '--bare', remote], root);
  git(['clone', remote, workspace], root);
  git(['config', 'user.name', 'Test Worker']);
  git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(workspace, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  git(['branch', '-M', 'feature']);
  git(['push', '-u', 'origin', 'feature']);
  const fetchedHead = git(['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, 'fix.txt'), 'remediation\n');
  git(['add', '.']);
  git(['commit', '-m', 'remediation']);
  const rescuedHead = git(['rev-parse', 'HEAD']);
  writeFileSync(join(bin, 'git-safe'), '#!/bin/sh\nexec git "$@"\n');
  chmodSync(join(bin, 'git-safe'), 0o755);

  // No blocker SHA: the stale reviewed revision must lose to the ref the
  // worker actually fetched.
  const result = await retryGithubAuthPushOnce({
    workspaceDir: workspace,
    workerClass: 'codex',
    branch: 'feature',
    commitSha: rescuedHead,
    expectedRemoteSha: null,
    fallbackRemoteSha: 'c'.repeat(40),
    env: { ...process.env, HQ_REPO_ROOT: root },
  });
  assert.equal(result.pushed, true);
  assert.equal(git(['rev-parse', 'refs/heads/feature'], remote), rescuedHead);

  const noTrackingRef = await retryGithubAuthPushOnce({
    workspaceDir: workspace,
    workerClass: 'codex',
    branch: 'no-such-branch',
    commitSha: rescuedHead,
    expectedRemoteSha: null,
    fallbackRemoteSha: null,
    env: { ...process.env, HQ_REPO_ROOT: root },
  });
  assert.equal(noTrackingRef.reason, 'missing-expected-remote-head');
  assert.equal(noTrackingRef.pushed, false);

  const pushes = [];
  const revisionFallback = await retryGithubAuthPushOnce({
    workspaceDir: workspace,
    workerClass: 'codex',
    branch: 'no-such-branch',
    commitSha: rescuedHead,
    expectedRemoteSha: 'not-a-sha',
    fallbackRemoteSha: fetchedHead,
    env: { ...process.env, HQ_REPO_ROOT: root },
    execFileImpl: async (command, args, options) => {
      if (command === 'git') return execFileAsync(command, args, options);
      pushes.push(options.env.EXPECTED_REMOTE_SHA);
      return { stdout: '' };
    },
  });
  assert.equal(revisionFallback.pushed, true);
  assert.deepEqual(pushes, [fetchedHead]);
});

test('adapter env keeps a known token expiry and drops only the inherited mint time', () => {
  const { root } = fakeAgentOs();
  const env = {
    PATH: '/usr/bin:/bin',
    GITHUB_TOKEN: 'inherited-token',
    GH_TOKEN_EXPIRES_AT: '2026-09-27T06:00:00Z',
    CODEX_WORKER_GH_TOKEN_EXPIRES_AT: '2026-09-27T06:00:00Z',
    HQ_WORKER_TOKEN_MINTED_AT: '2026-09-20T00:00:00Z',
  };
  installWorkerAdapterEnv(env, { HQ_REPO_ROOT: root }, 'codex', 'codex-remediation', 'example/repo');
  assert.equal(env.GH_TOKEN, 'inherited-token');
  assert.equal(env.GH_TOKEN_EXPIRES_AT, '2026-09-27T06:00:00Z');
  assert.equal(env.CODEX_WORKER_GH_TOKEN_EXPIRES_AT, '2026-09-27T06:00:00Z');
  assert.equal(env.HQ_ENTITLEMENT_GH_TOKEN_VAR, 'CODEX_WORKER_GH_TOKEN');
  assert.equal(env.HQ_WORKER_TOKEN_MINTED_AT, undefined);
});
