import { launchRetryFixture } from './helpers/launch-retry-fixture.mjs';
import Database from 'better-sqlite3';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
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
  maybeDispatchAmaCloser, reconcileAmaCloserDispatches, reconcileAmaCloserLease, substituteTemplate, updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, deleteAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const head = 'b'.repeat(40);
const logger = { log() {}, info() {}, warn() {}, error() {} };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-scratch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const state of ['unreadable', 'OPEN']) {
  test(`HAMTMP-05: terminal launch records status and cleans scratch while ${state} PR evidence retains lease`, t => {
    const root = fixture(t);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    const now = '2026-10-01T00:00:00Z';
    const scratchDir = createHammerScratchDir(root);
    acquireAmaCloserLease({ rootDir: root, ...identity, now, host: 'synthetic-host', watcherPid: 123 });
    updateAmaCloserLease({ rootDir: root, ...identity, status: 'dispatched', lrqId: 'synthetic-lrq', now });
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
      launchRequestId: 'synthetic-lrq', lastObservedStatus: 'starting', scratchDir, promptDir: root }));
    const before = readAmaCloserLease(root, identity);
    assert.equal(reconcileAmaCloserLease({ rootDir: root, hqRoot: root, ...identity, now, logger,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded', terminal_at: now } }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
      readPullRequestStateImpl: () => state === 'unreadable' ? null : { state },
    }), false);
    assert.deepEqual(readAmaCloserLease(root, identity), before, 'scratch cleanup cannot release merge authority');
    const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(root, identity)));
    assert.equal(record.lastObservedStatus, 'unverified-terminal-success');
    assert.equal(record.terminalLaunchStatus, 'succeeded');
    assert.equal(record.lastObservedAt, now);
    assert.equal(existsSync(scratchDir), false);
  });
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

for (const clock of ['wall', 'timestamp', 'function']) {
  test(`HAMTMP-05: terminal lease handling persists ledger status with ${clock} clock before retry admission`, async t => {
    const root = fixture(t);
    const args = dispatchArgs(root);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    assert.equal((await maybeDispatchAmaCloser({ ...args,
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }),
    })).dispatched, true);
    const path = amaCloserDispatchFilePath(root, identity);
    const scratchDir = JSON.parse(readFileSync(path)).scratchDir;
    updateAmaCloserLease({ rootDir: root, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
    updateAmaCloserDispatchRecord(root, identity, record => ({ ...record, retryCount: 2 }));
    assert.equal(existsSync(scratchDir), true);
    const beforeObservation = Date.now();
    const observationTime = '2026-10-02T12:34:56Z';
    const observed = await maybeDispatchAmaCloser({ ...args,
      now: clock === 'wall' ? null : clock === 'function' ? () => observationTime : observationTime,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'canceled' } }),
      execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'synthetic-unknown' }) }),
    });
    const afterObservation = Date.now();
    const record = JSON.parse(readFileSync(path));
    assert.equal(record.lastObservedStatus, 'canceled', JSON.stringify(observed));
    assert.equal(record.terminalLaunchStatus, 'canceled');
    if (clock === 'wall') {
      assert.ok(Date.parse(record.lastObservedAt) >= beforeObservation
        && Date.parse(record.lastObservedAt) <= afterObservation, 'terminal observation uses the current wall clock');
    } else {
      assert.equal(record.lastObservedAt, observationTime, 'observation clock takes precedence over dispatch time');
    }
    assert.equal(existsSync(scratchDir), false);
  });
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
      execFileImpl: async () => ({ stdout: JSON.stringify({ ticketRef: 'HAM', launchRequestId: 'synthetic-lrq', dispatchId: 'synthetic-dispatch' }) }) });
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
    const terminalRecord = JSON.parse(readFileSync(path));
    assert.equal(terminalRecord.terminalLaunchStatus, status);
    assert.notEqual(terminalRecord.lastObservedStatus, 'starting');
    // Reconciliation and next-run cleanup are idempotent.
    await reconcileAmaCloserDispatches(root, options);
  });
}

test('HAMTMP-01: a dispatch failure removes its unlaunched scratch directory', async t => {
  const root = fixture(t);
  let scratchDir;
  let promptPath;
  const args = dispatchArgs(root);
  const result = await maybeDispatchAmaCloser({ ...args, execFileImpl: async (_cmd, argv) => {
    promptPath = argv[argv.indexOf('--prompt') + 1];
    const prompt = readFileSync(promptPath, 'utf8');
    scratchDir = prompt.split('scratch=')[1];
    assert.equal(existsSync(scratchDir), true);
    throw new Error('synthetic permanent dispatch refusal');
  } });
  assert.equal(result.dispatched, false);
  assert.ok(scratchDir);
  assert.equal(existsSync(scratchDir), false);
  assert.equal(existsSync(promptPath), false);
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
      stdout: JSON.stringify({ ticketRef: 'HAM', launchRequestId: 'synthetic-lrq', dispatchId: 'synthetic-dispatch' }),
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
    execFileImpl: async () => ({ stdout: JSON.stringify({ ticketRef: 'HAM', launchRequestId: 'synthetic-new-lrq', dispatchId: 'synthetic-new-dispatch' }) }) });
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

for (const outcome of ['merged', 'closed', 'stopped', 'failed', 'superseded']) {
  test(`HAMTMP-03: terminal ${outcome} outcome removes all scratch without another dispatch`, t => {
    const root = fixture(t);
    const scratchDir = createHammerScratchDir(root);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
      lastObservedStatus: 'running', scratchDir, promptDir: root }));
    writeFileSync(join(scratchDir, 'ci-failed.log'), 'synthetic CI output');
    updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, outcome }));
    assert.equal(existsSync(scratchDir), false);
  });
}

test('HAMTMP-03: repeated terminal observation retries cleanup of an older record', t => {
  const root = fixture(t);
  const scratchDir = createHammerScratchDir(root);
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
  const path = amaCloserDispatchFilePath(root, identity);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...identity, state: 'dispatched',
    lastObservedStatus: 'succeeded', scratchDir, promptDir: root }));
  updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, lastError: null }));
  assert.equal(existsSync(scratchDir), false);
});

test('HAMTMP-03: recording an initial dispatch failure immediately removes scratch', t => {
  const root = fixture(t);
  const scratchDir = createHammerScratchDir(root);
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
  updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatching',
    lastObservedStatus: 'failed', scratchDir, promptDir: root }));
  writeFileSync(join(scratchDir, 'ci-failed.log'), 'synthetic CI output');
  assert.equal(existsSync(scratchDir), true);
  updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, state: 'dispatch-failed',
    lastObservedStatus: null }));
  assert.equal(existsSync(scratchDir), false);
});

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
    execFileImpl: async () => ({ stdout: JSON.stringify({ ticketRef: 'HAM', launchRequestId: 'synthetic-lrq' }) }) });
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
      return { stdout: JSON.stringify({ ticketRef: 'HAM', launchRequestId: 'synthetic-lrq' }) };
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

for (const status of ['requested', 'starting', 'running', 'parked']) {
  test(`SCRATCHRACE-01: a transitive ${status} fleet retry retains scratch and prevents closer dispatch`, async t => {
    const root = fixture(t);
    const args = dispatchArgs(root);
    const first = await maybeDispatchAmaCloser({ ...args,
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
    const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
    const before = readFileSync(path, 'utf8');
    const record = JSON.parse(before);
    const prompt = readFileSync(first.promptPath, 'utf8');
    const ledgerTarget = launchRetryFixture(root, status);
    assert.equal(reconcileAmaCloserLease({ rootDir: root, repo: 'fixture/repo', prNumber: 42,
      hqRoot: args.dispatchContext.hqRoot, ledgerTarget, logger }), false);
    assert.equal(existsSync(record.scratchDir), true, 'lease reconciliation must see fleet retries too');
    const result = await maybeDispatchAmaCloser({ ...args,
      dispatchContext: { ...args.dispatchContext, ledgerTarget },
      execFileImpl: async () => { assert.fail('a live retry must prevent all worker teardown and dispatch'); },
    });
    assert.equal(result.reason, 'dispatch-retry-live');
    assert.equal(result.liveRetryLaunchRequestId, 'synthetic-retry-leaf');
    assert.equal(existsSync(record.scratchDir), true);
    assert.equal(readFileSync(first.promptPath, 'utf8'), prompt);
    assert.equal(readFileSync(path, 'utf8'), before);
    const reconciled = await reconcileAmaCloserDispatches(root, { logger, ledgerTarget });
    assert.equal(reconciled.changed, 0);
    assert.equal(existsSync(record.scratchDir), true);
  });
}

test('SCRATCHRACE-01: a terminal retry chain still removes predecessor scratch', async t => {
  const root = fixture(t);
  const first = await maybeDispatchAmaCloser({ ...dispatchArgs(root),
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  const scratchDir = readFileSync(first.promptPath, 'utf8').split('scratch=')[1];
  const ledgerTarget = launchRetryFixture(root, 'succeeded');
  const reconciled = await reconcileAmaCloserDispatches(root, { logger, ledgerTarget });
  assert.equal(reconciled.changed, 1);
  assert.equal(existsSync(scratchDir), false);
});

test('RETRYCHAIN-01: PostgreSQL terminal retry chains allow a fresh hammer dispatch', async t => {
  const root = fixture(t);
  const args = dispatchArgs(root);
  const first = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  const previousScratch = readFileSync(first.promptPath, 'utf8').split('scratch=')[1];
  const ledgerTarget = { backend: 'postgres', databaseName: 'synthetic' };
  let chainReads = 0;
  const result = await maybeDispatchAmaCloser({ ...args,
    dispatchContext: { ...args.dispatchContext, ledgerTarget },
    readLaunchRequestStatusImpl: probe => readLaunchRequestStatusFromLedgerAsync({ ...probe,
      includeRetryChain: true,
      spawnSyncImpl: (_command, _argv, options) => {
        if (options.input.includes('WITH RECURSIVE')) {
          chainReads += 1;
          assert.match(options.input, /SELECT :'lrq'::text/);
          return { status: 0, stdout: ['succeeded', 'canceled'].map((status, index) => JSON.stringify({
            launch_request_id: `synthetic-terminal-${index}`, status, ticket_ref: 'HAM',
          })).join('\n') };
        }
        return { status: 0, stdout: JSON.stringify({ launch_request_id: 'synthetic-lrq',
          status: 'failed', ticket_ref: 'HAM' }) };
      },
    }),
    readPullRequestStateImpl: () => ({ state: 'OPEN' }),
    execFileImpl: async (_command, argv) => argv[0] === 'dispatch' && argv.includes('--prompt')
      ? { stdout: JSON.stringify({ launchRequestId: 'synthetic-fresh-hammer' }) }
      : { stdout: JSON.stringify({ status: 'failed' }) },
  });
  assert.ok(chainReads > 0);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, 'synthetic-fresh-hammer');
  assert.equal(existsSync(previousScratch), false);
});

for (const repoSource of ['dispatchContext', 'prMetadata', 'repo', 'advanced-head', 'context-pr-number', 'top-level-pr-number']) {
  test(`SCRATCHRACE-01: a live logical-job refusal preserves predecessor artifacts with ${repoSource} repository`, async t => {
    const root = fixture(t);
    const args = dispatchArgs(root);
    const first = await maybeDispatchAmaCloser({ ...args,
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
    const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
    const previous = JSON.parse(readFileSync(path));
    const prompt = readFileSync(first.promptPath, 'utf8');
    const helper = join(previous.scratchDir, 'synthetic-phase.sh');
    writeFileSync(helper, 'synthetic phase helper');
    const ledgerTarget = launchRetryFixture(root, 'failed');
    let attemptedPrompt;
    let unlaunchedScratch;
    const retryArgs = { ...args, dispatchContext: { ...args.dispatchContext, ledgerTarget } };
    if (repoSource.endsWith('pr-number')) {
      retryArgs.prMetadata = { ...args.prMetadata };
      delete retryArgs.prMetadata.prNumber;
      if (repoSource === 'context-pr-number') retryArgs.dispatchContext.prNumber = 42;
      else retryArgs.prNumber = 42;
    }
    const targetHead = repoSource === 'advanced-head' ? 'c'.repeat(40) : head;
    if (repoSource === 'advanced-head') {
      retryArgs.prMetadata = { ...args.prMetadata, headSha: targetHead };
      retryArgs.dispatchContext.allowStaleReviewHeadHammerResume = true;
      retryArgs.dispatchContext.targetRemediationSha = targetHead;
      retryArgs.dispatchContext.dispatchRecordHeadSha = head;
      retryArgs.dispatchContext.livePrProbeImpl = async () => ({ state: 'OPEN', headRefOid: targetHead,
        headBranchExists: true, headRefName: 'synthetic-branch' });
    } else if (repoSource !== 'dispatchContext') {
      delete retryArgs.dispatchContext.repo;
      if (repoSource === 'prMetadata') retryArgs.prMetadata = { ...args.prMetadata, repo: 'fixture/repo' };
      else retryArgs.repo = 'fixture/repo';
    }
    const result = await maybeDispatchAmaCloser({ ...retryArgs,
      readPullRequestStateImpl: () => ({ state: 'OPEN' }),
      readLaunchRequestStatusImpl: readLaunchRequestStatusFromLedgerAsync,
      execFileImpl: async (_cmd, argv) => {
        if (argv[0] === 'dispatch' && argv.includes('--prompt')) {
          attemptedPrompt = argv[argv.indexOf('--prompt') + 1];
          unlaunchedScratch = readFileSync(attemptedPrompt, 'utf8').split('scratch=')[1];
          assert.notEqual(attemptedPrompt, first.promptPath);
          assert.equal(readFileSync(first.promptPath, 'utf8'), prompt);
          assert.equal(readFileSync(helper, 'utf8'), 'synthetic phase helper');
          const db = new Database(ledgerTarget.path);
          db.prepare('UPDATE launch_requests SET status = ? WHERE launch_request_id = ?')
            .run('requested', 'synthetic-retry-leaf');
          db.close();
          throw Object.assign(new Error('synthetic dispatch refused'), {
            stderr: 'duplicate key value violates unique constraint "uq_worker_runs_live_logical_job"',
          });
        }
        return { stdout: JSON.stringify({ status: 'failed' }) };
      },
    });
    assert.equal(result.reason, 'dispatch-retry-live', JSON.stringify(result));
    assert.ok(attemptedPrompt, 'exercise the admission race after the terminal ledger snapshot');
    assert.equal(readFileSync(first.promptPath, 'utf8'), prompt);
    assert.equal(readFileSync(helper, 'utf8'), 'synthetic phase helper');
    const record = JSON.parse(readFileSync(path));
    assert.equal(record.state, 'dispatched');
    assert.equal(record.launchRequestId, previous.launchRequestId);
    assert.equal(record.scratchDir, previous.scratchDir);
    assert.equal(record.promptPath, first.promptPath);
    assert.equal(record.retryCount, previous.retryCount);
    assert.equal(record.headSha, head);
    assert.equal(record.reviewedSha, previous.reviewedSha);
    assert.equal(record.targetRemediationSha, previous.targetRemediationSha);
    assert.equal(record.liveRetryLaunchRequestId, 'synthetic-retry-leaf');
    if (targetHead !== head) {
      const targetIdentity = { repo: 'fixture/repo', prNumber: 42, headSha: targetHead };
      const targetRecord = JSON.parse(readFileSync(amaCloserDispatchFilePath(root, targetIdentity)));
      assert.equal(targetRecord.state, 'no-dispatch');
      assert.equal(targetRecord.reason, 'dispatch-retry-live');
      assert.equal(targetRecord.retryOwnerHeadSha, head);
      assert.equal(targetRecord.launchRequestId, null);
      assert.equal(targetRecord.scratchDir, null);
      assert.equal(readAmaCloserLease(root, targetIdentity), null);
      // The next admission reads the target's pointer rather than inheriting
      // launch ownership or spending an attempt on another claim refusal.
      const next = await maybeDispatchAmaCloser({ ...retryArgs,
        reviewState: { ...retryArgs.reviewState, headSha: targetHead },
        dispatchContext: { ...retryArgs.dispatchContext, reviewedSha: targetHead,
          dispatchRecordHeadSha: targetHead },
        readLaunchRequestStatusImpl: readLaunchRequestStatusFromLedgerAsync,
        execFileImpl: async () => assert.fail('the predecessor retry already owns this admission'),
      });
      assert.equal(next.reason, 'dispatch-retry-live');
      assert.equal(next.launchRequestId, previous.launchRequestId);
      assert.equal(readFileSync(helper, 'utf8'), 'synthetic phase helper');
      assert.equal(JSON.parse(readFileSync(path)).retryCount, previous.retryCount);
    }
    assert.equal(existsSync(attemptedPrompt), false);
    assert.equal(existsSync(unlaunchedScratch), false);
  });
}

test('SCRATCHRACE-01: ordinary redispatch failure still cleans terminal predecessor and unlaunched scratch', async t => {
  const root = fixture(t);
  const args = dispatchArgs(root);
  const first = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  const previousScratch = readFileSync(first.promptPath, 'utf8').split('scratch=')[1];
  const ledgerTarget = launchRetryFixture(root, 'failed');
  let newScratch;
  const result = await maybeDispatchAmaCloser({ ...args,
    dispatchContext: { ...args.dispatchContext, ledgerTarget },
    readPullRequestStateImpl: () => ({ state: 'OPEN' }),
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv.includes('--prompt')) {
        newScratch = readFileSync(argv[argv.indexOf('--prompt') + 1], 'utf8').split('scratch=')[1];
        throw new Error('synthetic permanent refusal');
      }
      return { stdout: JSON.stringify({ status: 'failed' }) };
    },
  });
  assert.equal(result.reason, 'dispatch-failed', JSON.stringify(result));
  assert.ok(newScratch);
  assert.equal(existsSync(newScratch), false);
  assert.equal(existsSync(previousScratch), false);
});

for (const predecessor of [true, false]) {
  test(`SCRATCHRACE-01: unproven live-claim refusal is charged (predecessor=${predecessor})`, async t => {
    const root = fixture(t);
    const args = dispatchArgs(root);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    if (predecessor) await maybeDispatchAmaCloser({ ...args,
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
    const ledgerTarget = launchRetryFixture(root, 'failed');
    const result = await maybeDispatchAmaCloser({ ...args,
      dispatchContext: { ...args.dispatchContext, ledgerTarget },
      readPullRequestStateImpl: () => ({ state: 'OPEN' }),
      execFileImpl: async (_cmd, argv) => {
        if (argv[0] === 'dispatch' && argv.includes('--prompt')) throw Object.assign(new Error('synthetic refusal'), {
          stderr: 'duplicate key value violates unique constraint "uq_worker_runs_live_logical_job"',
        });
        return { stdout: JSON.stringify({ status: 'failed' }) };
      },
    });
    assert.equal(result.reason, 'dispatch-failed', JSON.stringify(result));
    assert.equal(result.skipMergeAgent, false);
    const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(root, identity)));
    assert.equal(record.retryCount, predecessor ? 2 : 1);
    assert.equal(record.state, 'dispatch-failed');
    assert.equal(record.launchRequestId, null);
    assert.equal(readAmaCloserLease(root, identity), null, 'no unknown LRQ lease is invented');
    if (predecessor) {
      let pages = 0;
      const cappedArgs = { ...args, dispatchContext: { ...args.dispatchContext, ledgerTarget },
        deliverAlertImpl: async () => { pages += 1; return { ok: true }; },
        execFileImpl: async () => assert.fail('the fast retry cap must stop admission'),
      };
      const capped = await maybeDispatchAmaCloser(cappedArgs);
      assert.equal(capped.reason, 'dispatch-refusal-slow-retry-wait');
      const exhausted = await maybeDispatchAmaCloser({ ...cappedArgs,
        dispatchContext: { ...cappedArgs.dispatchContext, dispatchedAt: '2026-10-01T07:00:00Z' },
      });
      assert.equal(exhausted.reason, 'dispatch-retry-exhausted');
      assert.equal(Boolean(exhausted.skipMergeAgent), false);
      assert.ok(pages > 0, 'bounded refusal recovery pages the operator');
    }
  });
}

for (const [leasePresent, failureCode] of [[true, 'ETIMEDOUT'], [false, 'ABORT_ERR'], [true, 'malformed-output']])
test(`RETRYCHAIN-02: unreadable retry evidence logs ${failureCode} and preserves ownership (lease=${leasePresent})`, async t => {
  const root = fixture(t);
  const args = dispatchArgs(root);
  const first = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
  const path = amaCloserDispatchFilePath(root, identity);
  const before = readFileSync(path, 'utf8');
  let reads = 0;
  const probe = () => readLaunchRequestStatusFromLedgerAsync({ launchRequestId: 'synthetic-lrq',
    includeRetryChain: true, ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' },
    spawnSyncImpl: () => ++reads % 2 === 1
      ? { status: 0, stdout: JSON.stringify({ launch_request_id: 'synthetic-lrq', status: 'failed' }) }
      : failureCode === 'malformed-output'
        ? { status: 0, stdout: '{"launch_request_id":"synthetic-row-payload",' }
        : { status: null, error: Object.assign(new Error('The operation was aborted\nDETAIL: synthetic-row-payload'), { code: failureCode }) },
  });
  const events = [];
  const diagnosticLogger = { ...logger, warn: line => events.push(JSON.parse(line)) };
  assert.equal(reconcileAmaCloserLease({ rootDir: root, ...identity, logger,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' }, retryChainUnreadable: true }) }), false);
  if (!leasePresent) deleteAmaCloserLease(root, identity);
  const result = await maybeDispatchAmaCloser({ ...args, logger: diagnosticLogger, readLaunchRequestStatusImpl: probe,
    execFileImpl: async () => assert.fail('incomplete retry evidence cannot authorize dispatch') });
  assert.equal(result.reason, 'dispatch-retry-chain-unreadable');
  const diagnostic = events.filter(event => event.event === 'ama_closer.retry_chain_unreadable');
  assert.equal(diagnostic.length, 1);
  assert.equal(diagnostic[0].reason, 'ledger-read-failed');
  assert.equal(diagnostic[0].detail, failureCode === 'ETIMEDOUT' ? 'psql timed out after 30000ms'
    : failureCode === 'malformed-output' ? 'unparseable psql stdout' : 'The operation was aborted');
  assert.ok(diagnostic[0].elapsedMs >= 0);
  assert.equal(Object.hasOwn(diagnostic[0], 'row'), false);
  assert.equal(Object.hasOwn(diagnostic[0], 'target'), false);
  assert.doesNotMatch(JSON.stringify(diagnostic[0]), /synthetic-row-payload/);
  const scan = await reconcileAmaCloserDispatches(root, { logger, readLaunchRequestStatusImpl: probe });
  assert.equal(scan.changed, 0);
  assert.equal(scan.active.length, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(existsSync(first.promptPath), true);
  assert.equal(existsSync(JSON.parse(before).scratchDir), true);
});

test('SCRATCHRACE-01: retry traversal failure during refusal is charged without deleting predecessor artifacts', async t => {
  const root = fixture(t);
  const args = dispatchArgs(root);
  const first = await maybeDispatchAmaCloser({ ...args,
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
  const path = amaCloserDispatchFilePath(root, identity);
  const previous = JSON.parse(readFileSync(path));
  let refused = false;
  const result = await maybeDispatchAmaCloser({ ...args,
    readPullRequestStateImpl: () => ({ state: 'OPEN' }),
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' },
      ...(refused ? { retryChainUnreadable: true } : { retryChain: [] }) }),
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv.includes('--prompt')) {
        refused = true;
        throw new Error('uq_worker_runs_live_logical_job');
      }
      return { stdout: JSON.stringify({ status: 'failed' }) };
    },
  });
  assert.equal(result.reason, 'dispatch-failed');
  assert.equal(result.skipMergeAgent, true, 'incomplete retry evidence prevents fallback spawning');
  const record = JSON.parse(readFileSync(path));
  assert.equal(record.state, 'dispatch-failed');
  assert.equal(record.retryCount, previous.retryCount + 1);
  assert.equal(record.launchRequestId, previous.launchRequestId);
  assert.equal(readAmaCloserLease(root, identity), null);
  assert.equal(existsSync(previous.scratchDir), true);
  assert.equal(existsSync(first.promptPath), true);
});

for (const evidence of ['missing', 'unreadable', 'retry-chain-unreadable']) {
  test(`SCRATCHRACE-01: ${evidence} historical terminal probe cannot poison live-record reconciliation`, async t => {
    const root = fixture(t);
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
    const historicalScratch = createHammerScratchDir(root);
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
      launchRequestId: 'synthetic-historical', lastObservedStatus: 'failed', scratchDir: historicalScratch, promptDir: root,
      lastObservedAt: '2026-10-01T00:00:00Z' }));
    // Install artifacts after the writer's normal terminal cleanup.
    mkdirSync(historicalScratch, { recursive: true });
    const liveIdentity = { ...identity, prNumber: 43 };
    updateAmaCloserDispatchRecord(root, liveIdentity, () => ({ ...liveIdentity, state: 'dispatched',
      launchRequestId: 'synthetic-missing', lastObservedStatus: 'running',
      lastObservedAt: '2026-10-01T00:00:00Z' }));
    const healthyIdentity = { ...identity, prNumber: 44 };
    updateAmaCloserDispatchRecord(root, healthyIdentity, () => ({ ...healthyIdentity, state: 'dispatched',
      launchRequestId: 'synthetic-healthy', lastObservedStatus: 'running' }));
    const scan = await reconcileAmaCloserDispatches(root, { logger, now: '2026-10-02T00:00:00Z',
      readLaunchRequestStatusImpl: ({ launchRequestId }) => launchRequestId === 'synthetic-healthy'
        ? { ok: true, row: { status: 'failed' } }
        : launchRequestId === 'synthetic-historical' && evidence === 'retry-chain-unreadable'
          ? { ok: true, row: { status: 'failed' }, retryChainUnreadable: true }
        : { ok: false, reason: launchRequestId === 'synthetic-historical' && evidence === 'unreadable'
          ? 'synthetic-unreadable' : 'missing-launch-request-row' } });
    const historical = JSON.parse(readFileSync(amaCloserDispatchFilePath(root, identity)));
    assert.equal(historical.lastObservedStatus, 'failed');
    assert.equal(historical.terminalLaunchStatus, undefined);
    assert.equal(existsSync(historicalScratch), true);
    assert.equal(scan.unreadable, 0);
    assert.equal(scan.missing, 1);
    assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(root, liveIdentity))).terminalLaunchStatus, 'not-found');
  });
}

test('SCRATCHRACE-01: interrupted admission still cleans terminal scratch belonging to another PR', async t => {
  const root = fixture(t);
  const args = dispatchArgs(root);
  const identity = { repo: 'fixture/repo', prNumber: 43, headSha: head };
  const scratchDir = createHammerScratchDir(root);
  updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched',
    launchRequestId: 'synthetic-other', lastObservedStatus: 'running', scratchDir, promptDir: root,
    lastObservedAt: args.dispatchContext.dispatchedAt }));
  const controller = new AbortController();
  await assert.rejects(maybeDispatchAmaCloser({ ...args, signal: controller.signal,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }),
    observeCloserBacklogImpl: async () => {
      controller.abort(new Error('synthetic admission abort'));
      return 0;
    },
    execFileImpl: async () => assert.fail('aborted admission cannot launch'),
  }), /synthetic admission abort/);
  assert.equal(existsSync(scratchDir), false);
});

for (const interrupted of ['prelaunch', 'dispatch']) {
  test(`SCRATCHRACE-01: ${interrupted} admission abort preserves deferred predecessor artifacts`, async t => {
    const root = fixture(t);
    const args = dispatchArgs(root);
    const first = await maybeDispatchAmaCloser({ ...args,
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq' }) }) });
    const previousScratch = readFileSync(first.promptPath, 'utf8').split('scratch=')[1];
    const helper = join(previousScratch, 'synthetic-phase.sh');
    writeFileSync(helper, 'synthetic phase helper');
    const controller = new AbortController();
    let newPrompt;
    let newScratch;
    await assert.rejects(maybeDispatchAmaCloser({ ...args, signal: controller.signal,
      dispatchContext: { ...args.dispatchContext, ledgerTarget: launchRetryFixture(root, 'failed') },
      readPullRequestStateImpl: () => ({ state: 'OPEN' }),
      // The harness resolves after terminal predecessor cleanup is deferred,
      // but before a new attempt can launch.
      resolveCloserDispatchHarnessImpl: async () => {
        if (interrupted === 'prelaunch') controller.abort(new Error('synthetic admission abort'));
        controller.signal.throwIfAborted();
        return { workerClass: 'hammer', fellBack: false };
      },
      execFileImpl: async (_cmd, argv) => {
        if (argv[0] === 'dispatch' && argv.includes('--prompt')) {
          newPrompt = argv[argv.indexOf('--prompt') + 1];
          newScratch = readFileSync(newPrompt, 'utf8').split('scratch=')[1];
          controller.abort(new Error('synthetic admission abort'));
          throw controller.signal.reason;
        }
        return { stdout: JSON.stringify({ status: 'failed' }) };
      },
    }), /synthetic admission abort/);
    assert.equal(readFileSync(helper, 'utf8'), 'synthetic phase helper');
    assert.equal(existsSync(first.promptPath), true);
    if (interrupted === 'dispatch') {
      assert.ok(newScratch);
      assert.equal(existsSync(newScratch), false);
      assert.equal(existsSync(newPrompt), false);
    }
  });
}
