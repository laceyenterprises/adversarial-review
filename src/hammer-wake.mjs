// ARC-19: extracted from follow-up-remediation.mjs. The hammer wake is a
// self-contained effect --- it takes a stopped follow-up job and turns it into
// a watcher wake plus a latency event --- so it belongs beside the other
// adapters rather than inside the claim loop. Extracting it also pulls
// follow-up-remediation.mjs back under the ARC-19 R3 line ratchet, which is
// decrease-only by contract.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  recordReviewLatencyEvent,
} from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';
import { writeFollowUpJob } from './follow-up-jobs.mjs';

// Mirrors the definition in follow-up-remediation.mjs: the repo root is two
// levels up from this module, not something either file imports.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function requestHammerWakeForSettledReviewStop({
  rootDir = ROOT,
  job,
  jobPath = null,
  stoppedAt = new Date().toISOString(),
  requestWatcherWakeImpl = requestWatcherWake,
  log = console,
} = {}) {
  const repo = String(job?.repo || '').trim();
  const prNumber = Number(job?.prNumber);
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { requested: false, reason: 'invalid-job-subject' };
  }

  const requestedAt = String(
    job?.stoppedAt
    || job?.remediationPlan?.stop?.stoppedAt
    || stoppedAt
    || new Date().toISOString()
  );
  const revisionRef = String(job?.revisionRef || job?.headSha || '').trim();
  const reason = 'clean-verdict-to-hammer';
  let wakeRecord;
  try {
    const wake = requestWatcherWakeImpl({
      rootDir,
      reason,
      repo,
      prNumber,
      requestedAt,
    });
    wakeRecord = {
      requested: wake?.requested === true,
      reason: wake?.payload?.reason || reason,
      requestedAt: wake?.payload?.requested_at || requestedAt,
      requestId: wake?.payload?.request_id || null,
      ...(revisionRef ? { reviewedHeadSha: revisionRef } : {}),
    };
  } catch (err) {
    wakeRecord = {
      requested: false,
      reason: 'wake-failed',
      error: err?.message || String(err),
      requestedAt,
      ...(revisionRef ? { reviewedHeadSha: revisionRef } : {}),
    };
    log.warn?.(
      `[follow-up-remediation] watcher hammer wake failed after settled review stop for ` +
      `${repo}#${prNumber}: ${err?.message || err}`
    );
  }

  // Record the event whether or not the wake succeeded. Gating this on
  // `wakeRecord.requested` meant a FAILED wake wrote nothing to the latency
  // table --- the single number an operator would want from this feature, "how
  // often did the hammer wake fail", was the one case with no telemetry, and a
  // regression to zero wakes would have looked identical to a quiet backlog.
  // The outcome is carried on the event so a failed wake is countable rather
  // than merely absent.
  const wakeOutcome = wakeRecord.requested ? 'requested' : 'failed';
  let latencyEvent = { recorded: false, reason: 'not-attempted' };
  let db = null;
  try {
    db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    recordReviewLatencyEvent(db, {
      repo,
      prNumber,
      domainId: job?.domainId || 'code-pr',
      subjectExternalId: job?.subjectExternalId || `${repo}#${prNumber}`,
      revisionRef: revisionRef || job?.revisionRef || null,
      eventType: 'hammer_wake',
      at: requestedAt,
      source: 'follow-up-remediation',
      sourceRef: job?.jobId || null,
      // Keyed by outcome as well, so a retry that succeeds after a failure is
      // recorded rather than swallowed as a duplicate of the failure.
      idempotencyKey: `follow-up-review-settled-hammer-wake:${wakeOutcome}:${job?.jobId || `${repo}#${prNumber}:${revisionRef || 'no-head'}`}`,
      reason,
      payload: {
        jobId: job?.jobId || null,
        jobPath,
        stopCode: job?.remediationPlan?.stop?.code || 'review-settled',
        wakeOutcome,
        wake: wakeRecord,
      },
    });
    latencyEvent = { recorded: true, eventType: 'hammer_wake', wakeOutcome };
  } catch (err) {
    latencyEvent = {
      recorded: false,
      reason: 'latency-event-failed',
      wakeOutcome,
      error: err?.message || String(err),
    };
    log.warn?.(
      `[follow-up-remediation] hammer wake latency event failed for ` +
      `${repo}#${prNumber}: ${err?.message || err}`
    );
  } finally {
    try {
      db?.close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }

  if (jobPath && job && typeof job === 'object') {
    try {
      writeFollowUpJob(jobPath, {
        ...job,
        hammerWake: wakeRecord,
        hammerWakeLatencyEvent: latencyEvent,
      });
    } catch (err) {
      log.warn?.(
        `[follow-up-remediation] could not persist hammer wake metadata for ` +
        `${repo}#${prNumber}: ${err?.message || err}`
      );
    }
  }

  return { ...wakeRecord, latencyEvent };
}

export { requestHammerWakeForSettledReviewStop };
