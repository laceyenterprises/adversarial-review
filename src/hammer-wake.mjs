// ARC-19: extracted from follow-up-remediation.mjs. The hammer wake is a
// self-contained effect --- it takes a stopped follow-up job and turns it into
// a watcher wake plus a latency event --- so it belongs beside the other
// adapters rather than inside the claim loop. Extracting it also pulls
// follow-up-remediation.mjs back under the ARC-19 R3 line ratchet, which is
// decrease-only by contract.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  recordReviewLatencyEvent,
} from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';
import { writeFollowUpJob } from './follow-up-jobs.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { isClosureRecoveryDecision } from './pr-next-action.mjs';

// Mirrors the definition in follow-up-remediation.mjs: the repo root is two
// levels up from this module, not something either file imports.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const HAMMER_WAKE_AUDIT_SCHEMA_VERSION = 1;
const HAMMER_WAKE_ELIGIBILITY_REASON = 'clean-current-head-ci-green-policy-eligible';
const HAMMER_WAKE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HAMMER_WAKE_RETENTION_MAX_FILES = 5000;
const HAMMER_WAKE_SWEEP_INTERVAL_MS = 60 * 1000;
const hammerWakeSweeps = new Map();
const HAMMER_WAKE_RETRY_ATTEMPTS = 3;
const HAMMER_WAKE_STALE_RESERVATION_MS = 10 * 60 * 1000;

function hammerWakeAuditDir(rootDir) {
  return join(rootDir, 'data', 'hammer-wakes');
}

function hammerWakeDedupeKey({ repo, prNumber, headSha, eligibilityReason, wakeAttemptKey }) {
  const key = `${String(repo || '').trim()}#${Number(prNumber)}@${String(headSha || '').trim()}:${String(eligibilityReason || '').trim()}`;
  return wakeAttemptKey ? `${key}:attempt:${wakeAttemptKey}` : key;
}

function hammerWakeAuditPath(rootDir, identity) {
  const digest = createHash('sha256').update(hammerWakeDedupeKey(identity)).digest('hex');
  return join(hammerWakeAuditDir(rootDir), `${digest}.json`);
}

function staleHammerWakeReservation(record, auditPath, nowMs = Date.now(), maxAgeMs = HAMMER_WAKE_STALE_RESERVATION_MS) {
  if (record?.outcome !== 'reserved') return false;
  let observedMs = Date.parse(record.observedAt || '');
  if (!Number.isFinite(observedMs)) {
    try {
      observedMs = statSync(auditPath).mtimeMs;
    } catch {
      return false;
    }
  }
  return Number.isFinite(observedMs) && nowMs - observedMs > maxAgeMs;
}

async function sweepHammerWakeAudits(
  rootDir,
  {
    nowMs = Date.now(),
    maxAgeMs = HAMMER_WAKE_RETENTION_MS,
    maxFiles = HAMMER_WAKE_RETENTION_MAX_FILES,
  } = {}
) {
  const dir = hammerWakeAuditDir(rootDir);
  let entries;
  try {
    entries = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      try {
        entries.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch { /* A concurrent reservation takeover or sweep can remove a file. */ }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { removed: 0, retained: null };
  }

  let removed = 0;
  const retained = [];
  for (const entry of entries) {
    const expired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && nowMs - entry.mtimeMs > maxAgeMs;
    const overLimit = Number.isFinite(maxFiles) && maxFiles >= 0 && retained.length >= maxFiles;
    if (expired || overLimit) {
      try {
        await rm(entry.path, { force: true });
        removed += 1;
      } catch {
        retained.push(entry);
      }
    } else {
      retained.push(entry);
    }
  }
  return { removed, retained: retained.length };
}

function scheduleHammerWakeAuditSweep(rootDir) {
  const dir = hammerWakeAuditDir(rootDir);
  if (hammerWakeSweeps.has(dir)) return hammerWakeSweeps.get(dir);
  // Coalesce bursts and keep filesystem traversal off the synchronous wake path.
  // Retention is best effort and must never reject into dispatch or keep it alive.
  const sweep = sweepHammerWakeAudits(rootDir)
    .catch(() => ({ removed: 0, retained: null }))
    .finally(() => {
      setTimeout(() => hammerWakeSweeps.delete(dir), HAMMER_WAKE_SWEEP_INTERVAL_MS).unref();
    });
  hammerWakeSweeps.set(dir, sweep);
  return sweep;
}

/**
 * Reserve and fire the event-driven close-lane wake. This deliberately wakes
 * the watcher: that watcher owns the existing AMA daemon/Hammer decision and
 * closer lease, so the hook cannot become a parallel merge authority. Shared
 * callers provide an immutable snapshot/decision pair
 * as the only source of routing intent.
 */
function requestEligibleHammerWake({
  rootDir = ROOT,
  reviewStateDb = null,
  repo,
  prNumber,
  headSha,
  eligibilityReason = HAMMER_WAKE_ELIGIBILITY_REASON,
  observedAt = new Date().toISOString(),
  nowMs = Date.now(),
  requestWatcherWakeImpl = requestWatcherWake,
  log = console,
  retryAttempt = 0,
  shared = null,
} = {}) {
  // A wake transports the selected workflow; it never selects an owner.
  const decision = shared?.decision;
  const recoveryDispatch = isClosureRecoveryDecision(decision) && decision.actor === 'hammer';
  const retryEvidence = recoveryDispatch || decision?.row === 'R08-retry' || decision?.attempt != null
    ? shared.snapshot?.observations?.launches?.value?.closer : null;
  const retryLaunch = retryEvidence?.launchRequestId || null;
  // Fleet descendants reuse the ancestor receipt. Their completed IDs must
  // advance wake identity too; status/timestamp changes alone must not.
  const retryIds = [...new Set((Array.isArray(retryEvidence?.retryChain) ? retryEvidence.retryChain : [])
    .map(row => row?.launch_request_id || row?.launchRequestId || row?.id).filter(id => typeof id === 'string' && id))].sort();
  const retryIdentity = retryIds.length ? `${retryLaunch || 'retry'}:${createHash('sha256')
    .update(JSON.stringify(retryIds)).digest('hex')}` : retryLaunch;
  const wakeAttemptKey = recoveryDispatch
    ? `recovery:${decision.row}:${decision.reason}:${decision.deadline?.anchoredAt}:${retryIdentity || 'initial'}`
    : retryIdentity || (decision?.attempt != null ? `retry-${decision.attempt}` : 'initial');
  let eligibility = { eligible: false, reasons: [] };
  if (shared) {
    const ownsWake = (decision?.action === 'hammer' && decision.actor === 'hammer'
      && decision.queue?.intent === 'dispatch')
      || (decision?.action === 'daemon-merge' && decision.actor === 'daemon' && decision.queue?.intent === 'daemon');
    eligibility = { eligible: Boolean(ownsWake && !decision.queue.deferredBy
      && decision.head === headSha && shared.snapshot?.head === headSha),
      reasons: [decision?.reason].filter(Boolean) };
    if (eligibility.eligible) eligibility.reasons = [];
    eligibilityReason = 'shared-next-action';
  }
  const identity = {
    repo: String(repo || '').trim(),
    prNumber: Number(prNumber),
    headSha: String(headSha || '').trim(),
    eligibilityReason: String(eligibilityReason || '').trim(),
    ...(shared ? { wakeAttemptKey } : {}),
  };
  const eligibilityReasons = Array.isArray(eligibility?.reasons) ? eligibility.reasons : [];
  let outcome = 'skipped';
  let reason = eligibilityReasons[0] || 'not-eligible';
  let auditPath = null;
  let latencyEvent = { recorded: false, reason: 'not-attempted' };
  // Recovery re-reads on the next closure pass. A skipped wake must retain
  // that retry intent without requesting a launch from uncertain evidence.
  let retryable = Boolean(isClosureRecoveryDecision(decision)
    && decision.head === headSha && shared.snapshot?.head === headSha);

  if (!identity.repo || !Number.isInteger(identity.prNumber) || identity.prNumber <= 0 || !identity.headSha || !identity.eligibilityReason) {
    reason = 'invalid-wake-identity';
    retryable = false;
  } else if (eligibility?.eligible === true) {
    try {
      mkdirSync(hammerWakeAuditDir(rootDir), { recursive: true });
      scheduleHammerWakeAuditSweep(rootDir);
    } catch (err) {
      outcome = 'failed';
      reason = 'wake-audit-dir-unavailable';
      retryable = true;
      latencyEvent = { recorded: false, reason: 'not-attempted', error: err?.message || String(err) };
    }
    if (outcome !== 'failed') {
      auditPath = hammerWakeAuditPath(rootDir, identity);
      let retryOfLaunchRequestId = retryLaunch || null;
      const reserved = {
        schemaVersion: HAMMER_WAKE_AUDIT_SCHEMA_VERSION,
        event: 'hammer_wake',
        ...identity,
        observedAt,
        outcome: 'reserved',
        ...(retryOfLaunchRequestId ? { retryOfLaunchRequestId } : {}),
        route: 'watcher-ama-merge-authority',
        ...(shared ? { nextAction: { action: decision.action, actor: decision.actor, reason: decision.reason,
          deadline: decision.deadline, head: decision.head, decisionKey: decision.decisionKey,
          evidenceRefs: decision.evidenceRefs, queue: decision.queue,
          passId: decision.passId, generation: decision.generation } } : {}),
      };
      let reservationCreated = false;
      try {
        writeFileAtomic(auditPath, `${JSON.stringify(reserved, null, 2)}\n`, { overwrite: false });
        reservationCreated = true;
        const wake = requestWatcherWakeImpl({
          rootDir,
          reason: 'merge-eligible-hammer-wake',
          repo: identity.repo,
          prNumber: identity.prNumber,
          headSha: identity.headSha,
          requestedAt: observedAt,
        });
        if (wake?.requested !== true) throw new Error('watcher wake did not confirm request');
        outcome = 'requested';
        reason = decision?.reason || identity.eligibilityReason;
        const requestedRecord = {
          ...reserved,
          outcome,
          requestId: wake?.payload?.request_id || null,
          requestedAt: wake?.payload?.requested_at || observedAt,
        };
        writeFileAtomic(auditPath, `${JSON.stringify(requestedRecord, null, 2)}\n`);
        let db = reviewStateDb;
        try {
          if (!db) {
            db = openReviewStateDb(rootDir);
            ensureReviewStateSchema(db);
          }
          recordReviewLatencyEvent(db, {
            repo: identity.repo,
            prNumber: identity.prNumber,
            domainId: 'code-pr',
            subjectExternalId: `${identity.repo}#${identity.prNumber}`,
            revisionRef: identity.headSha,
            eventType: 'hammer_wake',
            at: observedAt,
            source: 'event-driven-hammer-wake',
            idempotencyKey: `hammer-wake:${hammerWakeDedupeKey(identity)}${retryOfLaunchRequestId ? `:retry:${retryOfLaunchRequestId}` : ''}`,
            reason: decision?.reason || identity.eligibilityReason,
            payload: { outcome, route: reserved.route, requestId: wake?.payload?.request_id || null,
              ...(shared ? { nextAction: reserved.nextAction } : {}) },
          });
          latencyEvent = { recorded: true, eventType: 'hammer_wake', wakeOutcome: outcome };
        } catch (err) {
          latencyEvent = {
            recorded: false,
            reason: 'latency-event-failed',
            wakeOutcome: outcome,
            error: err?.message || String(err),
          };
          try {
            writeFileAtomic(auditPath, `${JSON.stringify({
              ...requestedRecord,
              latencyEvent,
            }, null, 2)}\n`);
          } catch {
            // The wake has already been delivered and recorded as requested.
          }
          log.warn?.(
            `[hammer-wake] latency event failed for ${identity.repo}#${identity.prNumber}: ` +
            `${err?.message || err}`
          );
        } finally {
          try {
            if (!reviewStateDb) db?.close?.();
          } catch {
            // Best-effort cleanup only.
          }
        }
      } catch (err) {
        if (err?.code === 'EEXIST') {
          const prior = readHammerWakeAudit(auditPath);
          if (prior?.outcome === 'failed' || staleHammerWakeReservation(prior, auditPath, nowMs)
            || (prior?.outcome === 'requested' && retryOfLaunchRequestId
              && prior.retryOfLaunchRequestId !== retryOfLaunchRequestId)) {
            if (retryAttempt + 1 >= HAMMER_WAKE_RETRY_ATTEMPTS) {
              outcome = 'failed';
              reason = 'wake-retry-contended';
              retryable = true;
            } else {
              const archivePath = `${auditPath.slice(0, -5)}.retry-${createHash('sha256')
                .update(`${observedAt}:${process.pid}:${retryAttempt}`)
                .digest('hex')
                .slice(0, 12)}.json`;
              try {
                // Rename hands off the path, but is not a content CAS: another
                // process may replace the record between read and rename. The
                // watcher wake is an at-least-once edge trigger; merge authority
                // remains with the watcher after any overlapping retry.
                renameSync(auditPath, archivePath);
                return requestEligibleHammerWake({
                  rootDir,
                  reviewStateDb,
                  ...identity,
                  shared,
                  eligibility,
                  observedAt,
                  nowMs,
                  requestWatcherWakeImpl,
                  log,
                  retryAttempt: retryAttempt + 1,
                });
              } catch (retryErr) {
                if (retryErr?.code === 'ENOENT') {
                  return requestEligibleHammerWake({
                    rootDir,
                    reviewStateDb,
                    ...identity,
                    shared,
                    eligibility,
                    observedAt,
                    nowMs,
                    requestWatcherWakeImpl,
                    log,
                    retryAttempt: retryAttempt + 1,
                  });
                }
                outcome = 'failed';
                reason = 'wake-retry-reservation-failed';
                // The original record may still own the dedupe key; a later
                // pass must inspect its persisted state before retrying.
                retryable = false;
              }
            }
          } else {
            outcome = 'duplicate';
            reason = 'wake-already-recorded';
          }
        } else {
          outcome = 'failed';
          reason = reservationCreated ? 'wake-unavailable' : 'wake-reservation-failed';
          retryable = !reservationCreated;
          try {
            writeFileAtomic(auditPath, `${JSON.stringify({ ...reserved, outcome, reason, error: err?.message || String(err) }, null, 2)}\n`);
            // A later pass can resume only when the failed state is durable.
            retryable = true;
          } catch {
            reason = reservationCreated ? 'wake-unavailable-audit-update-failed' : reason;
          }
        }
      }
    }
  }

  const event = {
    schemaVersion: HAMMER_WAKE_AUDIT_SCHEMA_VERSION,
    event: 'hammer_wake',
    ...identity,
    observedAt,
    outcome,
    reason,
    eligibilityReasons,
    ...(shared ? { nextAction: decision } : {}),
    route: 'watcher-ama-merge-authority',
    // Diagnostic only: the caller relies on a later watcher tick, not this flag.
    retryable,
    latencyEvent,
    ...(auditPath ? { auditPath } : {}),
  };
  try {
    log?.log?.(JSON.stringify(event));
  } catch {
    // Diagnostic logging cannot make the wake helper throw into AMA closure.
  }
  return event;
}

function readHammerWakeAudit(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

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
        stopCode: job?.remediationPlan?.stop?.code || 'no-remediation-required',
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

export {
  HAMMER_WAKE_ELIGIBILITY_REASON,
  HAMMER_WAKE_RETENTION_MAX_FILES,
  HAMMER_WAKE_RETENTION_MS,
  hammerWakeAuditDir,
  hammerWakeAuditPath,
  hammerWakeDedupeKey,
  readHammerWakeAudit,
  requestEligibleHammerWake,
  requestHammerWakeForSettledReviewStop,
  scheduleHammerWakeAuditSweep,
  sweepHammerWakeAudits,
};
