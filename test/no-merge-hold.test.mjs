import { FakeClock } from './helpers/load-time-kit.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyNoMergeHold,
  parseArgs,
  resolveNoMergeHoldTimeoutMs,
  runNoMergeHoldCli,
} from '../src/no-merge-hold.mjs';
import { NO_MERGE_HOLD_LABEL } from '../src/follow-up-merge-agent.mjs';
import { rateLimitClock } from '../src/rate-limit-throttle.mjs';
import { meteredExecFile } from '../src/metered-gh.mjs';

test('parseArgs supports apply and resume modes', () => {
  assert.deepEqual(parseArgs([
    '--repo',
    'laceyenterprises/agent-os',
    '--pr=401',
    'freeze',
  ]), {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: false,
    reason: 'freeze',
  });
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/agent-os',
    '--pr',
    '401',
    '--resume',
  ]), {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: true,
    reason: 'Operator released no-merge hold.',
  });
});

test('applyNoMergeHold creates the repo label, applies it to the PR, and writes receipt', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const calls = [];
  const result = await applyNoMergeHold({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reason: 'release freeze',
    requestedAt: '2026-05-24T16:05:00.000Z',
    requestedBy: 'placey',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.held, true);
  assert.equal(result.label, NO_MERGE_HOLD_LABEL);
  assert.deepEqual(calls, [
    {
      cmd: 'gh',
      args: [
        'label',
        'create',
        NO_MERGE_HOLD_LABEL,
        '--repo',
        'laceyenterprises/agent-os',
        '--description',
        'Operator hold: block merge-agent and adversarial gate for this PR',
        '--color',
        'd93f0b',
        '--force',
      ],
    },
    {
      cmd: 'gh',
      args: [
        'pr',
        'edit',
        '401',
        '--repo',
        'laceyenterprises/agent-os',
        '--add-label',
        NO_MERGE_HOLD_LABEL,
      ],
    },
  ]);
  assert.equal(existsSync(result.receiptPath), true);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'adversarial-review-no-merge-hold');
  assert.equal(receipt.held, true);
  assert.equal(receipt.applied, true);
  assert.equal(receipt.reason, 'release freeze');
});

test('applyNoMergeHold removes the label on resume without recreating it', async () => {
  const calls = [];
  const result = await applyNoMergeHold({
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: true,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.held, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-2), ['--remove-label', NO_MERGE_HOLD_LABEL]);
});

test('applyNoMergeHold treats absent label as successful resume', async () => {
  const calls = [];
  const result = await applyNoMergeHold({
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: true,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const err = new Error('HTTP 422: label does not exist');
      err.stderr = 'label does not exist';
      throw err;
    },
  });

  assert.equal(result.held, false);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(result.receiptPath), true);
});

// NOMERGEHOLDHANG-01 — synthetic fixture values only.
const REPO = 'example-org/example-repo';
const PR = 4242;

function cliHarness() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    io: {
      log: line => lines.log.push(line),
      warn: line => lines.warn.push(line),
      error: line => lines.error.push(line),
    },
  };
}

function onlyReceipt(rootDir) {
  const dir = path.join(rootDir, 'data', 'operator-mutations', 'no-merge-holds');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, 'exactly one receipt per attempt');
  return JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'));
}

const neverResolvingMeter = () => new Promise(() => {});

for (const resume of [false, true]) {
  const mode = resume ? 'release' : 'hold';
  test(`a ${mode} whose meter wait never resolves exits non-zero within the bound and receipts applied=false`, { timeout: 10_000 }, async t => {
    const clock = new FakeClock(t, { wall: Date.now() });
    const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
    const spawned = [];
    const { lines, io } = cliHarness();
    const pending = runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR), ...(resume ? ['--resume'] : []), 'synthetic hold'], {
      ...io,
      rootDir,
      timeoutMs: 150,
      meteredExecFileImpl: neverResolvingMeter,
      execFileImpl: async (cmd, args) => { spawned.push(args); return { stdout: '', stderr: '' }; },
    });
    await clock.flush();
    await clock.advance(150);
    const code = await pending;
    assert.equal(code, 1);
    assert.equal(clock.monotonic(), 150);
    assert.deepEqual(spawned, []);
    assert.deepEqual(lines.log, []);
    assert.equal(lines.error.length, 1, 'one clear failure line');
    const [line] = lines.error;
    assert.doesNotMatch(line, /\n/);
    const step = resume ? 'gh pr edit' : 'gh label create';
    assert.match(line, new RegExp(`^\\[no-merge-hold\\] Failed: repo=${REPO} pr=${PR} timed out after 150ms waiting for GitHub metering/budget admission before spawning \`${step}\``));
    assert.match(line, / applied=false receipt=\S+no-merge-holds\S+\.json$/);
    const receipt = onlyReceipt(rootDir);
    assert.equal(receipt.kind, 'adversarial-review-no-merge-hold');
    assert.equal(receipt.applied, false);
    assert.equal(receipt.held, !resume);
    assert.equal(receipt.repo, REPO);
    assert.equal(receipt.prNumber, PR);
    assert.equal(receipt.reason, 'synthetic hold');
    assert.match(receipt.error, /waiting for GitHub metering\/budget admission/);
  });

  test(`a normal ${mode} through the CLI applies the label change and receipts applied=true`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
    const calls = [];
    const { lines, io } = cliHarness();
    const code = await runNoMergeHoldCli(['--repo', REPO, `--pr=${PR}`, ...(resume ? ['--resume'] : [])], {
      ...io,
      rootDir,
      execFileImpl: async (cmd, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines.error, []);
    assert.equal(lines.log.length, 1);
    assert.match(lines.log[0], new RegExp(`held=${!resume} applied=true repo=${REPO} pr=${PR}`));
    assert.deepEqual(calls.map(args => args.slice(0, 2)), resume ? [['pr', 'edit']] : [['label', 'create'], ['pr', 'edit']]);
    assert.deepEqual(calls.at(-1).slice(-2), [resume ? '--remove-label' : '--add-label', NO_MERGE_HOLD_LABEL]);
    const receipt = onlyReceipt(rootDir);
    assert.equal(receipt.applied, true);
    assert.equal(receipt.held, !resume);
    assert.equal(receipt.error, undefined);
  });

  test(`a ${mode} proceeds past an exhausted shared GitHub budget instead of sleeping until reset`, { timeout: 10_000 }, async t => {
    // The incident: an un-scoped metered call slept until the graphql bucket's
    // reset (up to an hour) before spawning gh, with no output and no child.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
    const statePath = path.join(rootDir, 'rate-limit-state.json');
    const saved = {};
    for (const key of ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = statePath;
    const observedAt = new Date().toISOString();
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(statePath, JSON.stringify({ version: 2, buckets: {
      core: { resource: 'core', remaining: 0, limit: 5000, observedAt, resetAt },
      graphql: { resource: 'graphql', remaining: 0, limit: 5000, observedAt, resetAt },
    } }), { mode: 0o600 });
    const sleeps = [];
    t.mock.method(rateLimitClock, 'sleep', async ms => { sleeps.push(ms); });
    const calls = [];
    const result = await applyNoMergeHold({
      rootDir,
      repo: REPO,
      prNumber: PR,
      resume,
      execFileImpl: async (cmd, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
    });
    assert.deepEqual(sleeps, [], 'no budget sleep before spawning gh');
    assert.equal(existsSync(`${statePath}.throttled.json`), false);
    assert.equal(calls.length, resume ? 1 : 2);
    assert.equal(result.receipt.applied, true);
  });
}

test('a gh call that never exits is named in the failure line and its receipt', { timeout: 10_000 }, async t => {
  const clock = new FakeClock(t, { wall: Date.now() });
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  let signal;
  const { lines, io } = cliHarness();
  const pending = runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR), '--resume'], {
    ...io,
    rootDir,
    timeoutMs: 150,
    execFileImpl: (cmd, args, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  await clock.flush();
  await clock.advance(150);
  const code = await pending;
  assert.equal(code, 1);
  assert.match(lines.error[0], /timed out after 150ms waiting for `gh pr edit` to exit/);
  assert.equal(signal.aborted, true, 'the hung gh child is signalled');
  assert.equal(onlyReceipt(rootDir).applied, null, 'a spawned mutation without a result is uncertain');
  assert.match(lines.error[0], /applied=unknown/);
});

test('a meter that resolves after the deadline never spawns gh', { timeout: 10_000 }, async t => {
  const clock = new FakeClock(t, { wall: Date.now() });
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  const spawned = [];
  let late;
  const rejection = assert.rejects(applyNoMergeHold({
    rootDir,
    repo: REPO,
    prNumber: PR,
    timeoutMs: 50,
    meteredExecFileImpl: (exec, cmd, args, options) => {
      late = new Promise(resolve => setTimeout(resolve, 200))
        .then(() => exec(cmd, args, options))
        .catch(err => err);
      return late;
    },
    execFileImpl: async (cmd, args) => { spawned.push(args); return { stdout: '', stderr: '' }; },
  }), { code: 'ETIMEDOUT', phase: 'admission' });
  await clock.flush();
  await clock.advance(50);
  await rejection;
  await clock.advance(150);
  const refused = await late;
  assert.equal(refused?.noMergeHoldTimeout, true);
  assert.deepEqual(spawned, []);
  assert.equal(onlyReceipt(rootDir).applied, false);
});

test('a rejected gh mutation is receipted as uncertain and is not mistaken for an absent label', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  const { lines, io } = cliHarness();
  const code = await runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR)], {
    ...io,
    rootDir,
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'label') return { stdout: '', stderr: '' };
      const err = new Error('Command failed: gh pr edit\nHTTP 403: Resource not accessible');
      err.stderr = 'HTTP 403: Resource not accessible';
      throw err;
    },
  });
  assert.equal(code, 1);
  assert.match(lines.error[0], /Command failed: gh pr edit HTTP 403: Resource not accessible applied=unknown/);
  const receipt = onlyReceipt(rootDir);
  assert.equal(receipt.applied, null);
  assert.match(receipt.error, /HTTP 403/);
});

test('the default bound is load-aware: 30s on an idle host, never above two minutes', () => {
  const timeoutMs = resolveNoMergeHoldTimeoutMs();
  assert.equal(timeoutMs, 30_000);
  assert.ok(timeoutMs <= 120_000);
});

test('a receipt write failure after the label landed reports applied=true, never applied=false', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  // A regular file where the receipt directory belongs makes every write fail.
  writeFileSync(path.join(rootDir, 'data'), 'not a directory');
  const { lines, io } = cliHarness();
  const code = await runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR)], {
    ...io,
    rootDir,
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
  });
  assert.equal(code, 1);
  assert.match(lines.error[0], /label change applied, but its receipt could not be written applied=true receipt-write-failed=/);
});

test('a failed attempt whose receipt cannot be written still says applied=false', async t => {
  const clock = new FakeClock(t, { wall: Date.now() });
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  writeFileSync(path.join(rootDir, 'data'), 'not a directory');
  const { lines, io } = cliHarness();
  const pending = runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR), '--resume'], {
    ...io,
    rootDir,
    timeoutMs: 50,
    meteredExecFileImpl: neverResolvingMeter,
  });
  await clock.flush();
  await clock.advance(50);
  const code = await pending;
  assert.equal(code, 1);
  assert.match(lines.error[0], /waiting for GitHub metering\/budget admission before spawning `gh pr edit` applied=false receipt-write-failed=/);
});

test('synchronous entitled refresh is bounded by the attempt deadline and never spawns gh afterward', { timeout: 10_000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const env = {
    HAM_ROOT_DIR: rootDir,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: path.join(rootDir, 'budget.json'),
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND:
      `exec ${quote(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
  };
  let spawned = false;
  const started = Date.now();
  await assert.rejects(applyNoMergeHold({
    rootDir, repo: REPO, prNumber: PR, resume: true, timeoutMs: 150,
    meteredExecFileImpl: (exec, cmd, args, options) => meteredExecFile(exec, cmd, args, { ...options, env }),
    execFileImpl: async () => { spawned = true; return { stdout: '', stderr: '' }; },
  }), { code: 'ETIMEDOUT', phase: 'admission' });
  assert.ok(Date.now() - started < 3_000, 'the refresh must not use its nominal 150-second allowance');
  assert.equal(spawned, false);
  assert.equal(onlyReceipt(rootDir).applied, false);
});

test('synchronous admission that overruns the deadline cannot spawn before the timer runs', async t => {
  const clock = new FakeClock(t, { wall: Date.now() });
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  let spawned = false;
  await assert.rejects(applyNoMergeHold({
    rootDir, repo: REPO, prNumber: PR, resume: true, timeoutMs: 25,
    meteredExecFileImpl: (exec, cmd, args, options) => {
      clock.wall += 75; // Synchronous admission overruns before timers can run.
      return exec(cmd, args, options);
    },
    execFileImpl: async () => { spawned = true; return { stdout: '', stderr: '' }; },
  }), { code: 'ETIMEDOUT', phase: 'admission' });
  assert.equal(spawned, false);
  assert.equal(onlyReceipt(rootDir).applied, false);
});

for (const resume of [false, true]) for (const stalled of [false, true]) {
  test(`successful ${resume ? 'release' : 'hold'} retains applied=true when response recording ${stalled ? 'stalls' : 'fails'}`, async t => {
    const clock = new FakeClock(t, { wall: Date.now() });
    const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
    const { lines, io } = cliHarness();
    let edits = 0;
    const pending = runNoMergeHoldCli(['--repo', REPO, '--pr', String(PR), ...(resume ? ['--resume'] : [])], {
      ...io, rootDir, timeoutMs: 100,
      meteredExecFileImpl: async (exec, cmd, args, options) => {
        const result = await exec(cmd, args, options);
        if (args[0] !== 'pr') return result;
        if (stalled) return new Promise(() => {});
        throw new Error('recording lock not found');
      },
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'pr') edits += 1;
        return { stdout: '', stderr: '' };
      },
    });
    await clock.flush();
    await clock.advance(100);
    const code = await pending;
    assert.equal(code, 1);
    assert.equal(edits, 1);
    assert.match(lines.error[0], /applied=true receipt=/);
    const receipt = onlyReceipt(rootDir);
    assert.equal(receipt.applied, true);
    assert.equal(receipt.held, !resume);
    assert.match(receipt.error, stalled ? /metering to record/ : /recording lock not found/);
  });
}

test('successful label creation with stalled recording does not imply the PR hold was applied', async t => {
  const clock = new FakeClock(t, { wall: Date.now() });
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-merge-hold-'));
  const calls = [];
  const rejection = assert.rejects(applyNoMergeHold({
    rootDir, repo: REPO, prNumber: PR, timeoutMs: 100,
    meteredExecFileImpl: async (exec, cmd, args, options) => {
      await exec(cmd, args, options);
      return new Promise(() => {});
    },
    execFileImpl: async (_cmd, args) => { calls.push(args[0]); return { stdout: '', stderr: '' }; },
  }), { code: 'ETIMEDOUT', phase: 'record' });
  await clock.flush();
  await clock.advance(100);
  await rejection;
  assert.deepEqual(calls, ['label']);
  assert.equal(onlyReceipt(rootDir).applied, false);
});
