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
    reasonParts.push(arg);
  }

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Usage: node src/review-cancel.mjs --repo <owner/repo> --pr <number> [--signal SIGTERM] [reason]');
  }

  return {
    repo,
    prNumber,
    signal,
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
  processKill = process.kill,
  execFileImpl,
  db: dbOverride = null,
} = {}) {
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
    if (row.review_status !== 'reviewing') {
      throw new Error(`Cannot cancel review for ${repo}#${prNumber} from status ${row.review_status}`);
    }

    const pgid = reviewerCancelHandle(row);
    const signalResult = await sendReviewerSignal({
      pgid,
      startedAt: row.reviewer_started_at || null,
      signal,
      processKill,
      execFileImpl,
    });
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
    const { repo, prNumber, signal, reason } = parseArgs(process.argv.slice(2));
    const result = await cancelActiveReview({
      rootDir: ROOT,
      repo,
      prNumber,
      signal,
      reason,
    });
    const target = result.target ? `${result.target.kind}:${result.target.id}` : 'none';
    console.log(`[review-cancel] signalled=${result.signalled} target=${target} receipt=${result.receiptPath}`);
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
