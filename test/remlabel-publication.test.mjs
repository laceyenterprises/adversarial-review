import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned } from '../src/follow-up-jobs.mjs';

const execAsync = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sample Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid',
  GIT_COMMITTER_NAME: 'Sample Worker', GIT_COMMITTER_EMAIL: 'worker@example.invalid' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remlabel-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  mkdirSync(work);
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(work, 'feature.txt'), 'base\n');
  git('add', 'feature.txt'); git('commit', '-m', 'Create sample base');
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  git('checkout', '-b', 'topic');
  writeFileSync(join(work, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt'); git('commit', '-m', 'Create sample feature');
  const previousHead = git('rev-parse', 'HEAD');
  git('push', 'origin', 'topic');
  return { work, git, previousHead, publish: { workspaceDir: work, baseBranch: 'main', branch: 'topic', previousHead, pushCommand: 'git', env } };
}

for (const unrelatedFile of [false, true]) {
  test(`REMLABEL-01: emptying remediation is refused before push (unrelated file: ${unrelatedFile})`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.work, 'feature.txt'), 'base\n');
    if (unrelatedFile) { writeFileSync(join(f.work, 'notes.txt'), 'unrelated\n'); f.git('add', 'notes.txt'); }
    f.git('add', 'feature.txt'); f.git('commit', '-m', 'Restore sample files');
    let pushCalls = 0;
    await assert.rejects(publishRemediation({ ...f.publish, execFileImpl: async (cmd, args, opts) => {
      if (args.includes('push')) pushCalls++;
      return execAsync(cmd, args, opts);
    } }), { code: 'remediation-empties-pr-diff' });
    assert.equal(pushCalls, 0);
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.previousHead);
  });
}

test('REMLABEL-01: publication CLI persists the refusal before exiting with the old remote head intact', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'base\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Restore sample files');
  const failurePath = join(f.work, 'publication-failure.json');
  await assert.rejects(execAsync(process.execPath, [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
    '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead, '--failure-path', failurePath],
  { cwd: f.work, env }), error => /remediation-empties-pr-diff/.test(error.stderr));
  const failure = JSON.parse(readFileSync(failurePath));
  assert.equal(failure.code, 'remediation-empties-pr-diff');
  assert.equal(failure.previousHead, f.previousHead);
  assert.equal(failure.localCommit, f.git('rev-parse', 'HEAD'));
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.previousHead);
});

test('REMLABEL-01: a real remediation preserving a changed file publishes normally', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
  const result = await publishRemediation(f.publish);
  assert.equal(result.headSha, f.git('rev-parse', 'HEAD'));
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], result.headSha);
});

test('REMLABEL-01: a competing remote head is preserved by the publisher lease', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'competing feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Advance sample remote');
  f.git('push', 'origin', 'topic');
  const competing = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
  await assert.rejects(publishRemediation(f.publish));
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], competing);
});

test('REMLABEL-01: publisher refreshes a stale base before refusing restoration', async t => {
  const f = fixture(t);
  f.git('checkout', 'main');
  writeFileSync(join(f.work, 'feature.txt'), 'new base\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Advance sample base');
  f.git('push', 'origin', 'main');
  f.git('checkout', 'topic');
  writeFileSync(join(f.work, 'feature.txt'), 'new base\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Restore current sample base');
  await assert.rejects(publishRemediation(f.publish), { code: 'remediation-empties-pr-diff' });
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.previousHead);
});

test('REMLABEL-01: refusal artifact marks a remediation round failed without requesting review', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remlabel-failed-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const priorEnv = { HQ_ROOT: process.env.HQ_ROOT, AGENT_OS_DEPLOY_CHECKOUT: process.env.AGENT_OS_DEPLOY_CHECKOUT,
    ADV_WITH_HQ_INTEGRATION: process.env.ADV_WITH_HQ_INTEGRATION,
    ADV_REPLIES_ROOT: process.env.ADV_REPLIES_ROOT, ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT: process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT };
  delete process.env.HQ_ROOT; delete process.env.ADV_WITH_HQ_INTEGRATION; delete process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT;
  // Keep the fixture independent of the host's deployed checkout, including
  // when its temporary root lives beneath that checkout.
  process.env.AGENT_OS_DEPLOY_CHECKOUT = join(rootDir, 'fixture-deploy-checkout');
  process.env.ADV_REPLIES_ROOT = join(rootDir, 'replies');
  t.after(() => { for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const head = 'a'.repeat(40);
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/repo', prNumber: 1, revisionRef: head,
    reviewBody: '## Blocking issues\n- **Fix feature** — fix it.\n## Verdict\nRequest changes',
    reviewerModel: 'claude', reviewPostedAt: '2026-10-16T12:00:00Z' });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-10-16T12:01:00Z' });
  const workspaceDir = join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const replyPath = join(process.env.ADV_REPLIES_ROOT, claimed.job.jobId, 'remediation-reply.json');
  mkdirSync(join(process.env.ADV_REPLIES_ROOT, claimed.job.jobId), { recursive: true });
  writeFileSync(`${replyPath}.publication-failure.json`, JSON.stringify({ code: 'remediation-empties-pr-diff', previousHead: head }));
  const outputPath = join(artifactDir, 'last-message.md');
  writeFileSync(outputPath, 'Publication refused.');
  const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: '2026-10-16T12:01:01Z',
    worker: { processId: 12345, workspaceDir: relative(rootDir, workspaceDir),
      outputPath: relative(rootDir, outputPath), logPath: relative(rootDir, join(artifactDir, 'worker.log')), replyPath } });
  let reviews = 0;
  const result = await reconcileFollowUpJob({ rootDir, job: spawned.job, jobPath: spawned.jobPath,
    now: () => '2026-10-16T12:03:00Z', isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => { throw new Error('refusal must settle before lifecycle recovery'); },
    postCommentImpl: async () => ({ posted: true }), requestReviewRereviewImpl: () => { reviews++; },
    log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.action, 'failed');
  assert.equal(result.job.failure.code, 'remediation-empties-pr-diff');
  assert.equal(reviews, 0);
  assert.equal(JSON.parse(readFileSync(result.jobPath)).status, 'failed');
});


test('REMLABEL-01: missing branch metadata refuses publication before any Git operation', async () => {
  for (const metadata of [{ baseBranch: 'main' }, { branch: 'topic' }]) {
    await assert.rejects(publishRemediation({ ...metadata, previousHead: 'a'.repeat(40),
      execFileImpl: async () => { assert.fail('invalid metadata must not reach Git'); } }),
    { code: 'remediation-publication-unproven' });
  }
});

for (const shim of ['absent', 'executable', 'non-executable']) {
  test(`publication selects a usable push executable (git-safe: ${shim})`, async t => {
    const f = fixture(t);
    const pathDir = join(f.work, 'path');
    mkdirSync(pathDir);
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    symlinkSync(gitPath, join(pathDir, 'git'));
    if (shim !== 'absent') {
      writeFileSync(join(pathDir, 'git-safe'), '#!/bin/sh\nexec git "$@"\n');
      chmodSync(join(pathDir, 'git-safe'), shim === 'executable' ? 0o755 : 0o644);
    }
    let push;
    const result = await publishRemediation({ ...f.publish, pushCommand: undefined,
      env: { ...env, PATH: pathDir }, execFileImpl: async (cmd, args, opts) => {
        if (args.includes('push')) push = cmd;
        return execAsync(cmd, args, opts);
      } });
    assert.equal(push, shim === 'executable' ? join(pathDir, 'git-safe') : 'git');
    assert.equal(result.headSha, f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0]);
  });
}

test('an explicit publisher push command failure never bypasses the selected command', async t => {
  const f = fixture(t);
  let pushes = 0;
  await assert.rejects(publishRemediation({ ...f.publish, pushCommand: 'selected-git-safe',
    execFileImpl: async (cmd, args, opts) => {
      if (args.includes('push')) {
        pushes++;
        assert.equal(cmd, 'selected-git-safe');
        throw Object.assign(new Error('selected shim refused'), { code: 78 });
      }
      return execAsync(cmd, args, opts);
    } }), /selected shim refused/);
  assert.equal(pushes, 1);
});

for (const succeeds of [true, false]) {
  test(`publication retries transient fetch failures at most three times (recovers: ${succeeds})`, async t => {
    const f = fixture(t);
    let fetches = 0;
    let pushes = 0;
    const failure = Object.assign(new Error('git fetch failed'), { stderr: 'fatal: unable to access origin: TLS handshake timeout' });
    const operation = publishRemediation({ ...f.publish, execFileImpl: async (cmd, args, opts) => {
      if (args.includes('fetch')) {
        fetches++;
        if (!succeeds || fetches < 3) throw failure;
      }
      if (args.includes('push')) pushes++;
      return execAsync(cmd, args, opts);
    } });
    if (succeeds) assert.equal((await operation).published, true);
    else await assert.rejects(operation, error => error === failure);
    assert.equal(fetches, 3);
    assert.equal(pushes, succeeds ? 1 : 0);
  });
}

for (const stderr of ['fatal: Authentication failed', 'fatal: repository not found', "fatal: couldn't find remote ref main"]) {
  test(`publication does not retry permanent fetch failure: ${stderr}`, async t => {
    const f = fixture(t);
    let fetches = 0;
    await assert.rejects(publishRemediation({ ...f.publish, execFileImpl: async (cmd, args, opts) => {
      if (args.includes('fetch')) {
        fetches++;
        throw Object.assign(new Error('git fetch failed'), { stderr });
      }
      assert.equal(args.includes('push'), false);
      return execAsync(cmd, args, opts);
    } }));
    assert.equal(fetches, 1);
  });
}

test('publication CLI clears a prior refusal after a corrected publication and tolerates a missing sidecar', async t => {
  const f = fixture(t);
  const failurePath = join(f.work, 'publication-failure.json');
  const args = [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
    '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead,
    '--failure-path', failurePath, '--push-command', 'git'];
  writeFileSync(join(f.work, 'feature.txt'), 'base\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Restore sample feature');
  await assert.rejects(execAsync(process.execPath, args, { cwd: f.work, env }));
  assert.equal(JSON.parse(readFileSync(failurePath)).code, 'remediation-empties-pr-diff');
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Repair sample feature');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await execAsync(process.execPath, [...args, '--expected-remote-sha',
      attempt === 0 ? f.previousHead : f.git('rev-parse', 'HEAD')], { cwd: f.work, env });
    assert.equal(JSON.parse(result.stdout).published, true);
    assert.equal(existsSync(failurePath), false);
  }
});


test('REMEDBRANCH-01: a branchless publisher resolves the fake PR head and publishes the guarded commit', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix synthetic retry');
  let reads = 0;
  const result = await publishRemediation({ ...f.publish, branch: null, repo: 'fixture/repo', prNumber: 42,
    execFileImpl: async (command, args, options) => {
      if (command === 'gh') {
        reads++;
        return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: 'topic' } }) };
      }
      return execAsync(command, args, options);
    } });
  assert.equal(reads, 1);
  assert.equal(result.published, true);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], result.headSha);
});
