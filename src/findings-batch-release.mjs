import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import fsExt from 'fs-ext';
import { findingBatchDispatchScope, releaseFindingBatch, FINDING_BATCH_MAX_ATTEMPTS } from './findings-batch.mjs';
import { parseHqDispatchStatus, readDispatchReceipt } from './producer-contracts/dispatch-receipt.mjs';
import { readDispatchStatus, readLaunchRequestStatus } from './producer-contracts/launch-status.mjs';
import { readLaunchRequestByIdempotencyKeyAsync } from './session-ledger-read-adapter.mjs';
import { resolveHqRoot } from './hq-root.mjs';

const execFileAsync = promisify(execFile);
const BATCH_ID = /^[a-f0-9]{64}$/;

// FINDINGSBATCHSTRAND-01 operator verb. Retry returns the batch's open findings
// to the queue through the ordinary release helper (batch_attempts + 1, third
// attempt exhausts); drop settles them with the operator's reason. Both refuse
// while any launch that could still write to the batch is live or unknown.
export function validateOperatorRelease({ batchId, mode, reason }) {
  if (typeof batchId !== 'string' || !BATCH_ID.test(batchId)) throw Error('--batch must be a full 64-hex batch id');
  if (!['retry', 'drop'].includes(mode)) throw Error('--mode must be retry or drop');
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason) || reason.length > 240) {
    throw Error('--reason must be one non-empty line of at most 240 characters');
  }
  return { batchId, mode, reason: reason.trim() };
}

async function readRecordedLaunch(batch, { env, execFileImpl }) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl(env.HQ_BIN || 'hq',
      ['dispatch', 'status', batch.launch_id, '--json', '--root', resolveHqRoot(env)],
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 }));
  } catch { return { refused: 'launch-status-unreadable' }; }
  let status;
  try { status = parseHqDispatchStatus(stdout, { normalize: false }); }
  catch { return { refused: 'launch-status-unreadable' }; }
  if (readDispatchReceipt(status).launchRequestId !== batch.launch_id) return { refused: 'launch-evidence-mismatch' };
  const meaning = readDispatchStatus(status);
  if (meaning.diagnostics.length) return { refused: 'launch-status-unreadable' };
  if (!meaning.terminal) return { refused: 'launch-live', status: meaning.status };
  if (meaning.blockedNeedsDecision) return { refused: 'launch-decision-pending', status: meaning.status };
  return { status: meaning.status };
}

// Custody evidence, in the same order the collector uses: the recorded launch
// through its status, every launch under the batch key through the scoped read.
export async function readOperatorReleaseCustody(batch, { rootDir, env, execFileImpl, readLaunches,
  acceptUnreadableCustody = false }) {
  const recorded = batch.launch_id ? await readRecordedLaunch(batch, { env, execFileImpl }) : null;
  if (recorded?.refused) return { refused: recorded.refused, recordedLaunch: recorded };
  const scope = findingBatchDispatchScope(batch, env);
  let probe;
  try {
    probe = await readLaunches({ env, rootDir, hqRoot: resolveHqRoot(env), ...scope,
      idempotencyKey: `findings-batch-${batch.batch_id}`, timeoutMs: 15_000 });
  } catch { probe = { ok: false }; }
  if (probe?.ok && Array.isArray(probe.rows)) {
    for (const row of probe.rows) {
      const meaning = readLaunchRequestStatus(row?.status);
      if (!meaning.status) return { refused: 'keyed-launch-status-unreadable', recordedLaunch: recorded };
      if (!meaning.terminal) return { refused: 'keyed-launch-live', recordedLaunch: recorded, liveLaunch: row.launch_request_id };
      if (row.status === 'blocked_needs_decision') return { refused: 'launch-decision-pending', recordedLaunch: recorded };
    }
    return { keyedCustody: 'readable', keyedLaunches: probe.rows.length, recordedLaunch: recorded };
  }
  const keyedCustody = probe?.selectorRefused === true ? 'scope-denied' : 'unreadable';
  const publisherSubmitted = existsSync(join(rootDir, 'data', 'finding-batches', batch.batch_id, 'publish-intent.json'));
  // Without the keyed read, only a terminal recorded launch with no publisher
  // submission bounds custody; its retry descendants stay unobserved, so the
  // operator must acknowledge that explicitly.
  if (!batch.launch_id || publisherSubmitted || !acceptUnreadableCustody) {
    return { refused: `keyed-launch-${keyedCustody}`, keyedCustody, publisherSubmitted, recordedLaunch: recorded,
      scope, ...(batch.launch_id && !publisherSubmitted ? { acknowledgeWith: '--accept-unreadable-custody' } : {}) };
  }
  return { keyedCustody, publisherSubmitted, recordedLaunch: recorded, scope, acknowledged: true };
}

function dropFindingBatch(db, batch, reason) {
  return db.transaction(() => {
    const row = db.prepare('SELECT completed_at,released_at FROM finding_batches WHERE batch_id=?').get(batch.batch_id);
    if (!row || row.completed_at || row.released_at) return null;
    const why = `operator-dropped: ${reason}`;
    const dropped = db.prepare(`UPDATE finding_backlog SET outcome='dropped',reason=?,result_pr=NULL
      WHERE batch_id=? AND outcome IS NULL`).run(why, batch.batch_id).changes;
    const notes = db.prepare('UPDATE finding_batch_notes SET dropped_reason=? WHERE batch_id=? AND dropped_reason IS NULL')
      .run(`batch-released: ${why}`, batch.batch_id).changes;
    db.prepare("UPDATE finding_batches SET released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),release_reason=? WHERE batch_id=?")
      .run(why, batch.batch_id);
    return { dropped, notes, reason: why };
  }).immediate();
}

export async function operatorReleaseFindingBatch({ db, rootDir, batchId, mode, reason, apply = false,
  acceptUnreadableCustody = false, env = process.env, execFileImpl = execFileAsync,
  readLaunches = readLaunchRequestByIdempotencyKeyAsync }) {
  ({ batchId, mode, reason } = validateOperatorRelease({ batchId, mode, reason }));
  const batch = db.prepare('SELECT * FROM finding_batches WHERE batch_id=?').get(batchId);
  if (!batch) throw Error('finding batch not found');
  const findings = db.prepare(`SELECT finding_id AS findingId,batch_attempts AS attempts FROM finding_backlog
    WHERE batch_id=? AND outcome IS NULL ORDER BY finding_id`).all(batchId);
  const plan = { batchId, repo: batch.repo, area: batch.area, launchId: batch.launch_id, error: batch.error,
    mode, reason, apply, openFindings: findings.length,
    ...(mode === 'retry' ? { wouldExhaust: findings.filter(f => f.attempts + 1 >= FINDING_BATCH_MAX_ATTEMPTS).length } : {}) };
  if (batch.completed_at || batch.released_at) return { ...plan, applied: false, refused: 'batch-already-settled' };
  // An applied release fences the collector's publication path for the whole
  // check-and-write. A preview creates nothing, not even the lock file.
  const dir = join(rootDir, 'data', 'finding-batches', batchId);
  const fd = apply && existsSync(dir) ? openSync(join(dir, 'publish.lock'), 'a', 0o664) : null;
  try {
    if (fd !== null) {
      try { fsExt.flockSync(fd, 'exnb'); }
      catch (error) {
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return { ...plan, applied: false, refused: 'batch-collection-in-progress' };
        throw error;
      }
    }
    const custody = await readOperatorReleaseCustody(batch, { rootDir, env, execFileImpl, readLaunches, acceptUnreadableCustody });
    if (custody.refused) return { ...plan, applied: false, refused: custody.refused, custody };
    if (!apply) return { ...plan, applied: false, custody };
    const result = mode === 'retry'
      ? releaseFindingBatch(db, batch, `operator-retry: ${reason}`)
      : dropFindingBatch(db, batch, reason);
    if (!result) return { ...plan, applied: false, refused: 'batch-already-settled', custody };
    return { ...plan, applied: true, custody, result };
  } finally { if (fd !== null) closeSync(fd); }
}
