import { meteredExecFile } from './metered-gh.mjs';
import { flushDefaultApiCallRecorder } from './api-telemetry.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { withGitHubBudgetScope } from './rate-limit-throttle.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { NO_MERGE_HOLD_LABEL } from './follow-up-merge-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = [...argv];
  let repo = null;
  let prNumber = null;
  let resume = false;
  const reasonParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo') {
      repo = args[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--pr') {
      prNumber = Number.parseInt(args[index + 1] || '', 10);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--pr=')) {
      prNumber = Number.parseInt(arg.slice('--pr='.length), 10);
      continue;
    }
    if (arg === '--resume' || arg === '--release') {
      resume = true;
      continue;
    }
    reasonParts.push(arg);
  }

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Usage: node src/no-merge-hold.mjs --repo <owner/repo> --pr <number> [--resume] [reason]');
  }

  return {
    repo,
    prNumber,
    resume,
    reason: reasonParts.join(' ').trim() || (resume ? 'Operator released no-merge hold.' : 'Operator applied no-merge hold.'),
  };
}

// One hold or release (two gh calls at most) must finish or fail inside this
// bound, so an operator never waits on a silent process (NOMERGEHOLDHANG-01).
// Scaled by host load, but an emergency tool never waits more than two minutes.
const NOMINAL_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function resolveNoMergeHoldTimeoutMs() {
  return loadAwareTimeoutMs(NOMINAL_TIMEOUT_MS, { maxMs: MAX_TIMEOUT_MS });
}

function oneLine(text, max = 500) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Runs every gh call of one hold/release against a shared wall-clock deadline.
// The calls are operator safety actions, so the GitHub budget floor never makes
// them sleep. Any other wait (a metering lock, a token refresh, gh itself) that
// outlives the deadline fails with one line naming the phase it was stuck in,
// and a call whose metering resolves after the deadline is refused, not spawned.
function createBoundedGhRunner({
  timeoutMs = resolveNoMergeHoldTimeoutMs(),
  execFileImpl = execFileAsync,
  meteredExecFileImpl = meteredExecFile,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let expired = false;
  return async function runGh(args) {
    const step = `gh ${args.slice(0, 2).join(' ')}`;
    let phase = 'admission';
    // false: never spawned; null: spawned, outcome uncertain; true: exited 0.
    // Metering completion is independent of the mutation's result.
    let applied = false;
    const waitedFor = () => ({
      admission: `GitHub metering/budget admission before spawning \`${step}\``,
      gh: `\`${step}\` to exit`,
      record: `GitHub metering to record the \`${step}\` response`,
    })[phase];
    const timeoutError = () => Object.assign(
      new Error(`timed out after ${timeoutMs}ms waiting for ${waitedFor()}`),
      { code: 'ETIMEDOUT', noMergeHoldTimeout: true, phase, step, noMergeHoldApplied: applied },
    );
    const remaining = deadline - Date.now();
    if (expired || remaining < 1) throw timeoutError();
    const guardedExecFile = (command, argv, options) => {
      if (expired || Date.now() >= deadline) throw timeoutError();
      phase = 'gh';
      applied = null;
      return Promise.resolve(execFileImpl(command, argv, { ...options, signal: controller.signal }))
        .then(result => { applied = true; return result; })
        .finally(() => { phase = 'record'; });
    };
    let timer;
    const bound = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timeoutError());
        controller.abort();
      }, remaining);
    });
    try {
      return await Promise.race([
        withGitHubBudgetScope({ operatorSafety: true },
          () => meteredExecFileImpl(guardedExecFile, 'gh', args, { credentialDeadlineMs: deadline })),
        bound,
      ]);
    } catch (thrown) {
      // A synchronous refresh may consume the allowance before timers can run.
      const err = Date.now() >= deadline && phase === 'admission'
        ? timeoutError()
        : thrown instanceof Error ? thrown : new Error(String(thrown));
      err.noMergeHoldApplied = applied;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function ensureNoMergeHoldLabel({ repo, execFileImpl = execFileAsync, runGh } = {}) {
  await (runGh || createBoundedGhRunner({ execFileImpl }))([
    'label',
    'create',
    NO_MERGE_HOLD_LABEL,
    '--repo',
    repo,
    '--description',
    'Operator hold: block merge-agent and adversarial gate for this PR',
    '--color',
    'd93f0b',
    '--force',
  ]);
}

function isAbsentLabelRemovalError(err) {
  if (err?.noMergeHoldTimeout || err?.noMergeHoldApplied === true) return false;
  const text = [err?.message, err?.stderr, err?.stdout].filter(Boolean).join('\n').toLowerCase();
  return /not found|does not exist|http 422|could not remove|unable to remove|label.*not.*found/.test(text);
}

function holdReceiptPath(rootDir, { repo, prNumber, requestedAt }) {
  const safeRepo = String(repo || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_') || 'unknown';
  const safeTs = String(requestedAt || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_') || 'unknown';
  return join(rootDir, 'data', 'operator-mutations', 'no-merge-holds', `${safeRepo}-pr-${prNumber}-${safeTs}.json`);
}

async function applyNoMergeHold({
  rootDir = ROOT,
  repo,
  prNumber,
  resume = false,
  reason = resume ? 'Operator released no-merge hold.' : 'Operator applied no-merge hold.',
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  execFileImpl = execFileAsync,
  meteredExecFileImpl = meteredExecFile,
  timeoutMs = resolveNoMergeHoldTimeoutMs(),
} = {}) {
  const runGh = createBoundedGhRunner({ timeoutMs, execFileImpl, meteredExecFileImpl });
  const receiptPath = holdReceiptPath(rootDir, { repo, prNumber, requestedAt });
  // `held` is the requested state; `applied` says whether it took effect.
  const receipt = {
    kind: 'adversarial-review-no-merge-hold',
    schemaVersion: 1,
    requestedAt,
    requestedBy,
    reason,
    repo,
    prNumber,
    held: !resume,
    label: NO_MERGE_HOLD_LABEL,
  };
  let prMutationStarted = false;
  try {
    if (!resume) {
      await ensureNoMergeHoldLabel({ repo, runGh });
    }
    try {
      prMutationStarted = true;
      await runGh([
        'pr',
        'edit',
        String(prNumber),
        '--repo',
        repo,
        resume ? '--remove-label' : '--add-label',
        NO_MERGE_HOLD_LABEL,
      ]);
    } catch (err) {
      if (!resume || !isAbsentLabelRemovalError(err)) throw err;
    }
  } catch (thrown) {
    // A failed attempt is still an operator mutation attempt: audit it.
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    // Repository-label creation does not prove that the PR label was changed.
    const applied = prMutationStarted ? err.noMergeHoldApplied ?? null : false;
    const failed = { ...receipt, applied, error: oneLine(err.message) };
    err.applied = applied;
    err.receiptPath = receiptPath;
    err.receipt = failed;
    try {
      writeFileAtomic(receiptPath, `${JSON.stringify(failed, null, 2)}\n`);
    } catch (writeErr) {
      err.receiptPath = null;
      err.receiptError = oneLine(writeErr?.message || writeErr);
    }
    throw err;
  }
  const applied = { ...receipt, applied: true };
  try {
    writeFileAtomic(receiptPath, `${JSON.stringify(applied, null, 2)}\n`);
  } catch (writeErr) {
    // The label change landed; only its audit is missing. Say exactly that.
    throw Object.assign(new Error('label change applied, but its receipt could not be written'), {
      applied: true, receiptPath: null, receiptError: oneLine(writeErr?.message || writeErr),
    });
  }
  return {
    held: !resume,
    label: NO_MERGE_HOLD_LABEL,
    receipt: applied,
    receiptPath,
  };
}

// Returns the exit code. Every outcome prints exactly one result line
// (plus the dispatched-worker note after a successful hold).
async function runNoMergeHoldCli(argv, {
  log = console.log,
  warn = console.warn,
  error = console.error,
  ...deps
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(`[no-merge-hold] Failed: ${err.message}`);
    return 1;
  }
  try {
    const result = await applyNoMergeHold({ rootDir: ROOT, ...args, ...deps });
    log(
      `[no-merge-hold] held=${result.held} applied=true repo=${args.repo} pr=${args.prNumber} ` +
      `label=${result.label} receipt=${result.receiptPath}`
    );
    if (result.held) {
      warn(
        '[no-merge-hold] note: this blocks future merge-agent dispatch and the adversarial gate, ' +
        'but does not stop a merge-agent worker already dispatched; run merge-agent:cancel separately if needed.'
      );
    }
    return 0;
  } catch (err) {
    const receipt = err?.receiptPath
      ? ` receipt=${err.receiptPath}`
      : ` receipt-write-failed=${JSON.stringify(err?.receiptError || 'unknown')}`;
    error(`[no-merge-hold] Failed: repo=${args.repo} pr=${args.prNumber} ${oneLine(err?.message || err)} applied=${err?.applied ?? 'unknown'}${receipt}`);
    return 1;
  }
}

async function main() {
  const code = await runNoMergeHoldCli(process.argv.slice(2));
  if (code === 0) {
    process.exitCode = 0;
    return;
  }
  // A timed-out metering wait can still hold a timer: exit now, after the
  // telemetry flush that a natural exit would have run.
  flushDefaultApiCallRecorder();
  process.exit(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  applyNoMergeHold,
  createBoundedGhRunner,
  ensureNoMergeHoldLabel,
  parseArgs,
  resolveNoMergeHoldTimeoutMs,
  runNoMergeHoldCli,
};
