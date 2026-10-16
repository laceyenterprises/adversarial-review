import { buildMergeAgentPrompt, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER } from '../src/merge-agent-prompt.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { HAMMER_PHASES } from '../src/hammer-procedure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  amaCloserDispatchFilePath, composeCloserPrompt, createHammerScratchDir,
  maybeDispatchAmaCloser, reconcileAmaCloserDispatches, substituteTemplate, updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const head = 'b'.repeat(40);
const logger = { log() {}, info() {}, warn() {}, error() {} };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-scratch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function dispatchArgs(root) {
  const gate = 'fixture/gate';
  const user = userInfo().username;
  return {
    reviewState: { verdict: 'comment-only', headSha: head, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'synthetic-builder' },
    prMetadata: { prNumber: 42, headSha: head, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], author: 'synthetic-builder', branchProtection: { requiredContexts: [gate] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: gate, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'synthetic-integration', conclusion: 'FAILURE' }] },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: true } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: gate } },
    dispatchContext: { rootDir: root, repo: 'fixture/repo', prUrl: 'https://github.com/fixture/repo/pull/42',
      reviewedSha: head, riskClass: 'low', requiredGateContext: gate, reviewedBy: 'synthetic-reviewer',
      reviewer: 'codex', parentSession: 'synthetic-session', hqPath: 'synthetic-hq', hqRoot: join(root, 'hq'),
      hqOwnerUser: user, currentUser: user, dispatchedAt: '2026-10-01T00:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'synthetic-branch' }) },
    readTemplateImpl: () => 'PR <<PR_NUMBER>> scratch=<<RUN_DIR>>',
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger,
  };
}

for (const sink of ['warn', 'error', 'function']) {
  test(`HAMTMP-01: scratch cleanup failures reach the ${sink} logger`, async t => {
    const root = fixture(t);
    const scratchDir = createHammerScratchDir(root);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
      launchRequestId: 'synthetic-lrq', lastObservedStatus: 'running', scratchDir, promptDir: root }));
    const messages = [];
    const log = sink === 'function' ? message => messages.push(message) : {
      warn: 'not callable',
      [sink](message) {
        assert.equal(this, log, 'logger methods retain their receiver');
        messages.push(message);
      },
    };
    const originalRm = fs.rmSync;
    try {
      t.mock.method(fs, 'rmSync', (path, options) => {
        if (path === scratchDir) throw Object.assign(new Error('synthetic cleanup refusal'), { code: 'EPERM' });
        return originalRm(path, options);
      });
      syncBuiltinESMExports();
      const result = await reconcileAmaCloserDispatches(root, {
        ...(sink === 'function' ? { log } : { logger: log }),
        readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
      });
      assert.equal(result.changed, 1, 'cleanup failure does not prevent terminal reconciliation');
      assert.ok(messages.includes('hammer scratch cleanup failed: synthetic cleanup refusal'));
      assert.equal(existsSync(scratchDir), true);
      assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(root, identity))).state, 'launch-terminal');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('HAMTMP-01: prompt composition preserves an omitted scratch directory for deferred substitution', () => {
  const prompt = composeCloserPrompt({ prNumber: 42, templateBody: 'PR <<PR_NUMBER>> scratch=<<RUN_DIR>>' });
  assert.equal(prompt, 'PR 42 scratch=<<RUN_DIR>>');
  assert.equal(substituteTemplate(prompt, { RUN_DIR: '/fixture/private-scratch' }),
    'PR 42 scratch=/fixture/private-scratch');
});

for (const status of ['succeeded', 'failed', 'canceled', 'reaped']) {
  test(`HAMTMP-01: dispatch renders one private directory and ${status} run cleanup removes it`, async t => {
    const root = fixture(t);
    const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root),
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq', dispatchId: 'synthetic-dispatch' }) }) });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
    const record = JSON.parse(readFileSync(path));
    assert.equal(statSync(record.scratchDir).mode & 0o777, 0o700);
    assert.equal(statSync(record.scratchDir).uid, userInfo().uid);
    assert.equal(readFileSync(result.promptPath, 'utf8'), `PR 42 scratch=${record.scratchDir}`);
    writeFileSync(join(record.scratchDir, 'publication.sh'), 'synthetic evidence');
    const options = { logger, readLaunchRequestStatusImpl: () => ({ ok: true, row: { status } }) };
    await reconcileAmaCloserDispatches(root, { ...options, dryRun: true });
    assert.equal(existsSync(record.scratchDir), true);
    await reconcileAmaCloserDispatches(root, options);
    assert.equal(existsSync(record.scratchDir), false);
    // Reconciliation and next-run cleanup are idempotent.
    await reconcileAmaCloserDispatches(root, options);
  });
}

test('HAMTMP-01: a dispatch failure removes its unlaunched scratch directory', async t => {
  const root = fixture(t);
  let scratchDir;
  const args = dispatchArgs(root);
  const result = await maybeDispatchAmaCloser({ ...args, execFileImpl: async (_cmd, argv) => {
    const prompt = readFileSync(argv[argv.indexOf('--prompt') + 1], 'utf8');
    scratchDir = prompt.split('scratch=')[1];
    assert.equal(existsSync(scratchDir), true);
    throw new Error('synthetic permanent dispatch refusal');
  } });
  assert.equal(result.dispatched, false);
  assert.ok(scratchDir);
  assert.equal(existsSync(scratchDir), false);
});

test('HAMTMP-01: same-PR renders are fresh and every rendered helper uses private scratch', t => {
  const root = fixture(t);
  const directories = [createHammerScratchDir(root), createHammerScratchDir(root)];
  assert.notEqual(directories[0], directories[1]);
  for (const scratchDir of directories) {
    assert.equal(statSync(scratchDir).mode & 0o777, 0o700);
    const values = Object.fromEntries([...readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8')
      .matchAll(/<<([A-Z_]+)>>/g)].map(m => [`HAM_${m[1]}`, 'synthetic']));
    Object.assign(values, { HAM_ROOT_DIR: resolve(realpathSync(join(repoRoot, 'bin/hammer-procedure.mjs')), '..', '..'), HAM_RUN_DIR: scratchDir, HAM_PR_NUMBER: '42' });
    const prompt = composeCloserPrompt({ templateBody: readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8'),
      rootDir: repoRoot, scratchDir, prNumber: 42 });
    assert.doesNotMatch(prompt, /\/tmp\/ham-/);
    assert.ok(prompt.includes(`export HAM_RUN_DIR='${scratchDir}'`));
    assert.ok(prompt.includes(`source "${scratchDir}/hammer-publish.sh"`));
    for (const phase of HAMMER_PHASES) {
      const rendered = spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-procedure.mjs'), phase, '--render'], {
        env: { ...process.env, ...values }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.doesNotMatch(rendered.stdout, /\/tmp\/ham-|<<RUN_DIR>>/);
      assert.ok(rendered.stdout.includes(scratchDir));
    }
  }
  assert.equal(readdirSync(root).length, 2);
});

test('HAMTMP-02: base-head capture runs from a deployed root containing spaces', t => {
  const root = join(fixture(t), 'deployed root');
  const scratchDir = join(root, 'private run');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(scratchDir);
  const prUrl = 'https://github.com/fixture/repo/pull/42';
  writeFileSync(join(root, 'bin/hammer-base-head.mjs'), `
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2), [${JSON.stringify(prUrl)}]);
    process.stdout.write('${head}');
  `);
  const prompt = composeCloserPrompt({
    templateBody: readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8'),
    rootDir: root, scratchDir, prUrl, prNumber: 42,
  });
  const capture = prompt.split('\n').find(line => line.startsWith('/usr/bin/perl') && line.includes('/bin/hammer-base-head.mjs'));
  assert.ok(capture, 'prompt contains the initial base-head capture command');
  const result = spawnSync('/bin/bash', ['-c', capture], {
    env: { ...process.env, HAM_NODE_BIN: process.execPath }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(scratchDir, 'base-head'), 'utf8'), head);
});

test('HAMTMP-01: a launch with an ambiguous response retains scratch until terminal reconciliation', async t => {
  const root = fixture(t);
  const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root), execFileImpl: async () => {
    throw Object.assign(new Error('synthetic response lost after launch'), {
      stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq', dispatchId: 'synthetic-dispatch' }),
    });
  } });
  assert.equal(result.reason, 'dispatch-response-ambiguous');
  const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
  const record = JSON.parse(readFileSync(path));
  assert.equal(existsSync(record.scratchDir), true);
  await reconcileAmaCloserDispatches(root, { logger,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }) });
  assert.equal(existsSync(record.scratchDir), true);
  await reconcileAmaCloserDispatches(root, { logger,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }) });
  assert.equal(existsSync(record.scratchDir), false);
});

test('HAMTMP-01: the next admitted run removes a dead predecessor and renders a fresh directory', async t => {
  const root = fixture(t);
  const promptDir = join(root, 'prompts');
  const previous = createHammerScratchDir(promptDir);
  updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: 42, headSha: head }, () => ({
    repo: 'fixture/repo', prNumber: 42, headSha: head, reviewedSha: head,
    workerClass: 'hammer', state: 'dispatch-failed', promptDir, scratchDir: previous,
    retryCount: 0, lastAttemptedAt: '2026-09-01T00:00:00Z',
  }));
  const args = dispatchArgs(root);
  args.dispatchContext.promptDir = promptDir;
  const result = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-new-lrq', dispatchId: 'synthetic-new-dispatch' }) }) });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
  const record = JSON.parse(readFileSync(path));
  assert.notEqual(record.scratchDir, previous);
  assert.equal(existsSync(previous), false);
  assert.equal(existsSync(record.scratchDir), true);
  assert.equal(readFileSync(result.promptPath, 'utf8'), `PR 42 scratch=${record.scratchDir}`);
});

for (const status of ['succeeded', 'failed', 'cancelled']) {
  test(`HAMTMP-01: recording a fresh ${status} run observation removes scratch without teardown`, t => {
    const root = fixture(t);
    const scratchDir = createHammerScratchDir(root);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
      lastObservedStatus: 'running', scratchDir, promptDir: root }));
    assert.equal(existsSync(scratchDir), true);
    updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, lastObservedStatus: status }));
    assert.equal(existsSync(scratchDir), false);
  });
}

test('HAMTMP-01: dispatching and inherited predecessor statuses cannot remove a new run directory', t => {
  const root = fixture(t);
  const scratchDir = createHammerScratchDir(root);
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
  updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatching',
    lastObservedStatus: 'failed', scratchDir, promptDir: root }));
  assert.equal(existsSync(scratchDir), true);
  updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, state: 'dispatched' }));
  assert.equal(existsSync(scratchDir), true);
  updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, lastObservedStatus: 'running' }));
  assert.equal(existsSync(scratchDir), true);
  updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, lastObservedStatus: 'succeeded' }));
  assert.equal(existsSync(scratchDir), false);
});


test('HAMTMP-02: dispatch snapshots deployed phases and the prompt sources only private absolute scripts', async t => {
  const root = fixture(t);
  // The state root deliberately contains a different PR-checkout procedure.
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/hammer-verify-head.sh'), 'synthetic untrusted procedure');
  const args = dispatchArgs(root);
  args.readTemplateImpl = () => readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8');
  const result = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(root,
    { repo: 'fixture/repo', prNumber: 42, headSha: head })));
  const prompt = readFileSync(result.promptPath, 'utf8');
  assert.doesNotMatch(prompt, /hammer-procedure\.mjs|--render|\/tmp\/ham-/);
  assert.doesNotMatch(prompt, /(?:^|[\s`'"])bin\/(?:hammer-|run-bounded)/m);
  assert.match(prompt, /each command runs in a fresh shell/i);
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    const path = join(record.scratchDir, `${phase}.sh`);
    assert.ok(prompt.includes(`source "${path}"`), phase);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const script = readFileSync(path, 'utf8');
    assert.doesNotMatch(script, /\/tmp\/ham-|<<[A-Z_]+>>|synthetic untrusted procedure/);
    assert.ok(script.includes(record.scratchDir));
    assert.match(script, /ham_procedure_floor/);
  }
});

test('HAMTMP-02: copied renderer refuses outside the real dispatch root; deployed renderer accepts aliases', t => {
  const root = fixture(t);
  const foreign = join(root, 'foreign');
  mkdirSync(foreign);
  cpSync(realpathSync(join(repoRoot, 'bin')), join(foreign, 'bin'), { recursive: true });
  // Reusable implementation, if present, is part of the synthetic foreign checkout.
  if (existsSync(join(repoRoot, 'src/hammer-procedure.mjs'))) {
    mkdirSync(join(foreign, 'src'));
    cpSync(join(repoRoot, 'src/hammer-procedure.mjs'), join(foreign, 'src/hammer-procedure.mjs'));
  }
  const env = Object.fromEntries([...readFileSync(join(repoRoot, 'bin/hammer-verify-head.sh'), 'utf8')
    .matchAll(/<<([A-Z_]+)>>/g)].map(m => [`HAM_${m[1]}`, 'synthetic']));
  Object.assign(env, { HAM_ROOT_DIR: resolve(realpathSync(join(repoRoot, 'bin/hammer-procedure.mjs')), '..', '..'), HAM_RUN_DIR: root });
  const render = path => spawnSync(process.execPath, [path, 'hammer-verify-head', '--render'],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
  const denied = render(join(foreign, 'bin/hammer-procedure.mjs'));
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /refus.*outside.*HAM_ROOT_DIR/i);
  assert.equal(denied.stdout, '');
  const alias = join(root, 'deployed-alias');
  symlinkSync(env.HAM_ROOT_DIR, alias, 'dir');
  env.HAM_ROOT_DIR = alias;
  const accepted = render(join(repoRoot, 'bin/hammer-procedure.mjs'));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /ham_verify_head/);
});

test('HAMTMP-02: hammer spawn inherits private TMPDIR and terminal cleanup removes improvised files', async t => {
  const root = fixture(t);
  let scratchDir;
  const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root),
    execFileImpl: async (_cmd, argv, options) => {
      const prompt = readFileSync(argv[argv.indexOf('--prompt') + 1], 'utf8');
      scratchDir = prompt.split('scratch=')[1];
      assert.equal(options.env.TMPDIR, scratchDir);
      const improvised = spawnSync('sh', ['-c', 'mktemp -d "${TMPDIR:-/tmp}/synthetic.XXXXXX"'],
        { env: options.env, encoding: 'utf8', timeout: 5000 });
      assert.equal(improvised.status, 0, improvised.stderr);
      writeFileSync(join(improvised.stdout.trim(), 'state'), 'synthetic state');
      return { stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) };
    } });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  await reconcileAmaCloserDispatches(root, { logger,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }) });
  assert.equal(existsSync(scratchDir), false);
});


test('HAMTMP-02: sibling remediation and fallback merge prompts invoke deployed helpers absolutely', () => {
  const job = { jobId: 'synthetic-job', repo: 'fixture/repo', prNumber: 42, baseBranch: 'main',
    reviewSummary: 'synthetic finding', reviewBody: 'synthetic review',
    remediationPlan: { maxRounds: 3, currentRound: 0 } };
  for (const round of [0, 1, 2]) {
    const prompt = buildRemediationPrompt({ ...job, remediationPlan: { ...job.remediationPlan, currentRound: round } },
      { hqRoot: '/fixture/hq', launchRequestId: 'synthetic-lrq' });
    assert.ok(prompt.includes(`"${repoRoot}/bin/run-bounded.sh"`));
    assert.doesNotMatch(prompt, /`bin\/run-bounded|\$\{ADVERSARIAL_REVIEW_ROOT\}/);
  }
  const prompt = buildMergeAgentPrompt(job, { trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER });
  for (const action of ['acquire', 'release', 'needs-revalidation']) {
    assert.ok(prompt.includes(`'${repoRoot}/bin/merge-lease.mjs' ${action}`));
  }
  assert.doesNotMatch(prompt, /node bin\//);
});


test('GENCONFLICT-01: merge-agent leased rebase uses the same generated-conflict helper', () => {
  const prompt = buildMergeAgentPrompt({
    repo: 'fixture/repo', prNumber: 42, branch: 'feature', baseBranch: 'main',
    headSha: head, strictRemediation: true,
  }, { trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER });
  // The normal merge path emits this shell only when a merge is authorized.
  assert.match(prompt, /hq generated-conflicts rebase --worktree "\$PWD" --onto "\$VALIDATION_BASE"/);
  assert.doesNotMatch(prompt, /\ngit rebase "\$VALIDATION_BASE"/);
  assert.match(prompt, /Failure aborts the rebase and removes this worktree/);
});
