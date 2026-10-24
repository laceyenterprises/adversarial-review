#!/usr/bin/env node
/**
 * Blocking merge-lease CLI for AMG workers.
 *
 * Exit codes:
 *   0   acquired/released/status emitted
 *   64  usage or validation error
 *   70  PR parked after exceeding the gate-attempt cap
 *   75  retryable timeout/contention/runtime failure
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  acquireMergeLease,
  assessMergeLeaseNeedsRevalidation,
  classifyMergeLeaseGateFailure,
  deriveLeaseKey,
  formatHamGateAttemptCapClosingStatus,
  inspectMergeLease,
  recordMergeLeaseGateAttempt,
  reclaimIfStale,
  reconcileMergeLeases,
  readMergeLeaseWaiters,
  readMergeLeaseHistory,
  mergeLeaseHistoryFilePath,
  releaseMergeLease,
  releaseMergeLeaseForRetryableAbort,
  refundMergeLeaseGateAttempt,
  removeMergeLeaseWaiter,
  resetMergeLeaseGateAttempts,
} from '../src/ama/merge-lease.mjs';

import { loadAwareTimeoutSeconds, MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const EXIT_USAGE = 64;
const EXIT_PARKED = 70;
const EXIT_TIMEOUT = 75;
const DEFAULT_SLEEP_MS = 250;
const DEFAULT_RELEASE_RETRY_MS = 1000;
const DEFAULT_MAX_GATE_ATTEMPTS = 5;

const USAGE = `\
Usage:
  merge-lease acquire --repo <owner/name> --base <branch> --pr <n> --head <sha>
                      --owner-pid <pid> [--owner-pgid <pgid>] --wait <seconds>
                      [--root-dir <path>] [--required-checks-green]
                      [--wait-for-holder-deadline] [--wait-by-progress]
  merge-lease release --repo <owner/name> --base <branch> --pr <n>
                      --lease-id <id> [--retryable-abort <reason>]
                      [--root-dir <path>]
  merge-lease reconcile --repo <owner/name> --base <branch> [--root-dir <path>]
  merge-lease status  --repo <owner/name> --base <branch> [--root-dir <path>]
  merge-lease list    --repo <owner/name> --base <branch> [--root-dir <path>]
  merge-lease needs-revalidation --repo-path <path> --base <branch>
                      --validation-base <sha> --current-base <sha>
                      [--changed-files-from <ref>]
  merge-lease classify --stage <mergeability|required-checks|protection>
                      [--state <state>] [--error <message>] [--http-status <code>]
  merge-lease reset-attempts --repo <owner/name> --base <branch> --pr <n>
                      --head <sha> [--root-dir <path>]

Safety:
  --wait-for-holder-deadline is accepted for compatibility, but never extends
  the caller's explicit --wait command budget. FIFO acquisition retries within
  that window; --wait 0 always returns immediately.
  --wait-by-progress treats --wait as a no-progress interval, with a six-hour
  nominal overall ceiling. Both bounds are load-scaled once and timer-clamped.
  needs-revalidation fetches origin/<base> in --repo-path. Run it only while
  holding the matching (repo, base) merge lease; it is not an unlocked probe.

Exit codes:
  0   acquired/released/status emitted
  64  usage or validation error
  70  PR parked after exceeding the gate-attempt cap
  75  retryable timeout/contention/runtime failure
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function usageError(message) {
  return new UsageError(message);
}

export function defaultPidAliveFn(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    return true; // Unknown is not evidence of a dead owner.
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInteger(value, label) {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw usageError(`--${label} must be a positive integer`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw usageError(`--${label} must be a positive integer`);
  }
  return n;
}

function parseNonNegativeNumber(value, label) {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw usageError(`--${label} must be a non-negative number`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw usageError(`--${label} must be a non-negative number`);
  }
  return n;
}

function parseMaxGateAttempts(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_GATE_ATTEMPTS;
}

function parseCommon(argv, extraOptions = {}) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        base: { type: 'string' },
        'root-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        ...extraOptions,
      },
    });
  } catch (err) {
    throw usageError(err.message);
  }
}

function requireString(values, name) {
  const value = String(values[name] ?? '').trim();
  if (!value) throw usageError(`--${name} is required`);
  return value;
}

function requireRepoName(values) {
  const repo = requireString(values, 'repo');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw usageError('--repo must be shaped owner/name without traversal');
  }
  return repo;
}

function requireBaseName(values) {
  const base = requireString(values, 'base');
  if (
    base.startsWith('/') ||
    base.startsWith('-') ||
    base.includes('..') ||
    base.includes('\\') ||
    base.includes('//') ||
    !/^[A-Za-z0-9._/-]+$/.test(base)
  ) {
    throw usageError('--base must be a safe branch name without traversal');
  }
  return base;
}

function jsonLine(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function isMutationLockBusyError(err) {
  return /\bmutation lock busy\b/.test(String(err?.message || ''));
}

function leaseJson({ result, waitedSeconds }) {
  const lease = result.lease;
  return {
    acquired: true,
    key: deriveLeaseKey({ repo: lease.repo, base: lease.base }).key,
    holder: lease.holderPr,
    leaseId: lease.leaseId,
    holderHead: lease.holderHead,
    holderPid: lease.holderPid,
    acquiredAt: lease.acquiredAt,
    waited_s: waitedSeconds,
  };
}

function timeoutJson({ repo, base, waitedSeconds, configuredSeconds, refundFailed = false, evidence = {} }) {
  return {
    acquired: false,
    timedOut: true,
    configured_s: configuredSeconds,
    key: deriveLeaseKey({ repo, base }).key,
    waited_s: waitedSeconds,
    ...(refundFailed ? { refundFailed: true } : {}),
    ...evidence,
  };
}

function parkedJson({ repo, base, pr, head, rootDir, attempt, maxAttempts, reason, requiredChecksGreen }) {
  return {
    acquired: false,
    parked: true,
    reason,
    key: deriveLeaseKey({ repo, base }).key,
    pr,
    head,
    attempts: attempt.attempts,
    retryable: attempt.retryable,
    maxAttempts,
    closingStatus: formatHamGateAttemptCapClosingStatus({
      attempts: attempt.attempts, retryable: attempt.retryable, repo, base, pr, head, rootDir, requiredChecksGreen,
    }),
  };
}

function retryableReleaseJson({ repo, base, leaseId, reason, existingLease }) {
  return {
    released: false,
    retryable: true,
    key: deriveLeaseKey({ repo, base }).key,
    leaseId,
    reason,
    existingLease,
  };
}

function revalidationJson(decision) {
  return {
    needsRevalidation: decision.needsRevalidation,
    reason: decision.reason,
    currentBase: decision.currentBase,
    mainAdvancedBy: decision.mainAdvancedBy,
    overlappingFiles: decision.overlappingFiles,
    ...(decision.detail ? { detail: decision.detail } : {}),
  };
}

function acquireHolderMatches(holder, { pr, head, ownerPid, host }) {
  return holder
    && Number(holder.holderPr) === pr
    && holder.holderHead === head
    && Number(holder.holderPid) === ownerPid
    && holder.holderHost === host;
}

async function cleanupAcquireWaiter(args, deps) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      removeMergeLeaseWaiter({ ...args, updatedAt: deps.nowIso(),
        expectedAcquisition: { pid: deps.selfPid, host: deps.host } });
      return;
    } catch (err) {
      if (isMutationLockBusyError(err) && attempt < 3) {
        await deps.sleep(DEFAULT_SLEEP_MS);
        continue;
      }
      // A dead-acquirer prune is the fallback if shutdown cannot take the lock.
      deps.stderr.write(`warning: merge lease waiter cleanup failed: ${err?.message || err}\n`);
      return;
    }
  }
}

function waiterAge(waiter, inspectedAt) {
  const start = Date.parse(waiter.arrivedAt);
  const end = Date.parse(inspectedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function statusJson(status) {
  return {
    key: status.key,
    holder: status.holder
      ? {
          ...status.holder,
          ageSeconds: status.ageSeconds,
          holderPidLive: status.holderPidLive,
          pastDeadline: status.pastDeadline,
        }
      : null,
    waiters: status.waiters.map((waiter) => ({
      ...waiter,
      ageSeconds: waiterAge(waiter, status.inspectedAt),
    })),
    attempts: status.attempts.map((attempt) => ({
      ...attempt,
      ageSeconds: waiterAge({ arrivedAt: attempt.firstAttemptAt }, status.inspectedAt),
    })),
    inspectedAt: status.inspectedAt,
  };
}

async function runAcquire(argv, deps) {
  const { values } = parseCommon(argv, {
    pr: { type: 'string' },
    head: { type: 'string' },
    'owner-pid': { type: 'string' },
    'owner-pgid': { type: 'string' },
    wait: { type: 'string' },
    'required-checks-green': { type: 'boolean' },
    'wait-for-holder-deadline': { type: 'boolean' },
    'wait-by-progress': { type: 'boolean' },
  });
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }

  const rootDir = values['root-dir'] || DEFAULT_ROOT_DIR;
  const repo = requireRepoName(values);
  const base = requireBaseName(values);
  const pr = parsePositiveInteger(values.pr, 'pr');
  const head = requireString(values, 'head');
  const ownerPid = parsePositiveInteger(values['owner-pid'], 'owner-pid');
  const ownerPgid =
    values['owner-pgid'] == null ? null : parsePositiveInteger(values['owner-pgid'], 'owner-pgid');
  const waitSeconds = parseNonNegativeNumber(values.wait, 'wait');
  const startedMs = deps.nowMs();
  if (ownerPid === deps.selfPid) {
    throw usageError('--owner-pid must identify the caller, not the merge-lease CLI process');
  }
  if (!deps.pidAliveFn(ownerPid)) {
    throw usageError('--owner-pid is not live on this host');
  }
  const progressWait = values['wait-by-progress'] && waitSeconds > 0;
  const stallSeconds = progressWait ? deps.loadAwareTimeoutSeconds(waitSeconds, { maxSeconds: Infinity }) : waitSeconds;
  const acquisitionSeconds = progressWait
    ? deps.loadAwareTimeoutSeconds(Math.max(6 * 3600, waitSeconds), { maxSeconds: Infinity }) : waitSeconds;
  const deadlineMs = startedMs + acquisitionSeconds * 1000;
  let lastProgressMs = startedMs;
  let previousPosition = null;
  let lastServiceEvent = null;
  let historyVersion;
  const historyPath = mergeLeaseHistoryFilePath(rootDir, { repo, base });
  const holders = new Map();
  const rememberHolder = holder => {
    if (!holder || (Number(holder.holderPr) === pr && holder.holderHead === head)) return;
    const key = holder.leaseId || JSON.stringify([
      holder.holderPr, holder.holderHead, holder.holderHost, holder.holderPid, holder.acquiredAt,
    ]);
    holders.set(key, holder);
    if (holders.size > 128) holders.delete(holders.keys().next().value);
  };
  const observeProgress = result => {
    rememberHolder(result.lease || result.existingLease);
    let version = null;
    try {
      const stat = statSync(historyPath, { bigint: true });
      // History is atomically replaced, including when the bounded tail is full.
      version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    let latest = lastServiceEvent;
    if (version !== historyVersion) {
      const history = deps.readMergeLeaseHistory(rootDir, { repo, base });
      const service = history.filter(row => Date.parse(row.at) >= startedMs && row.event !== 'renew');
      for (const row of service) rememberHolder(row);
      latest = service.at(-1)?.eventId;
      historyVersion = version;
    }
    if ((latest && latest !== lastServiceEvent)
      || (result.queuePosition != null && previousPosition != null && result.queuePosition < previousPosition)) {
      lastProgressMs = deps.nowMs();
    }
    if (latest) lastServiceEvent = latest;
    if (result.queuePosition != null) previousPosition = result.queuePosition;
  };
  const timeoutEvidence = () => ({
    reason: progressWait ? (deps.nowMs() >= deadlineMs ? 'lease-wait-ceiling' : 'lease-queue-no-progress') : 'merge-lease-timeout',
    holders: [...holders.values()],
    closingStatus: `lease wait exhausted behind ${[...holders.values()].map(h => `PR ${h.holderPr} (${h.holderRole || 'closer'}, ${h.holderHead}, pid ${h.holderPid})`).join(', ') || 'no observed holder'}`,
    no_progress_s: Math.floor((deps.nowMs() - lastProgressMs) / 1000),
    ceiling_s: acquisitionSeconds,
  });

  let nextProgressMs = startedMs;
  const reportProgress = () => {
    if (deps.nowMs() < nextProgressMs) return;
    const status = inspectMergeLease({ rootDir, repo, base, now: deps.nowIso(), host: deps.host, pidAliveFn: deps.pidAliveFn });
    rememberHolder(status.holder);
    const queue = readMergeLeaseWaiters(rootDir, { repo, base });
    const position = queue.findIndex((w) => Number(w.pr) === pr && w.head === head && Number(w.holderPid) === ownerPid);
    deps.stderr.write(`HAM merge lease wait: waited=${Math.floor((deps.nowMs() - startedMs) / 1000)}s allowed=${acquisitionSeconds}s holder=${status.holder?.holderPr ?? 'none'} queue=${position < 0 ? 'unregistered' : position + 1}\n`);
    // Leave slack for the bounded lock retries and the next polling tick.
    nextProgressMs = deps.nowMs() + 25000;
  };
  let gateAttempt = null;
  while (!gateAttempt) {
    try {
      gateAttempt = recordMergeLeaseGateAttempt({
        rootDir,
        repo,
        base,
        pr,
        head,
        now: deps.nowIso(),
        maxAttempts: deps.maxGateAttempts,
      });
    } catch (err) {
      if (!isMutationLockBusyError(err)) throw err;
      if (deps.nowMs() >= Math.min(deadlineMs, startedMs + stallSeconds * 1000)) {
        jsonLine(deps.stdout, timeoutJson({
          evidence: timeoutEvidence(),
          configuredSeconds: waitSeconds,
          repo,
          base,
          waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
        }));
        return EXIT_TIMEOUT;
      }
      reportProgress();
      await deps.sleep(Math.min(DEFAULT_SLEEP_MS, Math.max(1, deadlineMs - deps.nowMs())));
    }
  }
  if (gateAttempt.parked) {
    jsonLine(deps.stdout, parkedJson({
      repo,
      base,
      pr,
      head,
      rootDir,
      attempt: gateAttempt.attempt,
      maxAttempts: gateAttempt.maxAttempts,
      reason: 'max-gate-attempts',
      requiredChecksGreen: values['required-checks-green'],
    }));
    return EXIT_PARKED;
  }
  // Each invocation owns its own position and cleanup. Never adopt another
  // CLI's waiter just because its parent, PR and head happen to match.
  const waiterId = `cli_${deps.selfPid}_${randomUUID()}_${pr}`;
  let attempt = 1;
  let waiterServed = false;
  let interrupted = null;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => { interrupted ??= signal; };
    deps.signalSource.on(signal, handler);
    return [signal, handler];
  }));

  try {
    while (true) {
      const tickNow = deps.nowIso();
      if (!interrupted) {
        try {
          reclaimIfStale({
            rootDir,
            repo,
            base,
            now: tickNow,
            host: deps.host,
            pidAliveFn: deps.pidAliveFn,
          });
          const result = deps.acquireMergeLease({
            rootDir,
            repo,
            base,
            holderPr: pr,
            holderHead: head,
            holderPid: ownerPid,
            holderHost: deps.host,
            holderProcessGroup: ownerPgid,
            now: tickNow,
            waiterId,
            acquisitionPid: deps.selfPid,
            registerWaiter: true,
            waiterDeadlineSeconds: progressWait ? Math.min(Math.floor(MAX_TIMER_DELAY_MS / 1000), acquisitionSeconds + 1) : undefined,
            attempt,
            pidAliveFn: deps.pidAliveFn,
          });
          if (result.acquired) {
            waiterServed = true;
            jsonLine(deps.stdout, leaseJson({
              result,
              waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
            }));
            return 0;
          }
          observeProgress(result);
        } catch (err) {
          if (!isMutationLockBusyError(err)) throw err;
          const status = inspectMergeLease({
            rootDir,
            repo,
            base,
            now: deps.nowIso(),
            host: deps.host,
            pidAliveFn: deps.pidAliveFn,
          });
          if (acquireHolderMatches(status.holder, { pr, head, ownerPid, host: deps.host })) {
            // The matching holder may predate this invocation. Its own waiter
            // still needs finally cleanup; only a served result skips it.
            jsonLine(deps.stdout, leaseJson({
              result: { lease: status.holder },
              waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
            }));
            return 0;
          }
        }
      }

      reportProgress();
      if (interrupted || deps.nowMs() >= deadlineMs || deps.nowMs() - lastProgressMs >= stallSeconds * 1000) {
        let refundFailed = false;
        for (let refundTry = 1; refundTry <= 3; refundTry += 1) {
          try {
            refundMergeLeaseGateAttempt({ rootDir, repo, base, pr, head, now: deps.nowIso() });
            break;
          } catch (err) {
            if (isMutationLockBusyError(err) && refundTry < 3) {
              await deps.sleep(DEFAULT_SLEEP_MS);
              continue;
            }
            refundFailed = true;
            deps.stderr.write(`warning: merge lease gate attempt refund failed: ${String(err?.message || err)}\n`);
            break;
          }
        }
        jsonLine(deps.stdout, timeoutJson({
          configuredSeconds: waitSeconds,
          repo,
          base,
          waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
          refundFailed,
          evidence: { ...timeoutEvidence(), ...(interrupted ? { reason: 'lease-wait-interrupted', signal: interrupted } : {}) },
        }));
        return EXIT_TIMEOUT;
      }

      attempt += 1;
      await deps.sleep(Math.min(DEFAULT_SLEEP_MS, Math.max(1, deadlineMs - deps.nowMs())));
    }
  } finally {
    try {
      if (!waiterServed) await cleanupAcquireWaiter({ rootDir, repo, base, waiterId }, deps);
    } finally {
      for (const [signal, handler] of handlers) deps.signalSource.off(signal, handler);
    }
  }
}

async function runReconcile(argv, deps) {
  const { values } = parseCommon(argv);
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }
  const rootDir = values['root-dir'] || DEFAULT_ROOT_DIR;
  const repo = requireRepoName(values);
  const base = requireBaseName(values);
  const result = await reconcileMergeLeases({
    rootDir,
    repo,
    base,
    now: deps.nowIso(),
    host: deps.host,
    pidAliveFn: deps.pidAliveFn,
    execFileImpl: deps.execFileImpl,
  });
  jsonLine(deps.stdout, {
    reconciled: result.reconciled,
    released: result.released,
    key: deriveLeaseKey({ repo, base }).key,
    reason: result.reason,
    ...(result.holderPrState ? { holderPrState: result.holderPrState } : {}),
    existingLease: result.released ? null : result.inspection?.holder,
  });
  return result.reconciled ? 0 : EXIT_TIMEOUT;
}

async function runRelease(argv, deps) {
  const { values } = parseCommon(argv, {
    pr: { type: 'string' },
    'lease-id': { type: 'string' },
    'retryable-abort': { type: 'string' },
  });
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }

  const rootDir = values['root-dir'] || DEFAULT_ROOT_DIR;
  const repo = requireRepoName(values);
  const base = requireBaseName(values);
  const pr = parsePositiveInteger(values.pr, 'pr');
  const leaseId = requireString(values, 'lease-id');
  const retryableAbortReason = String(values['retryable-abort'] ?? '').trim();
  const startedMs = deps.nowMs();
  const deadlineMs = startedMs + DEFAULT_RELEASE_RETRY_MS;

  while (true) {
    const status = inspectMergeLease({
      rootDir,
      repo,
      base,
      now: deps.nowIso(),
      host: deps.host,
      pidAliveFn: deps.pidAliveFn,
    });
    const current = status.holder;

    if (!current || current.leaseId !== leaseId || Number(current.holderPr) !== pr) {
      jsonLine(deps.stdout, {
        released: false,
        key: deriveLeaseKey({ repo, base }).key,
        existingLease: current,
      });
      return 0;
    }

    const releaseArgs = {
      rootDir,
      repo,
      base,
      leaseId,
      holderPr: current.holderPr,
      holderHead: current.holderHead,
      acquiredAt: current.acquiredAt,
    };
    const result = retryableAbortReason
      ? releaseMergeLeaseForRetryableAbort({
        ...releaseArgs,
        retryableAbortReason,
        now: deps.nowIso(),
      })
      : releaseMergeLease(releaseArgs);
    if (!result.released && result.reason === 'mutation-lock-busy') {
      if (deps.nowMs() >= deadlineMs) {
        jsonLine(deps.stdout, retryableReleaseJson({
          repo,
          base,
          leaseId,
          reason: result.reason,
          existingLease: result.existingLease,
        }));
        return EXIT_TIMEOUT;
      }
      await deps.sleep(Math.min(DEFAULT_SLEEP_MS, Math.max(1, deadlineMs - deps.nowMs())));
      continue;
    }
    jsonLine(deps.stdout, {
      released: result.released,
      key: deriveLeaseKey({ repo, base }).key,
      leaseId,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.retryableAbort ? { retryableAbort: true, retryableAbortReason: result.retryableAbortReason } : {}),
      ...(result.attemptPrune ? { attemptPrune: result.attemptPrune } : {}),
      existingLease: result.released ? null : result.existingLease,
    });
    return 0;
  }
}

function runStatus(argv, deps) {
  const { values } = parseCommon(argv);
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }
  const rootDir = values['root-dir'] || DEFAULT_ROOT_DIR;
  const repo = requireRepoName(values);
  const base = requireBaseName(values);
  jsonLine(deps.stdout, statusJson(inspectMergeLease({
    rootDir,
    repo,
    base,
    now: deps.nowIso(),
    host: deps.host,
    pidAliveFn: deps.pidAliveFn,
  })));
  return 0;
}

function runClassify(argv, deps) {
  const { values } = parseCommon(argv, {
    stage: { type: 'string' },
    state: { type: 'string' },
    error: { type: 'string' },
    'http-status': { type: 'string' },
  });
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }
  jsonLine(deps.stdout, classifyMergeLeaseGateFailure({
    stage: requireString(values, 'stage'),
    state: values.state,
    error: values.error,
    status: values['http-status'],
  }));
  return 0;
}

function runResetAttempts(argv, deps) {
  const { values } = parseCommon(argv, { pr: { type: 'string' }, head: { type: 'string' } });
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }
  const rootDir = values['root-dir'] || DEFAULT_ROOT_DIR;
  const repo = requireRepoName(values);
  const base = requireBaseName(values);
  const pr = parsePositiveInteger(values.pr, 'pr');
  const head = requireString(values, 'head');
  const result = resetMergeLeaseGateAttempts({ rootDir, repo, base, pr, head, now: deps.nowIso() });
  jsonLine(deps.stdout, { reset: true, removed: result.removed, repo, base, pr, head });
  return 0;
}

async function runNeedsRevalidation(argv, deps) {
  const { values } = parseCommon(argv, {
    'repo-path': { type: 'string' },
    'validation-base': { type: 'string' },
    'current-base': { type: 'string' },
    'changed-files-from': { type: 'string' },
  });
  if (values.help) {
    deps.stdout.write(USAGE);
    return 0;
  }

  const decision = await deps.assessMergeLeaseNeedsRevalidation({
    repoPath: requireString(values, 'repo-path'),
    base: requireBaseName(values),
    validationBase: requireString(values, 'validation-base'),
    currentBase: requireString(values, 'current-base'),
    changedFilesFrom: values['changed-files-from'] || 'HEAD',
  });
  jsonLine(deps.stdout, revalidationJson(decision));
  return 0;
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = {
    stdout: process.stdout,
    stderr: process.stderr,
    selfPid: process.pid,
    host: hostname(),
    acquireMergeLease,
    readMergeLeaseHistory,
    assessMergeLeaseNeedsRevalidation,
    execFileImpl: execFile,
    maxGateAttempts: parseMaxGateAttempts(process.env.AMG_MAX_GATE_ATTEMPTS),
    pidAliveFn: defaultPidAliveFn,
    loadAwareTimeoutSeconds,
    nowIso,
    nowMs: () => Date.now(),
    sleep,
    signalSource: process,
    ...overrides,
  };

  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    deps.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (sub) {
      case 'acquire':
        return await runAcquire(argv.slice(1), deps);
      case 'release':
        return await runRelease(argv.slice(1), deps);
      case 'reconcile':
        return await runReconcile(argv.slice(1), deps);
      case 'status':
      case 'list':
        return runStatus(argv.slice(1), deps);
      case 'classify':
        return runClassify(argv.slice(1), deps);
      case 'reset-attempts':
        return runResetAttempts(argv.slice(1), deps);
      case 'needs-revalidation':
        return await runNeedsRevalidation(argv.slice(1), deps);
      default:
        deps.stderr.write(`error: unknown subcommand '${sub}'\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr.write(`error: ${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    deps.stderr.write(`error: retryable runtime failure: ${err?.message || String(err)}\n`);
    return EXIT_TIMEOUT;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pipe writes can still be pending after main returns. Let Node drain stdio
  // and report asynchronous write errors before the process exits.
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`error: retryable runtime failure: ${err?.message || String(err)}\n`);
    process.exitCode = EXIT_TIMEOUT;
  }
}
