import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { installWorkerAdapterEnv } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { retryGithubAuthPushOnce } from '../src/github-auth-recovery.mjs';

const execFileAsync = promisify(execFile);

function fakeAgentOs() {
  const root = mkdtempSync(join(tmpdir(), 'ghadapter-'));
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
  installWorkerAdapterEnv(workflowEnv, { HQ_REPO_ROOT: root }, 'codex', 'codex-remediation', 'example/repo', console, true);
  assert.equal(workflowEnv.WORKER_CLASS, 'merge-agent');
  assert.equal(workflowEnv.HQ_ENTITLEMENT_GH_TOKEN_VAR, 'MERGE_AGENT_GH_TOKEN');
  assert.equal(workflowEnv.WORKER_TRAILER_CLASS, 'codex-remediation');
});

test('expired spawn token is replaced before recovery push and missing branch comes from workspace', async () => {
  const { root, bin } = fakeAgentOs();
  const push = join(bin, 'git-safe');
  writeFileSync(push, '#!/bin/sh\n[ "$GH_TOKEN" = fresh-token ] || exit 75\n[ "$GITHUB_TOKEN" = fresh-token ] || exit 75\ncase " $* " in *--force*) exit 76;; esac\nexit 0\n');
  chmodSync(push, 0o755);
  const calls = [];
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    branch: null,
    commitSha: 'a'.repeat(40),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root, GH_TOKEN: 'expired-token' },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args });
      if (command === 'git') return { stdout: 'feature/fix\n' };
      return execFileAsync(command, args, options);
    },
  });
  assert.equal(result.pushed, true);
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args.slice(-3), ['rev-parse', '--abbrev-ref', 'HEAD']);
});

test('moved PR head refuses recovery push and never invokes git-safe', async () => {
  const { root, bin } = fakeAgentOs();
  const marker = join(root, 'pushed');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\n[ "$3" = merge-base ] && exit 1\nexit 0\n');
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(bin, 'git-safe'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
  chmodSync(join(bin, 'git-safe'), 0o755);
  const result = await retryGithubAuthPushOnce({
    workspaceDir: '/unused/workspace',
    workerClass: 'codex',
    branch: 'feature/fix',
    commitSha: 'a'.repeat(40),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root },
  });
  assert.equal(result.reason, 'pr-head-moved');
  assert.equal(result.pushed, false);
  assert.equal(existsSync(marker), false);
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HQ_REPO_ROOT: root, GH_TOKEN: 'expired-token' },
    execFileImpl: async (command, args, options) => {
      if (command === 'git') return { stdout: 'HEAD\n' };
      return execFileAsync(command, args, options);
    },
  });
  assert.equal(result.pushed, true);
});
