// REMCONFLICT-01 (SEV1, 2026-10-10): remediation can start on a CONFLICTING PR,
// and an accepted retrigger always reports what happened. The hold side (a
// CONFLICTING PR is never held) lives next to the NOOWNER-01 hold cases in
// test/noowner-01.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { buildLegacyHqRemediationDispatchArgs } from '../src/remediation-dispatch-mode.mjs';
import {
  _resetConflictedBaseSupportCacheForTests,
  CONFLICTED_BASE_UNSUPPORTED_STOP_CODE,
  gateRemediationConflictedBase,
  MERGEABILITY_READ_ATTEMPTS,
  resolveRemediationConflictedBase,
} from '../src/remediation-conflicted-base.mjs';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  getFollowUpJobDir,
  isRetriggerableStoppedFollowUpJob,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  readFollowUpJob,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  DEFAULT_RETRIGGER_OUTCOME_TIMEOUT_MS,
  RETRIGGER_REMEDIATION_LABEL,
  reportStalledRetriggerOutcomes,
  resolveRetriggerOutcomeTimeoutMs,
  tryRetriggerRemediationFromLabel,
} from '../src/follow-up-retrigger-label.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';

const REPO = 'laceyenterprises/agent-os';
const HELP_WITH_FLAG = 'usage: hq dispatch [--branch BRANCH] [--allow-conflicted-base] [--slug SLUG]\n';
const HELP_WITHOUT_FLAG = 'usage: hq dispatch [--branch BRANCH] [--slug SLUG]\n';
const NO_SLEEP = async () => {};

function tmpRoot(t, prefix) {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// hq-mode remediation env: `orchestrationMode: 'native'` builds the legacy hq
// argv (the transport the flag rides on); 'agentos' is the App Contract mode.
async function withHqRemediationEnv(rootDir, { orchestrationMode = 'native' } = {}, run) {
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({
    ownerUser: process.env.USER || process.env.LOGNAME || 'unknown',
  }), 'utf8');
  const codexHome = path.join(rootDir, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'a', refresh_token: 'b' },
  }), 'utf8');
  const overrides = {
    HOME: rootDir,
    CODEX_HOME: codexHome,
    CODEX_AUTH_PATH: path.join(codexHome, 'auth.json'),
    CODEX_CLI_PATH: 'codex',
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: orchestrationMode,
    ADV_WITH_HQ_INTEGRATION: '1',
    HQ_ROOT: hqRoot,
    HQ_PARENT_SESSION: 'sess_parent_remconflict',
    HQ_PROJECT: 'adversarial-review',
    HQ_BIN: undefined,
    APP_CONTRACT_ENDPOINT_URL: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run(hqRoot);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedJob(rootDir, prNumber) {
  return createFollowUpJob({
    rootDir,
    repo: REPO,
    prNumber,
    reviewerModel: 'claude',
    linearTicketId: `LAC-${prNumber}`,
    reviewBody: '## Summary\nFix the conflicting branch.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-10-10T20:00:00.000Z',
    critical: true,
  });
}

function hqStub({ calls, hqRoot, prNumber, mergeability, helpText = HELP_WITH_FLAG }) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh' && args[0] === 'api' && /\/pulls\//.test(args[1])) {
      return {
        stdout: JSON.stringify({
          base: { ref: 'main' },
          head: { ref: `codex/fix-pr-${prNumber}`, repo: { full_name: REPO } },
        }),
        stderr: '',
      };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable,mergeStateStatus')) {
      return { stdout: JSON.stringify(mergeability), stderr: '' };
    }
    if (command === 'hq' && args[0] === 'dispatch' && args[1] === '--help') {
      return { stdout: helpText, stderr: '' };
    }
    if (command === 'hq' && args[0] === 'dispatch' && args[1] === 'status') {
      return {
        stdout: JSON.stringify({ status: 'queued', workspacePath: path.join(hqRoot, 'workers', `lrq_pr_${prNumber}`) }),
        stderr: '',
      };
    }
    if (command === 'hq' && args[0] === 'dispatch') {
      return { stdout: JSON.stringify({ launchRequestId: `lrq_pr_${prNumber}`, dispatchId: `dispatch_pr_${prNumber}` }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

const hqLaunchArgv = (calls) => calls.filter((call) => call[0] === 'hq' && call[1] === 'dispatch'
  && call[2] !== 'status' && call[2] !== '--help');
const helpProbes = (calls) => calls.filter((call) => call[0] === 'hq' && call[2] === '--help');
const mergeabilityReads = (calls) => calls.filter((call) => call[0] === 'gh' && call.includes('mergeable,mergeStateStatus'));
const gate = (args) => gateRemediationConflictedBase({ ...args, sleepImpl: NO_SLEEP });

async function consumeOnce(rootDir, hqRoot, { prNumber, mergeability, helpText, gateImpl = gate, postCommentImpl, at = '2026-10-10T23:30:00.000Z' }) {
  const calls = [];
  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'You are a remediation worker.',
    now: () => at,
    execFileImpl: hqStub({ calls, hqRoot, prNumber, mergeability, helpText }),
    spawnImpl: () => {
      throw new Error('the local spawn path must not run in hq mode');
    },
    conflictedBaseGateImpl: gateImpl,
    ...(postCommentImpl ? { postCommentImpl } : {}),
  });
  return { result, calls };
}

test('argv builder: only allowConflictedBase adds --allow-conflicted-base; the default argv is unchanged', () => {
  const base = {
    ticketRef: 'job-1', workerClass: 'codex', repo: REPO, prNumber: 8022, branch: 'codex/fix',
    promptPath: '/p/prompt.md', parentSession: 'sess', project: 'adversarial-review', hqRoot: '/hq',
  };
  const plain = buildLegacyHqRemediationDispatchArgs(base);
  assert.deepEqual(buildLegacyHqRemediationDispatchArgs({ ...base, allowConflictedBase: false }), plain);
  assert.equal(plain.includes('--allow-conflicted-base'), false);
  const conflicted = buildLegacyHqRemediationDispatchArgs({ ...base, allowConflictedBase: true });
  assert.deepEqual(conflicted.filter((arg) => arg !== '--allow-conflicted-base'), plain);
  assert.equal(conflicted.filter((arg) => arg === '--allow-conflicted-base').length, 1);
});

test('a CONFLICTING PR\'s remediation hq dispatch carries --allow-conflicted-base; a mergeable PR\'s argv does not', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-argv-');
  await withHqRemediationEnv(rootDir, {}, async (hqRoot) => {
    // agent-os PR 8022: CONFLICTING. Before REMCONFLICT-01 this argv had no
    // flag, and provisioning died on its trunk rebase before the worker existed.
    seedJob(rootDir, 8022);
    const conflicting = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8022, mergeability: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    });
    assert.equal(conflicting.result.consumed, true, JSON.stringify(conflicting.result));
    const [conflictedArgv] = hqLaunchArgv(conflicting.calls);
    assert.ok(conflictedArgv, JSON.stringify(conflicting.calls));
    assert.ok(conflictedArgv.includes('--allow-conflicted-base'), conflictedArgv.join(' '));
    assert.equal(conflictedArgv[conflictedArgv.indexOf('--branch') + 1], 'codex/fix-pr-8022');
    assert.equal(helpProbes(conflicting.calls).length, 1, 'support is probed through hq dispatch --help');
    assert.equal(conflicting.result.job.conflictedBaseGate.decision, 'allow-conflicted-base');
    assert.equal(conflicting.result.job.conflictedBaseGate.mergeability, 'CONFLICTING');

    // agent-os PR 8025: clean. Same argv as a dispatch with no gate at all.
    seedJob(rootDir, 8025);
    const mergeable = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8025, mergeability: { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' },
    });
    assert.equal(mergeable.result.consumed, true, JSON.stringify(mergeable.result));
    const [mergeableArgv] = hqLaunchArgv(mergeable.calls);
    assert.equal(mergeableArgv.includes('--allow-conflicted-base'), false, mergeableArgv.join(' '));
    assert.equal(helpProbes(mergeable.calls).length, 0, 'a mergeable PR never probes hq');
    assert.equal(mergeable.result.job.conflictedBaseGate.decision, 'unchanged-argv');

    seedJob(rootDir, 8026);
    const ungated = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8026, mergeability: { mergeable: 'MERGEABLE' }, gateImpl: null,
    });
    const [ungatedArgv] = hqLaunchArgv(ungated.calls);
    const shape = (argv) => argv.map((arg) => (arg.startsWith('--') ? arg : '<value>'));
    assert.deepEqual(shape(mergeableArgv), shape(ungatedArgv), 'a mergeable PR keeps the pre-REMCONFLICT-01 argv');
    assert.deepEqual(shape(conflictedArgv).filter((arg) => arg !== '--allow-conflicted-base'), shape(ungatedArgv));
  });
});

test('in agent-os app mode a CONFLICTING PR takes the direct hq transport, which can carry the flag', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-appmode-');
  // No App Contract endpoint is configured: routing this round through it would fail the dispatch.
  await withHqRemediationEnv(rootDir, { orchestrationMode: 'agentos' }, async (hqRoot) => {
    seedJob(rootDir, 8017);
    const { result, calls } = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8017, mergeability: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    });
    assert.equal(result.consumed, true, JSON.stringify(result));
    const [argv] = hqLaunchArgv(calls);
    assert.ok(argv?.includes('--allow-conflicted-base'), JSON.stringify(calls));
    assert.ok(argv.includes('--pr') && argv.includes('--branch'), 'the flag needs the existing PR branch');
  });
});

test('UNKNOWN mergeability is re-read and never dispatched as clean: an unresolved read passes the flag when hq has it', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-unknown-');
  await withHqRemediationEnv(rootDir, {}, async (hqRoot) => {
    const created = seedJob(rootDir, 8030);
    const { result, calls } = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8030, mergeability: { mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' },
    });
    assert.equal(result.consumed, true, JSON.stringify(result));
    assert.equal(mergeabilityReads(calls).length, MERGEABILITY_READ_ATTEMPTS, 'the read is re-sampled over the bounded window');
    const [argv] = hqLaunchArgv(calls);
    assert.ok(argv.includes('--allow-conflicted-base'), 'UNKNOWN+CLEAN is not read as clean');
    assert.equal(result.job.conflictedBaseGate.basis, 'mergeability-unresolved');
    assert.equal(result.job.jobId, created.job.jobId);
  });

  // A read that resolves mid-window is used as soon as it does.
  const readings = [{ mergeable: 'UNKNOWN' }, { mergeable: 'UNKNOWN' }, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }];
  const resolving = async (command) => {
    assert.equal(command, 'gh', 'a mergeable PR never probes hq');
    return { stdout: JSON.stringify(readings.shift()), stderr: '' };
  };
  assert.deepEqual(
    await resolveRemediationConflictedBase({ job: { repo: REPO, prNumber: 8030 }, env: {}, execFileImpl: resolving, sleepImpl: NO_SLEEP }),
    { action: 'dispatch', allowConflictedBase: false, mergeability: 'MERGEABLE', basis: 'mergeable', samples: 3 },
  );

  // Without hq support an unresolved read keeps the pre-REMCONFLICT-01 argv rather than strand the job.
  _resetConflictedBaseSupportCacheForTests();
  const unsupported = async (command) => (command === 'hq'
    ? { stdout: HELP_WITHOUT_FLAG, stderr: '' }
    : { stdout: JSON.stringify({ mergeable: 'UNKNOWN' }), stderr: '' });
  const decision = await resolveRemediationConflictedBase({
    job: { repo: REPO, prNumber: 8030 }, env: {}, execFileImpl: unsupported, sleepImpl: NO_SLEEP,
  });
  assert.equal(decision.action, 'dispatch');
  assert.equal(decision.allowConflictedBase, false);
});

test('a CONFLICTING PR on an hq without the flag stops hq-conflicted-base-unsupported: retriggerable, no round spent, one comment', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-unsupported-');
  await withHqRemediationEnv(rootDir, {}, async (hqRoot) => {
    const created = seedJob(rootDir, 8022);
    const comments = [];
    const { result, calls } = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8022,
      mergeability: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      helpText: HELP_WITHOUT_FLAG,
      postCommentImpl: async (args) => { comments.push(args); return { posted: true }; },
    });
    assert.equal(result.reason, CONFLICTED_BASE_UNSUPPORTED_STOP_CODE);
    assert.equal(hqLaunchArgv(calls).length, 0);
    const stopped = readFollowUpJob(path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(created.jobPath)));
    assert.equal(stopped.remediationPlan.stop.code, CONFLICTED_BASE_UNSUPPORTED_STOP_CODE);
    assert.match(stopped.remediationPlan.stop.reason, /--allow-conflicted-base/);
    assert.equal(stopped.remediationWorker.state, 'never-spawned');
    assert.equal(isRetriggerableStoppedFollowUpJob(stopped), true);
    assert.equal(comments.length, 1);
  });
});

test('a failed hq dispatch --help probe is retried once and never cached; a CONFLICTING PR then stops with the cause', async () => {
  _resetConflictedBaseSupportCacheForTests();
  let probes = 0;
  const failingHq = async (command) => {
    if (command === 'hq') {
      probes += 1;
      throw Object.assign(new Error('hq: command not found'), { code: 'ENOENT' });
    }
    return { stdout: JSON.stringify({ mergeable: 'CONFLICTING' }), stderr: '' };
  };
  const job = { repo: REPO, prNumber: 8017 };
  const decision = await resolveRemediationConflictedBase({ job, env: {}, execFileImpl: failingHq, sleepImpl: NO_SLEEP });
  assert.equal(decision.action, 'stop');
  assert.equal(decision.stopCode, CONFLICTED_BASE_UNSUPPORTED_STOP_CODE);
  assert.match(decision.stopReason, /could not be confirmed/);
  assert.equal(probes, 2);
  const healthyHq = async (command) => (command === 'hq'
    ? { stdout: HELP_WITH_FLAG, stderr: '' }
    : { stdout: JSON.stringify({ mergeable: 'CONFLICTING' }), stderr: '' });
  const recovered = await resolveRemediationConflictedBase({ job, env: {}, execFileImpl: healthyHq, sleepImpl: NO_SLEEP });
  assert.equal(recovered.allowConflictedBase, true, 'a failed probe is not remembered as unsupported');
});

for (const diagnostic of [
  { code: 'EIO' },
  { code: 'ETIMEDOUT' },
  { code: null, killed: true, signal: 'SIGTERM' },
]) {
  test(`transient help probe ${JSON.stringify(diagnostic)} propagates without caching an unsupported answer`, async () => {
    _resetConflictedBaseSupportCacheForTests();
    const error = Object.assign(new Error('help probe failed'), diagnostic);
    let probes = 0;
    const job = { repo: REPO, prNumber: 8017 };
    const execFileImpl = async (command) => {
      if (command === 'hq') {
        probes += 1;
        if (probes === 1) throw error;
        return { stdout: HELP_WITH_FLAG };
      }
      return { stdout: JSON.stringify({ mergeable: 'CONFLICTING' }) };
    };
    await assert.rejects(resolveRemediationConflictedBase({ job, env: {}, execFileImpl, sleepImpl: NO_SLEEP }),
      (err) => err === error && err.isConflictedBaseProbeTransientError === true);
    assert.equal(probes, 1);
    assert.equal((await resolveRemediationConflictedBase({ job, env: {}, execFileImpl, sleepImpl: NO_SLEEP })).allowConflictedBase, true);
    assert.equal(probes, 2);
  });
}

test('a transient probe requeues the same round with backoff and operator override; recovery dispatches', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-probe-retry-');
  await withHqRemediationEnv(rootDir, {}, async (hqRoot) => {
    const created = seedJob(rootDir, 8017);
    writeFollowUpJob(created.jobPath, {
      ...created.job,
      remediationPlan: { ...created.job.remediationPlan, nextAction: { ...created.job.remediationPlan.nextAction, operatorOverride: true } },
    });
    const error = Object.assign(new Error('probe disk unavailable'), { code: 'EIO' });
    const failed = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8017,
      mergeability: { mergeable: 'CONFLICTING' },
      gateImpl: (args) => gate({ ...args, execFileImpl: async (command, ...rest) => {
        if (command === 'hq') throw error;
        return args.execFileImpl(command, ...rest);
      } }),
    });
    assert.equal(failed.result.reason, 'hq-conflicted-base-probe-transient');
    assert.equal(failed.result.job.status, 'pending');
    assert.equal(failed.result.job.remediationPlan.currentRound, 0);
    assert.equal(failed.result.job.remediationPlan.transientRetries, 1);
    assert.equal(failed.result.job.remediationPlan.nextAction.operatorOverride, true);
    assert.equal(failed.result.job.remediationPlan.retryHistory.at(-1).retryMetadata.code, 'hq-conflicted-base-probe-transient');
    assert.equal(hqLaunchArgv(failed.calls).length, 0);
    const recovered = await consumeOnce(rootDir, hqRoot, {
      prNumber: 8017, mergeability: { mergeable: 'CONFLICTING' }, at: failed.result.job.remediationPlan.retryAfter,
    });
    assert.equal(recovered.result.consumed, true);
    assert.equal(recovered.result.job.remediationPlan.currentRound, 1);
  });
});

test('transient probe exhaustion fails with its diagnostic instead of claiming hq is unsupported', async (t) => {
  _resetConflictedBaseSupportCacheForTests();
  const rootDir = tmpRoot(t, 'remconflict-probe-exhausted-');
  await withHqRemediationEnv(rootDir, {}, async (hqRoot) => {
    const created = seedJob(rootDir, 8017);
    writeFollowUpJob(created.jobPath, { ...created.job, remediationPlan: { ...created.job.remediationPlan, transientRetries: 1000 } });
    await assert.rejects(consumeOnce(rootDir, hqRoot, {
      prNumber: 8017, mergeability: { mergeable: 'CONFLICTING' },
      gateImpl: (args) => gate({ ...args, execFileImpl: async (command, ...rest) => {
        if (command === 'hq') throw Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' });
        return args.execFileImpl(command, ...rest);
      } }),
      postCommentImpl: async () => ({ posted: true }),
    }), /probe timed out/);
    const failed = readFollowUpJob(path.join(getFollowUpJobDir(rootDir, 'failed'), path.basename(created.jobPath)));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure.code, 'hq-conflicted-base-probe-retries-exhausted');
    assert.match(failed.failure.message, /probe timed out/);
    assert.equal(failed.remediationWorker.state, 'never-spawned');
  });
});

// ── Accepted retrigger outcome ───────────────────────────────────────────────
// agent-os PRs 8022 / 8017 / 8025: label applied 20:36Z, consumed as accepted
// at 20:39Z, and nothing visible happened afterwards.
const CONSUMED_AT = '2026-10-10T20:39:00.000Z';
const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function seedStoppedJob(rootDir, prNumber) {
  const created = seedJob(rootDir, prNumber);
  writeFollowUpJob(created.jobPath, {
    ...created.job,
    status: 'stopped',
    remediationPlan: { ...created.job.remediationPlan, currentRound: 2, maxRounds: 2, stop: { code: 'max-rounds-reached' } },
  });
  return created;
}

function commentRecorder() {
  const gh = [];
  return {
    gh,
    posts: () => gh.filter((args) => args[0] === 'pr' && args[1] === 'comment'),
    execFileImpl: async (command, args) => {
      if (command !== 'gh') return { stdout: '', stderr: '' };
      gh.push(args);
      if (args[0] === 'api' && args[1] === '--paginate') {
        // Comments already on the PR, so the marker lookup dedupes a re-post.
        const bodies = gh.filter((call) => call[0] === 'pr' && call[1] === 'comment').map((call, index) => ({
          id: index + 1, body: call[call.indexOf('--body') + 1],
        }));
        return { stdout: bodies.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  };
}

async function acceptRetrigger(rootDir, prNumber, recorder, auditRows) {
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: REPO,
    prNumber,
    labelEvent: {
      id: `evt-${prNumber}`, actor: 'VirtualPaul', createdAt: '2026-10-10T20:36:00.000Z',
      label: RETRIGGER_REMEDIATION_LABEL, headSha: `head${prNumber}`,
    },
    revisionRef: `head${prNumber}`,
    execFileImpl: recorder.execFileImpl,
    appendAuditRow: (_root, row) => auditRows.push(row),
    now: () => CONSUMED_AT,
  });
  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.match(recorder.posts()[0].at(-1), /Remediation retrigger accepted/);
  return result;
}

test('an accepted retrigger whose claim is refused produces exactly one outcome comment and one audit row', async (t) => {
  const rootDir = tmpRoot(t, 'remconflict-retrigger-refused-');
  seedStoppedJob(rootDir, 8022);
  const recorder = commentRecorder();
  const auditRows = [];
  await acceptRetrigger(rootDir, 8022, recorder, auditRows);

  // The hammer holds the closer lease, so the claim is refused and nothing spawns.
  acquireAmaCloserLease({ rootDir, repo: REPO, prNumber: 8022, headSha: 'head8022', watcherPid: process.pid, now: minutesAfter(CONSUMED_AT, 1) });
  const claim = claimNextFollowUpJob({ rootDir, claimedAt: minutesAfter(CONSUMED_AT, 2) });
  assert.equal(claim, null, 'the claim is refused while the closer lease is held');

  const sweep = (minutes) => reportStalledRetriggerOutcomes({
    rootDir,
    execFileImpl: recorder.execFileImpl,
    appendAuditRow: (_root, row) => auditRows.push(row),
    now: () => minutesAfter(CONSUMED_AT, minutes),
    env: {},
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(await sweep(5), { checked: 0, spawned: 0, reported: 0 }, 'inside the bounded window nothing is posted');
  assert.equal(recorder.posts().length, 1);

  assert.deepEqual(await sweep(11), { checked: 1, spawned: 0, reported: 1 });
  const outcomePosts = recorder.posts().slice(1);
  assert.equal(outcomePosts.length, 1);
  const body = outcomePosts[0].at(-1);
  assert.match(body, /Remediation retrigger did not start a worker/);
  assert.match(body, /Refusal: `closer-lease-held`/);
  assert.match(body, /Next: The hammer \(AMA closer\) owns this PR/);
  const outcomeAudit = auditRows.filter((row) => row.outcome === 'retrigger-not-actioned');
  assert.equal(outcomeAudit.length, 1);
  assert.equal(outcomeAudit[0].refusalCode, 'closer-lease-held');
  assert.equal(outcomeAudit[0].source, 'retrigger-outcome-watch');

  await sweep(20);
  await sweep(90);
  assert.equal(recorder.posts().length, 2, 'exactly one outcome comment, ever');
  assert.equal(auditRows.filter((row) => row.outcome === 'retrigger-not-actioned').length, 1);
  const consumptionDir = path.join(rootDir, 'data', 'follow-up-jobs', 'label-consumptions');
  const [name] = readdirSync(consumptionDir);
  const consumption = JSON.parse(readFileSync(path.join(consumptionDir, name), 'utf8'));
  assert.equal(consumption.outcomeReport.state, 'reported');
  assert.equal(consumption.outcomeReport.code, 'closer-lease-held');
});

test('a retrigger refused at consume reports the stop code; a spawned retrigger posts nothing', async (t) => {
  const rootDir = tmpRoot(t, 'remconflict-retrigger-outcomes-');
  const recorder = commentRecorder();
  const auditRows = [];

  // 8017: requeued, claimed, then stopped stale-review-head before spawn.
  seedStoppedJob(rootDir, 8017);
  await acceptRetrigger(rootDir, 8017, recorder, auditRows);
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: minutesAfter(CONSUMED_AT, 1) });
  assert.equal(claimed.job.prNumber, 8017);
  markFollowUpJobStopped({
    rootDir, jobPath: claimed.jobPath, stoppedAt: minutesAfter(CONSUMED_AT, 1),
    stopCode: 'stale-review-head', stopReason: 'PR head moved since the reviewed revision', sourceStatus: 'in_progress',
  });

  // 8025: requeued and a worker spawned two minutes later.
  seedStoppedJob(rootDir, 8025);
  await acceptRetrigger(rootDir, 8025, recorder, auditRows);
  const spawnedClaim = claimNextFollowUpJob({ rootDir, claimedAt: minutesAfter(CONSUMED_AT, 2) });
  assert.equal(spawnedClaim.job.prNumber, 8025);
  markFollowUpJobSpawned({
    rootDir, jobPath: spawnedClaim.jobPath, spawnedAt: minutesAfter(CONSUMED_AT, 2),
    worker: { model: 'codex', workerClass: 'codex', dispatchMode: 'hq', spawnedAt: minutesAfter(CONSUMED_AT, 2) },
  });

  const before = recorder.posts().length;
  const result = await reportStalledRetriggerOutcomes({
    rootDir,
    execFileImpl: recorder.execFileImpl,
    appendAuditRow: (_root, row) => auditRows.push(row),
    now: () => minutesAfter(CONSUMED_AT, 12),
    env: {},
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(result, { checked: 2, spawned: 1, reported: 1 });
  const posts = recorder.posts().slice(before);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][2], '8017');
  assert.match(posts[0].at(-1), /Refusal: `stale-review-head` \(PR head moved since the reviewed revision\)/);
  assert.match(posts[0].at(-1), /retrigger-review/);
});

test('the outcome watch skips labels older than a day and closes out a merged PR without a comment', async (t) => {
  const rootDir = tmpRoot(t, 'remconflict-retrigger-age-');
  const recorder = commentRecorder();
  const auditRows = [];
  seedStoppedJob(rootDir, 8022);
  await acceptRetrigger(rootDir, 8022, recorder, auditRows);
  const sweep = (minutes) => reportStalledRetriggerOutcomes({
    rootDir,
    execFileImpl: recorder.execFileImpl,
    appendAuditRow: (_root, row) => auditRows.push(row),
    now: () => minutesAfter(CONSUMED_AT, minutes),
    env: {},
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(await sweep(3 * 24 * 60), { checked: 0, spawned: 0, reported: 0 }, 'a first deploy does not comment on old labels');

  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: minutesAfter(CONSUMED_AT, 1) });
  markFollowUpJobStopped({
    rootDir, jobPath: claimed.jobPath, stoppedAt: minutesAfter(CONSUMED_AT, 1),
    stopCode: 'operator-merged-pr', stopReason: 'PR merged', sourceStatus: 'in_progress',
  });
  const posts = recorder.posts().length;
  assert.deepEqual(await sweep(15), { checked: 1, spawned: 0, reported: 0 });
  assert.equal(recorder.posts().length, posts, 'no comment on a merged PR');
  assert.deepEqual(await sweep(30), { checked: 0, spawned: 0, reported: 0 }, 'closed out once');
});

test('the outcome timeout is configurable and defaults to 10 minutes', () => {
  assert.equal(DEFAULT_RETRIGGER_OUTCOME_TIMEOUT_MS, 600_000);
  assert.equal(resolveRetriggerOutcomeTimeoutMs({}), 600_000);
  assert.equal(resolveRetriggerOutcomeTimeoutMs({ ADVERSARIAL_RETRIGGER_OUTCOME_TIMEOUT_MS: '120000' }), 120_000);
  assert.equal(resolveRetriggerOutcomeTimeoutMs({ ADVERSARIAL_RETRIGGER_OUTCOME_TIMEOUT_MS: 'soon' }), 600_000);
});

test('outcome scans bound every read, make progress past skipped records, and cache done files across ticks', async (t) => {
  const rootDir = tmpRoot(t, 'remconflict-scan-budget-');
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'label-consumptions');
  mkdirSync(dir, { recursive: true });
  const recorder = commentRecorder();
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(path.join(dir, `historical-${i}.json`), JSON.stringify({ outcomeReport: { done: true } }));
  }
  writeFileSync(path.join(dir, 'corrupt.json'), 'invalid json');
  writeFileSync(path.join(dir, 'young.json'), JSON.stringify({
    label: RETRIGGER_REMEDIATION_LABEL, auditStatus: 'written', auditRow: { outcome: 'bumped-and-requeued' },
    jobPath: '/pending/young.json', consumedAt: minutesAfter(CONSUMED_AT, 11),
  }));
  seedStoppedJob(rootDir, 8022);
  await acceptRetrigger(rootDir, 8022, recorder, []);
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && path.dirname(file) === dir) reads += 1;
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const sweep = () => reportStalledRetriggerOutcomes({
    rootDir, budget: 2, execFileImpl: recorder.execFileImpl,
    appendAuditRow() {}, now: () => minutesAfter(CONSUMED_AT, 12), logger: { log() {}, error() {} },
  });
  let reported = 0;
  for (let tick = 0; tick < 10; tick += 1) {
    reads = 0;
    reported += (await sweep()).reported;
    assert.ok(reads <= 2, `tick ${tick} read ${reads} consumption files`);
  }
  assert.equal(reported, 1, 'skipped files cannot starve the eligible receipt');
  let repeatedReads = 0;
  for (let tick = 0; tick < 10; tick += 1) {
    reads = 0;
    await sweep();
    assert.ok(reads <= 2);
    repeatedReads += reads;
  }
  assert.ok(repeatedReads <= 4, 'only the malformed and young receipts need another read per pass');
});
