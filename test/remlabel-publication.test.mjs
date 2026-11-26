import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { matchesPublicationFailureAttempt, settlePublicationHandoff } from '../src/remediation-publication-refusal.mjs';
import { preserveUnpushedCommit } from '../src/github-auth-recovery.mjs';
import { observePublicationRefusal } from '../src/remediation-publication-refusal.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned, readRemediationReplyArtifact } from '../src/follow-up-jobs.mjs';

const execAsync = promisify(execFile);

test('LAC-2283: mixed-case retained publication keeps source, reply and rescue evidence', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Retain mixed-case candidate');
  const localCommit = f.git('rev-parse', 'HEAD');
  const at = new Date().toISOString();
  createFollowUpJob({ rootDir: f.root, repo: 'fixture/repo', prNumber: 1,
    revisionRef: f.previousHead, branch: 'topic', baseBranch: 'main',
    reviewBody: 'Fix feature', reviewerModel: 'claude', reviewPostedAt: at });
  const claimed = claimNextFollowUpJob({ rootDir: f.root, claimedAt: at });
  const spawned = markFollowUpJobSpawned({ rootDir: f.root, jobPath: claimed.jobPath, spawnedAt: at,
    worker: { processId: 12345, workspaceDir: f.work } });
  const code = 'remediation-publication-auth-rejected';
  const result = await settlePublicationHandoff({ rootDir: f.root, ...spawned,
    worker: spawned.job.remediationWorker, hqRoot: f.root, workspaceDir: f.work,
    replyPath: null, stoppedAt: at,
    failure: { code, localCommit: localCommit.toUpperCase(), previousHead: f.previousHead.toUpperCase(),
      expectedRemoteSha: f.previousHead.toUpperCase(), refusedAt: at },
    reply: { outcome: 'blocked', reReview: { requested: false }, operationalBlockers: [
      { code, commitSha: localCommit.toUpperCase(), expectedRemoteSha: f.previousHead.toUpperCase() },
    ] },
    lifecycle: { source: 'live', headSha: f.previousHead.toUpperCase() },
    execFileImpl: execAsync, log: { warn() {} } });
  assert.equal(result.job.publicationFailure.reason, 'owner-recovery-required');
  assert.equal(result.job.unpublishedWork.workspaceDir, f.work);
  assert.equal(result.job.unpublishedWork.commitSha, localCommit);
  assert.equal(result.job.remediationReply.state, 'worker-wrote-reply');
  assert.equal(result.job.unpublishedWork.rescue.preserved, true);
  const rescue = await preserveUnpushedCommit({ hqRoot: f.root, workspaceDir: f.work,
    repo: 'fixture/repo', prNumber: 1, jobId: 'mixed-case', checkoutTipOnly: true,
    commitSha: localCommit.toUpperCase(), expectedRemoteSha: f.previousHead.toUpperCase(),
    observedAt: at, execFileImpl: execAsync });
  assert.equal(f.git('bundle', 'list-heads', rescue.path), `${localCommit} HEAD`);
  const published = await publishRemediation({ ...f.publish, previousHead: f.previousHead.toUpperCase(),
    expectedRemoteSha: f.previousHead.toUpperCase(), expectedCandidate: localCommit.toUpperCase() });
  assert.equal(published.headSha, localCommit);
});

for (const sidecar of ['missing', 'malformed']) {
  test(`LAC-2283: valid reply remains observable with ${sidecar} refusal sidecar`, async t => {
    const f = fixture(t);
    const replyPath = join(f.root, 'reply.json');
    const job = { jobId: 'independent-artifacts', repo: 'fixture/repo', prNumber: 1 };
    const reply = { kind: 'adversarial-review-remediation-reply', schemaVersion: 1, ...job,
      outcome: 'blocked', summary: 'Publication needs recovery.', validation: [], addressed: [],
      pushback: [], blockers: [], operationalBlockers: [{ title: 'Publication unavailable',
        code: 'remediation-publication-auth-rejected', finding: 'Credentials rejected.',
        reasoning: 'The retained commit needs authorized publication.' }],
      reReview: { requested: false, reason: null } };
    writeFileSync(replyPath, JSON.stringify(reply));
    if (sidecar === 'malformed') writeFileSync(`${replyPath}.publication-failure.json`, '{');
    const result = await observePublicationRefusal({ job, worker: {}, liveness: { state: 'exited' },
      now: () => new Date().toISOString(), resolvePaths: () => ({ replyPath, workspaceDir: f.work }) });
    assert.deepEqual(result.publicationReply, readRemediationReplyArtifact(replyPath, { expectedJob: job }));
    assert.equal(result.publicationFailure, null);
    assert.equal(result.currentPublicationFailure, false);
  });
}
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
  return { root, remote, work, git, previousHead, publish: { workspaceDir: work, baseBranch: 'main', branch: 'topic', previousHead, pushCommand: 'git', env } };
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

test('LAC-2283: CLI captures the retained tip with a load-aware thirty-second nominal timeout', async t => {
  const f = fixture(t);
  const preload = join(f.root, 'probe-timeout.mjs');
  const configPath = join(f.root, 'timeout-config.yaml');
  writeFileSync(configPath, 'version: 1\nadversarial:\n  reviewer:\n    load_aware:\n      enabled: true\n      max_multiplier: 6\n');
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.loadavg = () => [Number(process.env.REMEDIATION_FIXTURE_LOAD) * os.cpus().length, 0, 0];
    const original = childProcess.execFileSync;
    childProcess.execFileSync = (command, args, options) => {
      if (command === '/bin/ps') return String(os.cpus().length * 100);
      if (command === 'git' && args.includes('HEAD^{commit}')) {
        assert.equal(options.timeout, Number(process.env.REMEDIATION_FIXTURE_TIMEOUT));
      }
      return original(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  writeFileSync(join(f.work, 'feature.txt'), 'base\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Restore sample files');
  const failurePath = join(f.root, 'publication-failure.json');
  for (const [load, timeout] of [[0, 30_000], [3, 180_000]]) {
    await assert.rejects(execAsync(process.execPath, ['--import', preload,
      new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
      '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead, '--failure-path', failurePath],
    { cwd: f.work, env: { ...env, AGENT_OS_CONFIG_PATH: configPath,
      REMEDIATION_FIXTURE_LOAD: String(load), REMEDIATION_FIXTURE_TIMEOUT: String(timeout) } }),
    error => /remediation-empties-pr-diff/.test(error.stderr));
    assert.equal(JSON.parse(readFileSync(failurePath)).localCommit, f.git('rev-parse', 'HEAD'));
  }
});

test('LAC-2283: refusal matching accepts hex case while retaining job, lease and time validation', () => {
  const head = 'aB'.repeat(20);
  const job = { jobId: 'fixture-job', repo: 'fixture/repo', prNumber: 42, revisionRef: head };
  const worker = { spawnedAt: '2026-11-20T00:00:00Z' };
  const now = '2026-11-20T00:02:00Z';
  const failure = { ...job, previousHead: head, localCommit: 'CD'.repeat(20),
    expectedRemoteSha: 'eF'.repeat(20), refusedAt: '2026-11-20T00:01:00Z' };
  assert.equal(matchesPublicationFailureAttempt(failure, job, worker, now), true);
  for (const changed of [
    { jobId: 'other-job' }, { repo: 'other/repo' }, { prNumber: 43 },
    { previousHead: 'b'.repeat(40) }, { localCommit: 'g'.repeat(40) },
    { expectedRemoteSha: 'F'.repeat(39) }, { refusedAt: '2026-11-19T23:59:00Z' },
    { refusedAt: '2026-11-20T00:03:00Z' },
  ]) {
    assert.equal(matchesPublicationFailureAttempt({ ...failure, ...changed }, job, worker, now), false);
  }
});

test('LAC-2283: retained source bundles when the host has no getuid API', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Retain publication candidate');
  const localCommit = f.git('rev-parse', 'HEAD');
  const at = new Date().toISOString();
  createFollowUpJob({ rootDir: f.root, repo: 'fixture/repo', prNumber: 1,
    revisionRef: f.previousHead, branch: 'topic', baseBranch: 'main',
    reviewBody: 'Fix feature', reviewerModel: 'claude', reviewPostedAt: at });
  const claimed = claimNextFollowUpJob({ rootDir: f.root, claimedAt: at });
  const spawned = markFollowUpJobSpawned({ rootDir: f.root, jobPath: claimed.jobPath, spawnedAt: at,
    worker: { processId: 12345, workspaceDir: f.work } });
  const getuid = process.getuid;
  process.getuid = undefined;
  t.after(() => { process.getuid = getuid; });
  const result = await settlePublicationHandoff({ rootDir: f.root, ...spawned,
    worker: spawned.job.remediationWorker, hqRoot: f.root, workspaceDir: f.work,
    replyPath: null, stoppedAt: at,
    failure: { code: 'remediation-publication-auth-rejected', localCommit,
      previousHead: f.previousHead, expectedRemoteSha: f.previousHead, refusedAt: at },
    lifecycle: { source: 'live', prState: 'open', headSha: f.previousHead },
    execFileImpl: execAsync, log: { warn() {} } });
  assert.equal(result.action, 'stopped');
  const { rescue } = result.job.unpublishedWork;
  assert.equal(rescue?.preserved, true);
  assert.ok(f.git('bundle', 'list-heads', rescue.path).startsWith(`${localCommit} `));
  assert.equal(f.git('rev-parse', 'HEAD'), localCommit);
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

test('REMEDIATEEXEC-01: fetching the base does not require an unavailable submodule', async t => {
  const f = fixture(t);
  f.git('checkout', 'main');
  writeFileSync(join(f.work, '.gitmodules'),
    '[submodule "private-overlay"]\n\tpath = private-overlay\n\turl = ./unavailable-overlay.git\n');
  f.git('add', '.gitmodules');
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.previousHead},private-overlay`);
  f.git('commit', '-m', 'Advance base with optional overlay');
  f.git('-c', 'push.recurseSubmodules=no', 'push', 'origin', 'main');
  f.git('checkout', 'topic');
  f.git('config', 'fetch.recurseSubmodules', 'true');
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
  let fetched = false;
  const result = await publishRemediation({ ...f.publish, execFileImpl: async (cmd, args, opts) => {
    if (args.includes('fetch')) {
      fetched = true;
      assert.ok(args.includes('--no-recurse-submodules'));
    }
    return execAsync(cmd, args, opts);
  } });
  assert.equal(fetched, true);
  assert.equal(result.headSha, f.git('rev-parse', 'HEAD'));
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

for (const [refusalCode, manual] of [
  ['remediation-empties-pr-diff', false],
  ['remediation-owner-auth-hold', false],
  ['remediation-empties-pr-diff', true],
]) test(`${refusalCode} (manual: ${manual}): publisher artifact settles the round without requesting review`, async t => {
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
  const ownerHold = refusalCode === 'remediation-owner-auth-hold';
  const localCommit = 'b'.repeat(40);
  writeFileSync(`${replyPath}.publication-failure.json`, JSON.stringify({ code: refusalCode, previousHead: head,
    ...(ownerHold && { localCommit, owner: 'sample', capability: 'contents:write (codex)', reason: 'missing owner route' }) }));
  const outputPath = join(artifactDir, 'last-message.md');
  writeFileSync(outputPath, 'Publication refused.');
  const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: '2026-10-16T12:01:01Z',
    worker: { processId: 12345, ...(manual && { dispatchMode: 'hq', dispatchId: 'running-dispatch', hqRoot: rootDir }), workspaceDir: relative(rootDir, workspaceDir),
      outputPath: relative(rootDir, outputPath), logPath: relative(rootDir, join(artifactDir, 'worker.log')), replyPath } });
  let reviews = 0;
  const result = await reconcileFollowUpJob({ rootDir, job: spawned.job, jobPath: spawned.jobPath,
    now: () => manual ? '2026-11-16T12:03:00Z' : '2026-10-16T12:03:00Z', isWorkerRunning: () => false,
    ...(manual && { execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'running' }) }) }),
    resolvePRLifecycleImpl: async () => {
      if (ownerHold) return { source: 'live', prState: 'open', headSha: head };
      throw new Error('empty-diff refusal must settle before lifecycle recovery');
    },
    postCommentImpl: async () => ({ posted: true }), requestReviewRereviewImpl: () => { reviews++; },
    log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.action, ownerHold ? 'stopped' : 'failed');
  if (ownerHold) {
    assert.equal(result.job.remediationPlan.stop.code, refusalCode);
    assert.equal(result.job.ownerAuthHold.capability, 'contents:write (codex)');
    assert.equal(result.job.unpublishedWork.commitSha, localCommit);
    assert.equal(result.job.unpublishedWork.workspaceDir, workspaceDir);
  } else {
    assert.equal(result.job.failure.code, refusalCode);
  }
  assert.equal(reviews, 0);
  assert.equal(JSON.parse(readFileSync(result.jobPath)).status, result.action);
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

for (const leaseMismatch of [false, true]) {
  test(`broker refresh failure retains the saved commit; lease rejection stays distinct (${leaseMismatch})`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
    f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
    const candidate = f.git('rev-parse', 'HEAD');
    let pushes = 0;
    const stderr = 'broker mode: transient broker failure exhausted retries for http://broker.invalid (curl_rc=7, HTTP 000)\n'
      + 'worker GitHub push credential is unusable and could not be refreshed (expired).\n'
      + "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled"
      + (leaseMismatch ? '\n! [rejected] topic -> topic (stale info)' : '');
    await assert.rejects(publishRemediation({ ...f.publish,
      execFileImpl: async (command, args, options) => {
        if (args.includes('push')) {
          pushes++;
          throw Object.assign(new Error('push failed'), { code: 1, stderr });
        }
        return execAsync(command, args, options);
      } }), { code: leaseMismatch ? 'remediation-publication-stale-lease' : 'remediation-credential-refresh-unavailable' });
    assert.equal(pushes, 1);
    assert.equal(f.git('rev-parse', 'HEAD'), candidate);
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.previousHead);
  });
}

for (const brokerReady of [false, true]) {
test(`bounded refresh failure needs broker outage evidence (ready: ${brokerReady})`, async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
  await assert.rejects(publishRemediation({ ...f.publish,
    credentialBrokerReadyImpl: async () => ({ ready: brokerReady }),
    execFileImpl: async (command, args, options) => {
      if (args.includes('push')) throw Object.assign(new Error('refresh failed'), {
        code: 75,
        stderr: 'entitled GitHub re-mint unavailable: remint_transient_exhausted; refusing credential fallback',
      });
      return execAsync(command, args, options);
    } }), { code: brokerReady ? 75 : 'remediation-credential-refresh-unavailable' });
});
}

test('publisher artifact and validated blocked reply refund the round through reconcile', async t => {
  const f = fixture(t);
  const rootDir = mkdtempSync(join(tmpdir(), 'broker-publication-reconcile-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prior = Object.fromEntries(['HQ_ROOT', 'AGENT_OS_DEPLOY_CHECKOUT', 'ADV_REPLIES_ROOT', 'ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT']
    .map(key => [key, process.env[key]]));
  process.env.HQ_ROOT = rootDir;
  process.env.AGENT_OS_DEPLOY_CHECKOUT = join(rootDir, 'deploy-checkout');
  process.env.ADV_REPLIES_ROOT = join(rootDir, 'replies');
  process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT = join(f.work, '..');
  t.after(() => { for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1, revisionRef: f.previousHead,
    branch: 'topic', baseBranch: 'main', reviewBody: 'Fix the feature.', reviewerModel: 'claude',
    reviewPostedAt: '2026-01-01T00:00:00Z', critical: true });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-01T00:01:00Z' });
  const replyPath = join(rootDir, 'dispatch', 'remediation-replies', claimed.job.jobId, 'remediation-reply.json');
  mkdirSync(join(replyPath, '..'), { recursive: true });
  const shim = join(rootDir, 'fake-publisher');
  writeFileSync(shim, '#!/bin/sh\n'
    + "echo 'entitled GitHub re-mint unavailable: broker_unavailable; refusing credential fallback' >&2\nexit 75\n",
  { mode: 0o755 });
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt'); f.git('commit', '-m', 'Fix sample feature');
  const savedCommit = f.git('rev-parse', 'HEAD');
  await assert.rejects(execAsync(process.execPath, [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
    '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead,
    '--failure-path', `${replyPath}.publication-failure.json`, '--push-command', shim],
  { cwd: f.work, env }), error => /remediation-credential-refresh-unavailable/u.test(error.stderr));
  writeFileSync(replyPath, JSON.stringify({ kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
    jobId: claimed.job.jobId, repo: claimed.job.repo, prNumber: claimed.job.prNumber,
    outcome: 'blocked', summary: 'Feature repaired; credential broker unavailable for publication.',
    validation: ['Offline feature validation passed.'], addressed: [], pushback: [], blockers: [],
    operationalBlockers: [JSON.parse(readFileSync(`${replyPath}.publication-failure.json`)).blocker],
    reReview: { requested: false, reason: null } }));
  const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: '2026-01-01T00:01:01Z',
    worker: { processId: 12345, model: 'claude-code', workspaceDir: f.work, replyPath } });
  const result = await reconcileFollowUpJob({ rootDir, ...spawned,
    isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.previousHead }),
    postCommentImpl: async () => ({ posted: false, error: 'offline fixture' }),
    log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.action, 'requeued', JSON.stringify({ reason: result.reason, failure: result.job?.failure }));
  assert.equal(result.reason, 'credential-refresh-unavailable');
  assert.equal(result.job.remediationPlan.currentRound, 0);
  assert.equal(result.job.remediationPlan.retryHistory.at(-1).retryMetadata.localCommit, savedCommit);
  assert.equal(f.git('cat-file', '-t', savedCommit), 'commit');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.previousHead);
});

for (const scenario of ['auth', 'broker', 'stale', 'absent-source', 'live-actor', 'invalid-reply', 'hq-not-found']) {
  test(`LAC-2283: CLI refusal, reply validation and reconciliation for ${scenario}`, async t => {
    const f = fixture(t);
    const rootDir = f.root;
    const prior = Object.fromEntries(['HQ_ROOT', 'AGENT_OS_DEPLOY_CHECKOUT', 'ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT']
      .map(key => [key, process.env[key]]));
    Object.assign(process.env, { HQ_ROOT: rootDir, AGENT_OS_DEPLOY_CHECKOUT: join(rootDir, 'deploy-checkout'),
      ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT: rootDir });
    t.after(() => { for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    const org = JSON.parse(readFileSync(new URL('../config.json', import.meta.url))).org;
    const repo = `${org || 'fixture'}/publication-fixture`;
    const { previousHead } = f;
    const start = new Date(Date.now() - 10_000).toISOString();
    createFollowUpJob({ rootDir, repo, prNumber: 42, revisionRef: previousHead,
      branch: 'topic', baseBranch: 'main', reviewBody: 'Fix the feature.', reviewerModel: 'claude',
      reviewPostedAt: start, critical: true });
    const claimed = claimNextFollowUpJob({ rootDir, claimedAt: start });
    const { jobId } = claimed.job;
    const replyPath = join(rootDir, 'dispatch', 'remediation-replies', jobId, 'remediation-reply.json');
    const failurePath = `${replyPath}.publication-failure.json`;
    mkdirSync(join(replyPath, '..'), { recursive: true });
    const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: start,
      worker: { processId: process.pid, model: 'claude-code', workspaceDir: f.work, replyPath,
        ...(scenario === 'hq-not-found' && { dispatchMode: 'hq', dispatchId: 'missing-dispatch' }) } });

    let liveHead = previousHead;
    if (scenario === 'stale') {
      f.git('commit', '--allow-empty', '-m', 'Competing remote update');
      f.git('push', 'origin', 'topic');
      liveHead = f.git('rev-parse', 'HEAD');
      f.git('reset', '--hard', previousHead);
    }
    writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
    f.git('add', 'feature.txt');
    f.git('commit', '-m', 'Retain validated local changes');
    const localCommit = f.git('rev-parse', 'HEAD');
    let refusalCode = 'remediation-publication-auth-rejected';
    let pushCommand = 'git';
    let requests = 0;
    const cliEnv = { ...env, GIT_TERMINAL_PROMPT: '0', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
    if (scenario === 'broker') {
      refusalCode = 'remediation-credential-refresh-unavailable';
      pushCommand = join(rootDir, 'broker-git-safe');
      writeFileSync(pushCommand, '#!/bin/sh\n'
        + "echo 'entitled GitHub re-mint unavailable: remint_transient_exhausted; refusing credential fallback' >&2\nexit 75\n",
      { mode: 0o755 });
      const broker = createServer((req, res) => {
        if (req.url === '/readyz') requests++;
        res.writeHead(503).end();
      });
      await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
      t.after(() => broker.close());
      cliEnv.OAUTH_BROKER_URL = `http://127.0.0.1:${broker.address().port}`;
    } else if (scenario === 'stale') {
      refusalCode = 'remediation-publication-stale-lease';
    } else {
      const server = createServer((_req, res) => {
        requests++;
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
        res.end('Invalid username or token');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => server.close());
      f.git('remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/fixture.git`);
    }

    const expectedRemoteSha = scenario === 'auth' ? 'a'.repeat(40) : previousHead;
    if (scenario === 'auth') liveHead = expectedRemoteSha;
    await assert.rejects(execAsync(process.execPath, [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
      '--base-branch', 'main', '--branch', 'topic', '--previous-head', previousHead,
      '--expected-remote-sha', expectedRemoteSha, '--job-id', jobId, '--repo', repo, '--pr', '42',
      '--failure-path', failurePath, '--push-command', pushCommand], { cwd: f.work, env: cliEnv }),
    error => error.stderr.includes(refusalCode));
    if (scenario !== 'stale') assert.equal(requests, 1);
    const failure = JSON.parse(readFileSync(failurePath));
    assert.equal(failure.localCommit, localCommit);
    assert.equal(failure.expectedRemoteSha, expectedRemoteSha);
    const reply = { kind: 'adversarial-review-remediation-reply', schemaVersion: 1, jobId, repo, prNumber: 42,
      outcome: 'blocked', summary: 'Feature changes are committed locally. Publication remains unproven.',
      validation: ['Offline validation passed.'], addressed: [], pushback: [], blockers: [],
      operationalBlockers: [failure.blocker], reReview: { requested: false, reason: null } };
    const author = draft => spawnSync(process.execPath, [
      new URL('../bin/remediation-reply-write.mjs', import.meta.url).pathname,
      '--reply-path', replyPath, '--job-id', jobId, '--repo', repo, '--pr', '42',
    ], { input: JSON.stringify(draft), encoding: 'utf8', timeout: 10_000 });
    const oldAuthShape = { ...reply, operationalBlockers: [{ ...failure.blocker, kind: 'github-auth' }] };
    const rejected = author(oldAuthShape);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /kind must be one of: pending-ci/u);
    assert.ok(!existsSync(replyPath));
    const authored = author(reply);
    assert.equal(authored.status, 0, authored.stderr);
    assert.deepEqual(readRemediationReplyArtifact(replyPath, { expectedJob: claimed.job }).operationalBlockers, [failure.blocker]);
    if (scenario === 'invalid-reply') {
      writeFileSync(replyPath, JSON.stringify(oldAuthShape));
      assert.throws(() => readRemediationReplyArtifact(replyPath, { expectedJob: claimed.job }), /kind must be one of: pending-ci/u);
    }
    if (scenario === 'absent-source') rmSync(f.work, { recursive: true });
    const result = await reconcileFollowUpJob({ rootDir, ...spawned,
      ...(scenario !== 'live-actor' && { isWorkerRunning: () => false }),
      resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: liveHead }),
      requestReviewRereviewImpl: () => assert.fail('publication refusal cannot request re-review'),
      postCommentImpl: async () => {
        assert.equal(scenario, 'broker', 'only the refunded broker round posts a notice');
        return { posted: true };
      },
      execFileImpl: async (command, args, settings) => {
        if (scenario === 'hq-not-found' && args.includes('status')) throw new Error('no dispatch with id missing-dispatch');
        assert.equal(command, 'git');
        assert.ok(!args.includes('push') && !args.includes('fetch'), 'retention cannot publish or refresh credentials');
        return execAsync(command, args, settings);
      } });
    if (scenario === 'live-actor') {
      assert.equal(result.action, 'active');
      assert.equal(result.job.remediationWorker.processId, process.pid);
      assert.equal(result.job.publicationFailure, undefined);
      return;
    }
    if (scenario === 'broker') {
      assert.equal(result.action, 'requeued');
      assert.equal(result.reason, 'credential-refresh-unavailable');
      assert.equal(result.job.remediationPlan.currentRound, 0);
      assert.equal(result.job.remediationPlan.retryHistory.at(-1).retryMetadata.localCommit, localCommit);
      assert.equal(f.git('rev-parse', 'HEAD'), localCommit);
      return;
    }
    assert.equal(result.action, 'stopped');
    const durable = JSON.parse(readFileSync(result.jobPath));
    assert.equal(durable.remediationPlan.currentRound, spawned.job.remediationPlan.currentRound);
    assert.equal(durable.publicationFailure.code, refusalCode);
    assert.equal(durable.publicationFailure.liveHeadSha, liveHead);
    assert.equal(durable.unpublishedWork.commitSha, localCommit);
    assert.equal(durable.unpublishedWork.expectedRemoteSha, expectedRemoteSha);
    const reason = { broker: 'credential-broker-deferred', stale: 'stale-head', 'absent-source': 'local-source-unverified', 'hq-not-found': 'local-source-unverified' };
    assert.equal(durable.publicationFailure.reason, reason[scenario] || 'owner-recovery-required');
    assert.equal(durable.remediationReply.state, scenario === 'invalid-reply'
      ? 'publication-refusal-reply-unverified' : 'worker-wrote-reply');
    if (['absent-source', 'hq-not-found'].includes(scenario)) {
      assert.equal(durable.unpublishedWork.workspaceDir, null);
      assert.equal(durable.unpublishedWork.rescue, undefined);
    } else if (scenario === 'auth') {
      assert.equal(durable.unpublishedWork.workspaceDir, f.work);
      assert.equal(durable.unpublishedWork.rescue, undefined, 'unknown lease cannot supply a bundle prerequisite');
    } else {
      const { rescue } = durable.unpublishedWork;
      assert.ok(rescue?.preserved);
      assert.ok(readFileSync(rescue.path).subarray(0, 1024).toString().includes(`-${expectedRemoteSha} `),
        'bundle must exclude history reachable from its lease prerequisite');
      assert.ok(f.git('bundle', 'list-heads', rescue.path).startsWith(`${localCommit} `));
      assert.equal(f.git('rev-parse', 'HEAD'), localCommit);
    }
    assert.equal(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'refs/heads/topic'], { encoding: 'utf8' }).trim(),
      scenario === 'stale' ? liveHead : previousHead);
  });
}

test('LAC-2283: explicit guarded recovery requires the exact retained checkout tip', async t => {
  const f = fixture(t);
  writeFileSync(join(f.work, 'feature.txt'), 'corrected feature\n');
  f.git('add', 'feature.txt');
  f.git('commit', '-m', 'Retain validated local changes');
  const commit = f.git('rev-parse', 'HEAD');
  const args = [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
    '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead,
    '--expected-remote-sha', f.previousHead, '--expected-candidate', commit, '--push-command', 'git'];
  f.git('reset', '--hard', f.previousHead);
  await assert.rejects(execAsync(process.execPath, args, { cwd: f.work, env }),
    error => error.stderr.includes('remediation-publication-unproven'));
  assert.ok(f.git('ls-remote', 'origin', 'refs/heads/topic').startsWith(f.previousHead));
  f.git('reset', '--hard', commit);
  const { stdout } = await execAsync(process.execPath, args, { cwd: f.work, env });
  assert.equal(JSON.parse(stdout).headSha, commit);
  assert.ok(f.git('ls-remote', 'origin', 'refs/heads/topic').startsWith(commit));
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

// Exercise the real CLI boundary: fixture diagnostics must survive serialization.
test('LAC-2283: publisher exposes failing fixture names and redacts credentials', async t => {
  const f = fixture(t);
  mkdirSync(join(f.work, 'src'));
  mkdirSync(join(f.work, 'test'));
  writeFileSync(join(f.work, 'package.json'), JSON.stringify({ name: 'adversarial-review' }));
  writeFileSync(join(f.work, 'src/load-aware-timeout.mjs'), '// fixture trigger\n');
  writeFileSync(join(f.work, 'test/run-tests.mjs'),
    "console.error('fixture assertion failed ghp_123456789012345678901234567890'); process.exit(1);\n");
  f.git('add', '.'); f.git('commit', '-m', 'Trigger failing offline publication fixture');
  const failurePath = join(f.root, 'failure.json');
  await assert.rejects(execAsync(process.execPath, [new URL('../bin/remediation-publish.mjs', import.meta.url).pathname,
    '--base-branch', 'main', '--branch', 'topic', '--previous-head', f.previousHead, '--failure-path', failurePath],
  { cwd: f.work, env }), error => {
    assert.match(error.stderr, /remediation-publication-check-failed/);
    assert.match(error.stderr, /test\/finalization-simulator.test.mjs/);
    assert.match(error.stderr, /fixture assertion failed/);
    assert.ok(!error.stderr.includes('ghp_123456'));
    return true;
  });
  const failure = JSON.parse(readFileSync(failurePath));
  assert.match(failure.message, /test\/finalization-simulator.test.mjs/);
  assert.match(failure.message, /REDACTED_GITHUB_TOKEN/);
  assert.equal(failure.blocker.finding, 'The guarded publisher could not prove publication.');
});

test('LAC-2283: foreign-owned retained source is checked before Git inspection', async t => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('requires a non-root Unix worker');
    return;
  }
  const f = fixture(t);
  const at = new Date().toISOString();
  createFollowUpJob({ rootDir: f.root, repo: 'fixture/repo', prNumber: 1,
    revisionRef: f.previousHead, branch: 'topic', baseBranch: 'main',
    reviewBody: 'Fix feature', reviewerModel: 'claude', reviewPostedAt: at });
  const claimed = claimNextFollowUpJob({ rootDir: f.root, claimedAt: at });
  const spawned = markFollowUpJobSpawned({ rootDir: f.root, jobPath: claimed.jobPath, spawnedAt: at,
    worker: { processId: 12345, workspaceDir: f.work } });
  let gitCalls = 0;
  const result = await settlePublicationHandoff({ rootDir: f.root, ...spawned,
    worker: spawned.job.remediationWorker, hqRoot: f.root,
    // The filesystem root exists and belongs to root; no Git inspection is allowed.
    workspaceDir: '/', replyPath: null, stoppedAt: at,
    failure: { code: 'remediation-publication-auth-rejected', localCommit: 'a'.repeat(40),
      previousHead: f.previousHead, expectedRemoteSha: f.previousHead, refusedAt: at },
    lifecycle: { source: 'live', prState: 'open', headSha: f.previousHead },
    execFileImpl: async () => { gitCalls++; throw new Error('foreign-owned checkout must not run Git'); },
    log: { warn() {} } });
  assert.equal(gitCalls, 0);
  assert.equal(result.action, 'stopped');
  assert.equal(result.job.publicationFailure.reason, 'local-source-unverified');
  assert.equal(result.job.unpublishedWork.workspaceDir, null);
});

test('LAC-2283: rebased source bundles exclude shared history with a diverged lease', async t => {
  const f = fixture(t);
  f.git('checkout', 'main');
  writeFileSync(join(f.work, 'trunk.txt'), 'new trunk content\n');
  f.git('add', '.'); f.git('commit', '-m', 'Advance trunk');
  f.git('checkout', 'topic');
  f.git('rebase', 'main');
  const commitSha = f.git('rev-parse', 'HEAD');
  assert.notEqual(commitSha, f.previousHead);
  const rescue = await preserveUnpushedCommit({ hqRoot: f.root, workspaceDir: f.work,
    repo: 'fixture/repo', prNumber: 1, jobId: 'rebased-source',
    commitSha, expectedRemoteSha: f.previousHead, checkoutTipOnly: true,
    observedAt: new Date().toISOString(), execFileImpl: execAsync });
  assert.equal(rescue.preserved, true);
  assert.ok(readFileSync(rescue.path).subarray(0, 1024).toString().includes('\n-'),
    'bundle must retain a shared-history prerequisite after rebasing');
  assert.equal(f.git('bundle', 'list-heads', rescue.path), `${commitSha} HEAD`);
});
