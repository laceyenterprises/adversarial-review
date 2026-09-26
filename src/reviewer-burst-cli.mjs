// RPL-07 operator surface — request, inspect, and revoke a burst reviewer
// capacity lease.
//
//   adversarial-review burst status  [--root <dir>] [--json]
//   adversarial-review burst request --repo <owner/repo> --reason <text>
//                                    [--ttl 30m] [--slots 2] [--budget 20]
//                                    [--pack <token>] [--max-reviews <n>]
//                                    [--root <dir>] [--json]
//   adversarial-review burst revoke  [--reason <text>] [--root <dir>] [--json]
//
// `status` is a pure read and is safe against a live deployed tree. `request`
// and `revoke` write the lease record the watcher consumes on its next tick;
// neither restarts, signals, or otherwise perturbs a running daemon — the
// watcher picks the lease up (and drops it) by reading the record, which is why
// an expired burst needs nothing to be running in order to decay.
//
// Exit codes:
//   0  lease active / status printed / lease revoked
//   1  REFUSED — request denied by scope, argument, or safety policy; or revoke
//      found no active lease. The blockers are printed and recorded.
//   2  usage error
//   4  runtime error (could not read the ledger the safety check needs)

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectReviewerBurstStatus,
  evaluateBurstSafety,
  normalizeBurstSafetySignals,
  renderReviewerBurstStatus,
  requestReviewerBurstLease,
  revokeReviewerBurstLease,
  reviewerBurstLeasePath,
} from './reviewer-burst-lease.mjs';
import { collectReviewPipelineHealth } from './review-pipeline-health.mjs';
import {
  parseHqFleetQuotaStatus,
  providerAvailabilityFromStatuses,
  providerForQuotaHarness,
} from './fleet-quota-status.mjs';
import {
  resolveHqPath,
  reviewWorkerClassFallback,
  reviewerWorkerClassEntitled,
} from './review-worker-class-fallback.mjs';

const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 4;

export function checkBurstMutationOwner(rootDir, {
  uid = process.getuid?.(),
  existsImpl = existsSync,
  statImpl = statSync,
} = {}) {
  if (!Number.isInteger(uid)) return { ok: false, reason: 'caller uid is unavailable' };
  const dataDir = join(rootDir, 'data');
  const leasePath = reviewerBurstLeasePath(rootDir);
  try {
    for (const target of [dataDir, ...(existsImpl(leasePath) ? [leasePath] : [])]) {
      const ownerUid = statImpl(target).uid;
      if (ownerUid !== uid) {
        return { ok: false, reason: `${target} is owned by uid ${ownerUid}; caller uid ${uid} cannot replace the owner-owned lease` };
      }
    }
  } catch (err) {
    return { ok: false, reason: `cannot verify lease owner: ${err?.message || err}` };
  }
  return { ok: true };
}

const USAGE = `\
Usage:
  adversarial-review burst status [--root <dir>] [--json]
  adversarial-review burst request --repo <owner/repo> --reason <text> [--ttl 30m]
      [--slots <n>] [--budget <usd>] [--pack <token>] [--max-reviews <n>]
      [--requested-by <who>] [--root <dir>] [--json]
  adversarial-review burst revoke [--reason <text>] [--requested-by <who>]
      [--root <dir>] [--json]

Burst capacity is OFF unless a lease is active. --repo and --reason are required
on request: an unscoped or unexplained burst is refused.

A request made while a lease is already active UPDATES that lease in place. It
keeps the lease id and the spend/review ledger — so re-requesting is not a way
around the budget — and it RE-DECLARES SCOPE IN FULL: repos and packs are
exactly what this invocation passes, not a union with the previous ones.
`;

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;
const DURATION_MULTIPLIER_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const QUOTA_RETRY_BACKOFF_MS = [100, 250];
const TRANSIENT_QUOTA_ERROR = /ETIMEDOUT|EAGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|timed?\s*out|temporar|status\s*[:=]?\s*5\d\d/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function parseDurationArg(value) {
  const match = DURATION_RE.exec(String(value || '').trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * DURATION_MULTIPLIER_MS[(match[2] || 'm').toLowerCase()]);
}

export function parseBurstArgs(argv) {
  // A leading flag is a flag, not a subcommand — otherwise `burst --help`
  // parses `--help` as the command name and exits 2 on the one invocation an
  // operator reaches for when they do not know the command names.
  const leadingFlag = String(argv[0] || '').startsWith('-');
  const [subcommand, rest] = leadingFlag ? [null, [...argv]] : [argv[0], argv.slice(1)];
  const options = {
    subcommand: subcommand || null,
    rootDir: TOOL_ROOT,
    json: false,
    help: false,
    repos: [],
    packs: [],
    reason: null,
    requestedBy: null,
    ttlMs: null,
    slots: null,
    budgetUsd: null,
    maxBurstReviews: null,
  };
  const requireValue = (flag, value) => {
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--root') options.rootDir = requireValue('--root', rest[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--repo') options.repos.push(requireValue('--repo', rest[++i]));
    else if (arg === '--pack') options.packs.push(requireValue('--pack', rest[++i]));
    else if (arg === '--reason') options.reason = requireValue('--reason', rest[++i]);
    else if (arg === '--requested-by') options.requestedBy = requireValue('--requested-by', rest[++i]);
    else if (arg === '--ttl') {
      const ttlMs = parseDurationArg(requireValue('--ttl', rest[++i]));
      if (ttlMs === null) throw new Error('--ttl must be a positive duration like 30m, 45s, or 2h');
      options.ttlMs = ttlMs;
    } else if (arg === '--slots') {
      const slots = Number.parseInt(String(requireValue('--slots', rest[++i])), 10);
      if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
      options.slots = slots;
    } else if (arg === '--max-reviews') {
      const cap = Number.parseInt(String(requireValue('--max-reviews', rest[++i])), 10);
      if (!Number.isInteger(cap) || cap < 1) throw new Error('--max-reviews must be a positive integer');
      options.maxBurstReviews = cap;
    } else if (arg === '--budget') {
      const budget = Number.parseFloat(String(requireValue('--budget', rest[++i])));
      if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget must be a positive dollar amount');
      options.budgetUsd = budget;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown burst argument: ${arg}`);
  }
  return options;
}

/**
 * Quota limb of the safety check: which of the DECLARED review fallback classes
 * could actually absorb burst work right now.
 *
 * "Could absorb" is entitled (has a reviewer bot token, so it can post) AND
 * quota-available (its provider is `ok`), which is exactly the pair
 * `resolveReviewerWorkerClassWithFallback` will demand at routing time. Asking
 * the same question here means a lease is never granted for capacity the
 * watcher would then refuse to use.
 *
 * An unreadable fleet-quota status returns `readable: false`, which the safety
 * evaluator treats as a REFUSAL — see the fail-closed note there.
 */
export function collectBurstQuotaSignal({
  env = process.env,
  execFileSyncImpl = execFileSync,
  hqPath = null,
  sleepImpl = sleepSync,
} = {}) {
  const fallbacks = reviewWorkerClassFallback(env).filter((candidate) => providerForQuotaHarness(candidate));
  if (fallbacks.length === 0) {
    return { readable: true, availableClasses: [], groundedClasses: [], reason: 'no-fallback-configured' };
  }
  let statuses;
  for (let attempt = 0; attempt <= QUOTA_RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const stdout = execFileSyncImpl(hqPath || resolveHqPath(env), ['fleet', 'quota', 'status', '--json'], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      statuses = parseHqFleetQuotaStatus(stdout);
      break;
    } catch (err) {
      const transient = TRANSIENT_QUOTA_ERROR.test(`${err?.code || ''} ${err?.message || err}`);
      if (transient && attempt < QUOTA_RETRY_BACKOFF_MS.length) {
        sleepImpl(QUOTA_RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      return {
        readable: false,
        availableClasses: [],
        groundedClasses: [],
        reason: `fleet-quota-status-unavailable: ${err?.message || err}`,
      };
    }
  }
  const availableClasses = [];
  const groundedClasses = [];
  for (const candidate of fallbacks) {
    const entitled = reviewerWorkerClassEntitled(candidate, env);
    const available = providerAvailabilityFromStatuses(statuses, {
      provider: providerForQuotaHarness(candidate),
    }).available;
    if (entitled && available) availableClasses.push(candidate);
    else groundedClasses.push(candidate);
  }
  return { readable: true, availableClasses, groundedClasses, reason: null };
}

function describeScope(values, emptyLabel = '(none)') {
  return Array.isArray(values) && values.length ? values.join('|') : emptyLabel;
}

function renderRefusal(result, { requested }) {
  const lines = [
    'burst lease REFUSED',
    `requested_slots: ${requested.slots ?? '-'}`,
    `repos: ${requested.repos.join(', ') || '-'}`,
    `packs: ${requested.packs.join(', ') || '(none — whole repo scope)'}`,
    `blockers: ${result.blockers.join(', ') || '-'}`,
  ];
  if (result.warnings?.length) lines.push(`warnings: ${result.warnings.join(', ')}`);
  lines.push('');
  lines.push('Burst capacity stays off; the pipeline continues on its AGY-first steady state.');
  return `${lines.join('\n')}\n`;
}

async function runStatus(options, { stdout }) {
  const status = collectReviewerBurstStatus(options.rootDir);
  stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : renderReviewerBurstStatus(status));
  return EXIT_OK;
}

async function runRequest(options, { stdout, stderr, collectHealthImpl, collectQuotaImpl, ownerCheckImpl }) {
  const ownership = ownerCheckImpl(options.rootDir);
  if (!ownership.ok) {
    stderr.write(`error: ${ownership.reason}; run burst request as the data owner\n`);
    return EXIT_REFUSED;
  }
  let healthSnapshot;
  try {
    healthSnapshot = collectHealthImpl({ rootDir: options.rootDir });
  } catch (err) {
    stderr.write(`error: could not read review pipeline health for the burst safety check: ${err?.message || err}\n`);
    return EXIT_RUNTIME;
  }
  const quota = collectQuotaImpl({ env: process.env });
  const safety = normalizeBurstSafetySignals({ healthSnapshot, quota });
  const result = requestReviewerBurstLease({
    rootDir: options.rootDir,
    slots: options.slots ?? undefined,
    ttlMs: options.ttlMs ?? undefined,
    repos: options.repos,
    packs: options.packs,
    budgetUsd: options.budgetUsd ?? undefined,
    maxBurstReviews: options.maxBurstReviews,
    reason: options.reason,
    requestedBy: options.requestedBy,
    safety,
  });
  if (!result.ok) {
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: false, blockers: result.blockers, warnings: result.warnings, safety }, null, 2)}\n`);
    } else {
      stderr.write(renderRefusal(result, { requested: options }));
    }
    return EXIT_REFUSED;
  }
  const status = collectReviewerBurstStatus(options.rootDir);
  if (options.json) {
    stdout.write(`${JSON.stringify({ ok: true, update: result.update, degraded: result.degraded, warnings: result.warnings, status }, null, 2)}\n`);
  } else {
    stdout.write(result.update ? 'burst lease UPDATED (usage and budget carried over)\n' : 'burst lease ACTIVATED\n');
    if (result.update && result.scopeChanged) {
      stdout.write(
        `scope re-declared: repos ${describeScope(result.previousScope.repos)} -> ${describeScope(status.lease.repos)}, `
        + `packs ${describeScope(result.previousScope.packs, '(whole repo scope)')} -> ${describeScope(status.lease.packs, '(whole repo scope)')}\n`
      );
    }
    if (result.degraded) {
      stdout.write(`degraded to ${status.burstSlots} slot(s) from ${options.slots ?? 'default'}: ${result.warnings.join(', ')}\n`);
    }
    stdout.write(renderReviewerBurstStatus(status));
    stdout.write('\nrollback: adversarial-review burst revoke --reason "<why>"\n');
  }
  return EXIT_OK;
}

async function runRevoke(options, { stdout, stderr, ownerCheckImpl }) {
  const ownership = ownerCheckImpl(options.rootDir);
  if (!ownership.ok) {
    stderr.write(`error: ${ownership.reason}; run burst revoke as the data owner\n`);
    return EXIT_REFUSED;
  }
  const result = revokeReviewerBurstLease({
    rootDir: options.rootDir,
    reason: options.reason || 'operator-revoked',
    revokedBy: options.requestedBy,
  });
  const status = collectReviewerBurstStatus(options.rootDir);
  if (!result.ok) {
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: false, reason: result.reason, status }, null, 2)}\n`);
    } else {
      stderr.write(`no active burst lease to revoke (state: ${status.state})\n`);
    }
    return EXIT_REFUSED;
  }
  if (options.json) stdout.write(`${JSON.stringify({ ok: true, status }, null, 2)}\n`);
  else {
    stdout.write('burst lease REVOKED — capacity returns to the AGY-first steady state\n');
    stdout.write(renderReviewerBurstStatus(status));
  }
  return EXIT_OK;
}

export async function burstMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const collectHealthImpl = io.collectHealthImpl || collectReviewPipelineHealth;
  const collectQuotaImpl = io.collectQuotaImpl
    || ((args) => collectBurstQuotaSignal({ ...args, execFileSyncImpl: io.execFileSyncImpl || execFileSync }));
  const ownerCheckImpl = io.ownerCheckImpl || checkBurstMutationOwner;
  let options;
  try {
    options = parseBurstArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help || !options.subcommand) {
    stdout.write(USAGE);
    return options.help ? EXIT_OK : EXIT_USAGE;
  }
  try {
    if (options.subcommand === 'status') return await runStatus(options, { stdout, stderr });
    if (options.subcommand === 'request') {
      return await runRequest(options, { stdout, stderr, collectHealthImpl, collectQuotaImpl, ownerCheckImpl });
    }
    if (options.subcommand === 'revoke') return await runRevoke(options, { stdout, stderr, ownerCheckImpl });
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n`);
    return EXIT_RUNTIME;
  }
  stderr.write(`error: unknown burst command ${options.subcommand}\n\n${USAGE}`);
  return EXIT_USAGE;
}

export const BURST_CLI_EXIT = Object.freeze({
  ok: EXIT_OK,
  refused: EXIT_REFUSED,
  usage: EXIT_USAGE,
  runtime: EXIT_RUNTIME,
});

export { evaluateBurstSafety, USAGE as BURST_USAGE };
