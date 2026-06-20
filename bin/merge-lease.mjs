#!/usr/bin/env node
/**
 * Blocking merge-lease CLI for AMG workers.
 *
 * Exit codes:
 *   0   acquired/released/status emitted
 *   64  usage or validation error
 *   75  retryable timeout/contention/runtime failure
 */

import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  acquireMergeLease,
  assessMergeLeaseNeedsRevalidation,
  deriveLeaseKey,
  inspectMergeLease,
  reclaimIfStale,
  readMergeLeaseWaiters,
  releaseMergeLease,
  removeMergeLeaseWaiter,
} from '../src/ama/merge-lease.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const EXIT_USAGE = 64;
const EXIT_TIMEOUT = 75;
const DEFAULT_SLEEP_MS = 250;
const DEFAULT_RELEASE_RETRY_MS = 1000;

const USAGE = `\
Usage:
  merge-lease acquire --repo <owner/name> --base <branch> --pr <n> --head <sha>
                      --owner-pid <pid> [--owner-pgid <pgid>] --wait <seconds>
                      [--root-dir <path>]
  merge-lease release --repo <owner/name> --base <branch> --pr <n>
                      --lease-id <id> [--root-dir <path>]
  merge-lease status  --repo <owner/name> --base <branch> [--root-dir <path>]
  merge-lease list    --repo <owner/name> --base <branch> [--root-dir <path>]
  merge-lease needs-revalidation --repo-path <path> --base <branch>
                      --validation-base <sha> --current-base <sha>
                      [--changed-files-from <ref>]

Safety:
  needs-revalidation fetches origin/<base> in --repo-path. Run it only while
  holding the matching (repo, base) merge lease; it is not an unlocked probe.

Exit codes:
  0   acquired/released/status emitted
  64  usage or validation error
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultPidAliveFn(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    return false;
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

function timeoutJson({ repo, base, waitedSeconds }) {
  return {
    acquired: false,
    timedOut: true,
    key: deriveLeaseKey({ repo, base }).key,
    waited_s: waitedSeconds,
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

function removeWaiterForTimeout({ rootDir, repo, base, waiterId, updatedAt }) {
  try {
    removeMergeLeaseWaiter({ rootDir, repo, base, waiterId, updatedAt });
  } catch (err) {
    if (!isMutationLockBusyError(err)) throw err;
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

  if (ownerPid === deps.selfPid) {
    throw usageError('--owner-pid must identify the caller, not the merge-lease CLI process');
  }
  if (!deps.pidAliveFn(ownerPid)) {
    throw usageError('--owner-pid is not live on this host');
  }

  const startedMs = deps.nowMs();
  const deadlineMs = startedMs + (waitSeconds * 1000);
  const existingWaiter = readMergeLeaseWaiters(rootDir, { repo, base }).find((waiter) => (
    Number(waiter.pr) === pr
    && waiter.head === head
    && Number(waiter.holderPid) === ownerPid
  ));
  const waiterId = existingWaiter?.waiterId || `cli_${deps.selfPid}_${startedMs}_${pr}`;
  let attempt = 1;

  while (true) {
    const tickNow = deps.nowIso();
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
        registerWaiter: true,
        attempt,
        pidAliveFn: deps.pidAliveFn,
      });
      if (result.acquired) {
        jsonLine(deps.stdout, leaseJson({
          result,
          waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
        }));
        return 0;
      }
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
        jsonLine(deps.stdout, leaseJson({
          result: { lease: status.holder },
          waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
        }));
        return 0;
      }
    }

    if (deps.nowMs() >= deadlineMs) {
      removeWaiterForTimeout({
        rootDir,
        repo,
        base,
        waiterId,
        updatedAt: deps.nowIso(),
      });
      jsonLine(deps.stdout, timeoutJson({
        repo,
        base,
        waitedSeconds: Math.max(0, Math.floor((deps.nowMs() - startedMs) / 1000)),
      }));
      return EXIT_TIMEOUT;
    }

    attempt += 1;
    await deps.sleep(Math.min(DEFAULT_SLEEP_MS, Math.max(1, deadlineMs - deps.nowMs())));
  }
}

async function runRelease(argv, deps) {
  const { values } = parseCommon(argv, {
    pr: { type: 'string' },
    'lease-id': { type: 'string' },
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

    const result = releaseMergeLease({
      rootDir,
      repo,
      base,
      leaseId,
      holderPr: current.holderPr,
      holderHead: current.holderHead,
      acquiredAt: current.acquiredAt,
    });
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
    assessMergeLeaseNeedsRevalidation,
    pidAliveFn: defaultPidAliveFn,
    nowIso,
    nowMs: () => Date.now(),
    sleep: sleepSync,
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
      case 'status':
      case 'list':
        return runStatus(argv.slice(1), deps);
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
    deps.stderr.write(`error: retryable runtime failure: ${err.message}\n`);
    return EXIT_TIMEOUT;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
