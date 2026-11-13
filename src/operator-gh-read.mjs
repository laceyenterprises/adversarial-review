/**
 * Bounded, visible GitHub reads for operator CLIs (RETRIGGERLOOKUPHANG-01).
 *
 * An operator CLI has a person waiting on it, so its GitHub reads must finish or
 * fail within one ABSOLUTE budget that covers every attempt, retry backoff and
 * metering wait. Host load may lengthen the budget, but only up to
 * `OPERATOR_GH_READ_MAX_BUDGET_MS`; an explicit operator override replaces it.
 * Each read prints one stderr line when it starts and one per retry, so a slow
 * call can be told apart from a hang. When the budget runs out, the read fails
 * with an `OperatorGhReadTimeoutError` that carries the caller's typed reason.
 * Credential-less reads use the operator-cli budget bucket; explicit tokens
 * retain their normal credential identity.
 *
 * @module operator-gh-read
 */
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { withGitHubBudgetScope } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);

/** Idle-host budget for one operator GitHub read, including its retries. */
export const OPERATOR_GH_READ_NOMINAL_BUDGET_MS = 30_000;
/** Absolute cap: the load-aware multiplier never lengthens a read past this. */
export const OPERATOR_GH_READ_MAX_BUDGET_MS = 60_000;
/** Upper bound for an explicit operator override. */
export const OPERATOR_GH_READ_MAX_OVERRIDE_MS = 3_600_000;

/**
 * The absolute budget for one operator GitHub read. An explicit override is
 * used as given (no load scaling); otherwise the nominal budget is scaled by
 * host load and clamped to the cap.
 */
export function resolveOperatorGhReadBudgetMs({ overrideMs = null, ...loadOptions } = {}) {
  if (overrideMs !== null && overrideMs !== undefined) {
    if (!Number.isFinite(overrideMs) || overrideMs < 1 || overrideMs > OPERATOR_GH_READ_MAX_OVERRIDE_MS) {
      throw new RangeError(`operator GitHub read budget must be 1..${OPERATOR_GH_READ_MAX_OVERRIDE_MS} ms`);
    }
    return Math.ceil(overrideMs);
  }
  return Math.min(
    OPERATOR_GH_READ_MAX_BUDGET_MS,
    loadAwareTimeoutMs(OPERATOR_GH_READ_NOMINAL_BUDGET_MS, { ...loadOptions, maxMs: OPERATOR_GH_READ_MAX_BUDGET_MS }),
  );
}

export class OperatorGhReadTimeoutError extends Error {
  constructor(message, { reason, step, phase, budgetMs, elapsedMs, attempts, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OperatorGhReadTimeoutError';
    this.code = 'ETIMEDOUT';
    this.reason = reason;
    this.step = step;
    this.phase = phase;
    this.budgetMs = budgetMs;
    this.elapsedMs = elapsedMs;
    this.attempts = attempts;
  }
}

function seconds(ms) {
  return `${Math.round(ms / 100) / 10}s`;
}

function oneLine(text, max = 200) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function errorDetail(err) {
  if (err?.killed) return `killed by its ${err.signal || 'timeout'} attempt bound`;
  return oneLine(err?.stderr || err?.message || err) || 'unknown error';
}

// An error that means "the read did not finish inside its time bound", as
// opposed to GitHub answering with a real failure.
function isBudgetError(err, signal) {
  return signal.aborted
    || err?.killed === true
    || err?.name === 'AbortError'
    || err?.message === 'GitHub read time budget exhausted';
}

/**
 * Run one GitHub read for an operator CLI inside an absolute budget.
 *
 * @param {object} opts
 * @param {string[]} opts.args            gh argv (without the `gh`)
 * @param {string} opts.label             human label for progress lines ("head lookup")
 * @param {string} opts.timeoutReason     typed reason carried by the timeout error
 * @param {number} [opts.budgetMs]        absolute budget including retries
 * @param {{write(s: string): unknown}|null} [opts.stderr] progress sink
 */
export async function runOperatorGhRead({
  args,
  label,
  timeoutReason,
  budgetMs = resolveOperatorGhReadBudgetMs(),
  stderr = null,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  retries = 2,
  backoffMs = 500,
  sleepImpl,
  nowMs = () => Date.now(),
  env,
} = {}) {
  const step = `gh ${args.slice(0, 2).join(' ')}`;
  const note = (message) => { stderr?.write?.(`[github-read] ${message}\n`); };
  const controller = new AbortController();
  const startedAt = nowMs();
  const elapsed = () => nowMs() - startedAt;
  // admission: metering/budget wait before spawning; gh: child running;
  // record: metering the response; backoff: sleeping before a retry.
  let phase = 'admission';
  let attempts = 0;
  let retryCount = 0;
  let lastRetryErr = null;

  const waitedFor = () => ({
    admission: `GitHub metering/budget admission before spawning \`${step}\``,
    gh: `\`${step}\` to exit`,
    record: `GitHub metering to record the \`${step}\` response`,
    backoff: `retry backoff for \`${step}\``,
  })[phase];
  const timeoutError = (cause) => new OperatorGhReadTimeoutError(
    `${label} did not finish within its ${seconds(budgetMs)} budget `
    + `(waiting for ${waitedFor()}; ${attempts} attempt${attempts === 1 ? '' : 's'})`,
    { reason: timeoutReason, step, phase, budgetMs, elapsedMs: elapsed(), attempts, cause },
  );

  const guardedExecFile = (command, argv, options) => {
    if (controller.signal.aborted) throw timeoutError();
    attempts += 1;
    phase = 'gh';
    return Promise.resolve(execFileImpl(command, argv, { ...options, signal: controller.signal }))
      .then((result) => {
        phase = 'record';
        return result;
      });
  };

  note(`start ${label}: \`${step}\` (budget ${seconds(budgetMs)})`);
  // Half the budget per attempt, so a hung first attempt still leaves room for
  // one retry; execGhWithRetry clips every attempt to what remains.
  const perAttemptMs = Math.max(1, Math.ceil(budgetMs / 2));
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, budgetMs);
  });
  try {
    return await Promise.race([
      withGitHubBudgetScope({ anonymousCredential: 'operator-cli' }, () => execGhWithRetryImpl({
        execFileImpl: guardedExecFile,
        args,
        ...(env ? { env } : {}),
        signal: controller.signal,
        timeoutMs: perAttemptMs,
        totalTimeoutMs: budgetMs,
        retries,
        backoffMs,
        retryDelayMs: (err, attempt) => {
          lastRetryErr = err;
          return isTransientGhError(err) ? backoffMs * (2 ** attempt) : null;
        },
        sleep: (ms) => {
          retryCount += 1;
          phase = 'backoff';
          note(`retry ${retryCount}/${retries} ${label} in ${seconds(ms)} after ${errorDetail(lastRetryErr)} `
            + `(${seconds(elapsed())} of ${seconds(budgetMs)} used)`);
          const slept = sleepImpl ? sleepImpl(ms) : delay(ms, undefined, { signal: controller.signal });
          return Promise.resolve(slept).finally(() => { phase = 'admission'; });
        },
        log: { warn: (message) => note(`retry ${label}: ${oneLine(message)}`) },
      })),
      bound,
    ]);
  } catch (err) {
    if (err instanceof OperatorGhReadTimeoutError) throw err;
    if (isBudgetError(err, controller.signal)) throw timeoutError(err);
    throw err;
  } finally {
    clearTimeout(timer);
    // Kill a gh child still running and stop any backoff sleep.
    controller.abort();
  }
}
