import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { isPgidAlive, verifyPgidIdentity } from './process-group-identity.mjs';
import {
  getReviewRow,
  openReviewStateDb,
} from './review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VALID_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']);

// Default cancellable statuses: only `reviewing` is in-flight by definition.
// Operators can extend this set via `--allow-status` to handle two real
// post-merge race shapes (documented in STATE-MACHINE.md):
//   - row already transitioned to `posted` (a prior attempt completed) but
//     the watcher subsequently re-spawned a retry whose subprocess is still
//     alive when the PR merges. The retry's review is now wasted work.
//   - row landed in `failed` after a subprocess error but the subprocess
//     itself is still draining (timeout / cleanup path) and worth signalling.
// The default behavior is unchanged: passing no `--allow-status` flag keeps
// the strict `reviewing`-only guard.
const DEFAULT_CANCELLABLE_STATUSES = new Set(['reviewing']);
// Statuses that may be added via --allow-status. Excludes `pending`
// (nothing to signal — no subprocess) and the sticky terminal states
// (`failed-orphan`, `malformed`) where cancel semantics don't apply.
const ALLOW_STATUS_OPTIONS = new Set([
  'reviewing',
  'posted',
  'failed',
]);

function parseAllowStatus(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('--allow-status requires a non-empty comma-separated list of statuses');
  }
  const statuses = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 0) {
    throw new Error('--allow-status requires a non-empty comma-separated list of statuses');
  }
  for (const status of statuses) {
    if (!ALLOW_STATUS_OPTIONS.has(status)) {
      throw new Error(
        `Unsupported status ${JSON.stringify(status)} for --allow-status. ` +
        `Supported: ${[...ALLOW_STATUS_OPTIONS].sort().join(', ')}.`,
      );
    }
  }
  return new Set(statuses);
}

function parseSignal(value) {
  const signal = String(value || 'SIGTERM').trim().toUpperCase();
  if (!VALID_SIGNALS.has(signal)) {
    throw new Error(`Unsupported signal ${JSON.stringify(value)}. Supported: ${[...VALID_SIGNALS].join(', ')}`);
  }
  return signal;
}

function parseArgs(argv) {
  const args = [...argv];
  let repo = null;
  let prNumber = null;
  let signal = 'SIGTERM';
  let allowStatus = null;
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
    if (arg === '--signal') {
      signal = parseSignal(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--signal=')) {
      signal = parseSignal(arg.slice('--signal='.length));
      continue;
    }
    if (arg === '--allow-status') {
      allowStatus = parseAllowStatus(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--allow-status=')) {
      allowStatus = parseAllowStatus(arg.slice('--allow-status='.length));
      continue;
    }
    reasonParts.push(arg);
  }

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Usage: node src/review-cancel.mjs --repo <owner/repo> --pr <number> [--signal SIGTERM] [--allow-status reviewing,posted,failed] [reason]');
  }

  return {
    repo,
    prNumber,
    signal,
    allowStatus,
    reason: reasonParts.join(' ').trim() || 'Operator requested active review cancellation.',
  };
}

function reviewerCancelHandle(row) {
  const pgid = Number(row?.reviewer_pgid);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

async function sendReviewerSignal({
  pgid,
  startedAt,
  signal,
  processKill = process.kill,
  execFileImpl,
} = {}) {
  if (!pgid) {
    return { signalled: false, target: null, error: 'missing-reviewer-process-group' };
  }
  if (pgid === process.pid) {
    return { signalled: false, target: null, error: 'refusing-to-signal-current-process' };
  }
  if (!isPgidAlive(pgid, processKill)) {
    return { signalled: false, target: { kind: 'process-group', id: pgid }, error: 'process-group-not-found' };
  }
  const identity = await verifyPgidIdentity(pgid, startedAt, { execFileImpl });
  if (!identity.match) {
    return {
      signalled: false,
      target: { kind: 'process-group', id: pgid },
      error: 'identity-unconfirmed',
      identity,
    };
  }
  try {
    processKill(-pgid, parseSignal(signal));
    return { signalled: true, target: { kind: 'process-group', id: pgid }, error: null, identity };
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return { signalled: false, target: { kind: 'process-group', id: pgid }, error: 'process-group-not-found' };
    }
    return { signalled: false, target: { kind: 'process-group', id: pgid }, error: err?.message || String(err) };
  }
}

function sanitizePathSegment(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180) || 'unknown';
}

function cancellationReceiptPath(rootDir, receipt, attempt = 0) {
  const safeRepo = sanitizePathSegment(receipt.repo);
  const safePr = sanitizePathSegment(`pr-${receipt.prNumber}`);
  const safeTs = sanitizePathSegment(receipt.requestedAt);
  const suffix = attempt ? `.${attempt}` : '';
  return join(rootDir, 'data', 'review-cancellations', `${safeRepo}-${safePr}-${safeTs}${suffix}.json`);
}

function writeCancellationReceipt(rootDir, receipt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filePath = cancellationReceiptPath(rootDir, receipt, attempt);
    if (existsSync(filePath)) continue;
    try {
      writeFileAtomic(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { overwrite: false });
      return filePath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Unable to allocate review-cancellation receipt for ${receipt.repo}#${receipt.prNumber}`);
}

async function cancelActiveReview({
  rootDir = ROOT,
  repo,
  prNumber,
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  reason = 'Operator requested active review cancellation.',
  signal = 'SIGTERM',
  // Optional Set<string> of allowed source statuses. When unset, the
  // default `reviewing`-only guard applies. See DEFAULT_CANCELLABLE_STATUSES
  // and ALLOW_STATUS_OPTIONS above for the rationale (post-merge race +
  // failed-with-draining-subprocess shapes from 2026-05-30 incident).
  allowStatus = null,
  processKill = process.kill,
  execFileImpl,
  db: dbOverride = null,
} = {}) {
  // Defensive copy on both branches: callers (and any future mutation of
  // `cancellableStatuses` inside this scope) must never leak through to the
  // module-level DEFAULT_CANCELLABLE_STATUSES constant.
  const cancellableStatuses = allowStatus
    ? new Set([...DEFAULT_CANCELLABLE_STATUSES, ...allowStatus])
    : new Set(DEFAULT_CANCELLABLE_STATUSES);
  const db = dbOverride || openReviewStateDb(rootDir);
  const restoreQueryOnly = dbOverride
    ? db.pragma('query_only', { simple: true })
    : null;
  try {
    db.pragma('query_only = 1');
    const row = getReviewRow(db, { repo, prNumber });
    if (!row) {
      throw new Error(`No review row found for ${repo}#${prNumber}`);
    }
    if (!cancellableStatuses.has(row.review_status)) {
      const allowed = [...cancellableStatuses].sort().join(', ');
      throw new Error(
        `Cannot cancel review for ${repo}#${prNumber} from status ` +
        `${row.review_status} (cancellable: ${allowed}; pass ` +
        `--allow-status <comma-list> to extend).`,
      );
    }

    const pgid = reviewerCancelHandle(row);
    const signalResult = await sendReviewerSignal({
      pgid,
      startedAt: row.reviewer_started_at || null,
      signal,
      processKill,
      execFileImpl,
    });
    // Watcher can promote `failed → reviewing` via stmtMarkAttemptStarted
    // between the operator's snapshot and our signal attempt. If the
    // identity check refused (start-time drift, pgid recycled), re-fetch
    // the row so the receipt + return value carry the post-promote state
    // and the operator gets actionable feedback instead of just
    // "identity-unconfirmed".
    let postSignalRow = null;
    if (
      signalResult.error === 'identity-unconfirmed'
      && row.review_status === 'failed'
    ) {
      const fresh = getReviewRow(db, { repo, prNumber });
      if (
        fresh
        && (
          fresh.review_status !== row.review_status
          || Number(fresh.reviewer_pgid) !== Number(row.reviewer_pgid)
          || fresh.reviewer_started_at !== row.reviewer_started_at
        )
      ) {
        postSignalRow = {
          status: fresh.review_status,
          reviewerPgid: reviewerCancelHandle(fresh),
          reviewerStartedAt: fresh.reviewer_started_at || null,
        };
        signalResult.postSignalState = postSignalRow;
        signalResult.hint =
          `row transitioned to ${fresh.review_status} mid-cancel (pgid=${reviewerCancelHandle(fresh) ?? 'null'}); ` +
          `re-run without --allow-status to target the live reviewer.`;
      }
    }
    const receipt = {
      kind: 'adversarial-review-active-review-cancellation',
      schemaVersion: 1,
      requestedAt,
      requestedBy,
      reason,
      signal: parseSignal(signal),
      repo,
      prNumber,
      review: {
        status: row.review_status,
        reviewer: row.reviewer || null,
        reviewerSessionUuid: row.reviewer_session_uuid || null,
        reviewerPgid: pgid,
        reviewerStartedAt: row.reviewer_started_at || null,
        reviewerHeadSha: row.reviewer_head_sha || null,
        linearTicketId: row.linear_ticket || null,
      },
      result: signalResult,
      postSignalState: postSignalRow,
    };
    const receiptPath = writeCancellationReceipt(rootDir, receipt);
    return {
      ...signalResult,
      receipt,
      receiptPath,
    };
  } finally {
    if (dbOverride) {
      db.pragma(`query_only = ${restoreQueryOnly ? 1 : 0}`);
    }
    if (!dbOverride) {
      db.close();
    }
  }
}

async function main() {
  try {
    const { repo, prNumber, signal, allowStatus, reason } = parseArgs(process.argv.slice(2));
    const result = await cancelActiveReview({
      rootDir: ROOT,
      repo,
      prNumber,
      signal,
      allowStatus,
      reason,
    });
    const target = result.target ? `${result.target.kind}:${result.target.id}` : 'none';
    console.log(`[review-cancel] signalled=${result.signalled} target=${target} receipt=${result.receiptPath}`);
    if (result.hint) {
      console.log(`[review-cancel] hint: ${result.hint}`);
    }
    if (!result.signalled) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[review-cancel] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  cancelActiveReview,
  parseArgs,
  reviewerCancelHandle,
  sendReviewerSignal,
};
