// REMEDIATIONOWNER-01: defer to an observed live PR owner.
//
// A follow-up remediation job runs either locally (bare mode) or as an HQ
// launch. A local job is invisible to HQ, so `hq dispatch --pr` cannot refuse
// on its behalf. The path that starts work therefore checks the other side:
// before the follow-up daemon claims a job for (repo, PR), it asks HQ whether
// a live launch (an in-place PR update, a closer/hammer, a repair-in-place
// epoch or another remediator) already owns that PR. It uses the same
// live-launch query that `hq dispatch --pr` uses for its own refusal
// (`hq merge-agent pr-owner`), rather than a second ownership store.
//
// Unknown is not free: a failed, timed-out, malformed or unsupported lookup
// defers the job exactly like a live owner does. The deferral is recorded on
// the pending job and re-evaluated on the next claim pass. Nothing here
// cancels or touches a job that is already running.
//
// The path that starts work asks twice. The claim-time lookup admits a pending
// job; `deferClaimedJobForLivePrOwner` asks HQ again immediately before the
// worker runtime starts, after the slow pre-spawn gates (OAuth, workspace
// preparation, lifecycle and mergeability reads). A launch that HQ started in
// between returns the claimed job to pending, budget neutral, naming the owner.
// The HQ answer remains a read: an HQ launch admitted after the spawn-time
// lookup, or an HQ dispatch that cannot see a running local worker, is the HQ
// side's admission to refuse (agent-os REMEDIATIONOWNER-01 residual risk).
// There is no second ownership store.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { writeFollowUpJob } from './follow-up-job-write.mjs';
import { requeueClaimedFollowUpJobBeforeSpawn } from './remediation-claimed-requeue.mjs';

export const LIVE_PR_OWNER_DEFERRED = 'deferred-live-pr-owner';
export const LIVE_PR_OWNER_UNKNOWN = 'deferred-live-pr-owner-unknown';
// Bounds the number of HQ lookups one claim attempt may spend. A pass that
// hits it saves its scan position so the next pass starts with unchecked jobs.
export const LIVE_PR_OWNER_LOOKUPS_PER_CLAIM = 25;
const LAUNCH_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
// The exact usage error an older `hq merge-agent` prints for this subcommand.
// It is reported as its own unknown reason so the operator sees a deploy gap.
const UNSUPPORTED = /unknown merge-agent subcommand: pr-owner\b/u;

function bounded(value, max = 128) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function unknown(reason, detail = null) {
  return { state: 'unknown', reason, ...(detail ? { detail: bounded(detail, 200) } : {}) };
}

// Parse the last JSON line of `hq merge-agent pr-owner --json`. Anything that is
// not an explicit, well-formed answer is unknown.
export function parseLivePrOwnerReply(stdout) {
  const line = String(stdout || '').trim().split('\n').filter(Boolean).at(-1);
  let reply;
  try { reply = JSON.parse(line); } catch { return unknown('lookup-malformed'); }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return unknown('lookup-malformed');
  if (reply.ok !== true) return unknown(bounded(reply.reason) || 'lookup-unavailable');
  if (reply.owner === null) return { state: 'free' };
  const owner = reply.owner;
  if (!owner || typeof owner !== 'object' || !LAUNCH_ID.test(String(owner.launchRequestId || ''))) {
    return unknown('lookup-malformed');
  }
  return {
    state: 'owned',
    owner: {
      launchRequestId: owner.launchRequestId,
      workerClass: bounded(owner.workerClass),
      launchStatus: bounded(owner.status),
      kind: bounded(owner.kind),
    },
  };
}

function resolveHqBin(env) {
  return String(env.HQ_BIN || '').trim() || 'hq';
}

// Production lookup. Only the follow-up daemon composition roots wire this in;
// tests inject a stub so the suite never reaches a live HQ.
export function createLivePrOwnerLookup({
  env = process.env,
  execFileImpl = promisify(execFile),
  timeoutMs = loadAwareTimeoutMs(20_000),
  log = console,
} = {}) {
  return async function lookupLivePrOwner({ repo, prNumber }) {
    const args = ['merge-agent', 'pr-owner', '--repo', String(repo), '--pr', String(prNumber), '--json'];
    if (env.HQ_ROOT) args.push('--root', env.HQ_ROOT);
    let stdout;
    try {
      ({ stdout } = await execFileImpl(resolveHqBin(env), args, {
        env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8',
      }));
    } catch (error) {
      if (error?.code === 64 && UNSUPPORTED.test(String(error.stderr || ''))) {
        // HQ offers no answer, so ownership is unknown: defer rather than proceed.
        log.warn?.('[follow-up] hq merge-agent pr-owner is not deployed; deferring remediation until it is');
        return unknown('lookup-unsupported');
      }
      // A non-zero exit may still carry a typed refusal on stdout.
      const typed = error?.stdout ? parseLivePrOwnerReply(error.stdout) : null;
      if (typed?.state === 'unknown' && typed.reason !== 'lookup-malformed') return typed;
      return unknown(error?.killed || error?.code === 'ETIMEDOUT' ? 'lookup-timeout' : 'lookup-failed',
        error?.code ? String(error.code) : null);
    }
    return parseLivePrOwnerReply(stdout);
  };
}

export function livePrOwnerDeferralRecord(result, observedAt) {
  if (result?.state === 'free') return null;
  if (result?.state === 'owned') {
    return { reason: LIVE_PR_OWNER_DEFERRED, ...result.owner, observedAt };
  }
  return { reason: LIVE_PR_OWNER_UNKNOWN, lookupReason: result?.reason || 'lookup-failed',
    ...(result?.detail ? { lookupDetail: result.detail } : {}), observedAt };
}

// Timestamps aside, an unchanged record is not rewritten on every pass.
function sameDeferral(left, right) {
  if (!left || !right) return false;
  const identity = record => JSON.stringify(Object.entries(record)
    .filter(([key]) => key !== 'observedAt' && key !== 'since'));
  return identity(left) === identity(right);
}

// Same normalization as the claim loop's repo#pr exclusion key.
export function livePrOwnerKey(job) {
  return `${String(job?.repo || '').toLowerCase()}#${job?.prNumber || ''}`;
}

// Build the synchronous claim-time decision for one claim attempt.
// `results` maps repo#pr keys to lookup results gathered by the caller.
// - no result yet: ask the caller to look this PR up, then retry the claim;
// - owned or unknown: record the deferral on the pending job and skip it;
// - free: clear a stale deferral and let the claim proceed.
export function createLivePrOwnerClaimDecision({ results, observedAt, writeJobImpl = writeFollowUpJob, log = console }) {
  return function decideLivePrOwner(pendingJob, pendingPath) {
    const key = livePrOwnerKey(pendingJob);
    if (!results.has(key)) {
      return { action: 'lookup', lookup: { key, repo: pendingJob.repo,
        prNumber: Number(pendingJob.prNumber), pendingName: basename(pendingPath) } };
    }
    const record = livePrOwnerDeferralRecord(results.get(key), observedAt);
    const previous = pendingJob.livePrOwnerDeferral || null;
    if (!record) {
      if (previous) {
        delete pendingJob.livePrOwnerDeferral;
        writeJobImpl(pendingPath, pendingJob);
      }
      return { action: 'claim' };
    }
    if (!sameDeferral(previous, record)) {
      const since = previous?.reason === record.reason ? previous.since || previous.observedAt : observedAt;
      writeJobImpl(pendingPath, { ...pendingJob, livePrOwnerDeferral: { ...record, since } });
      const waitingFor = record.launchRequestId
        ? `waiting for ${record.launchRequestId} (${record.workerClass || 'unknown class'}, ${record.launchStatus || 'live'})`
        : `owner lookup ${record.lookupReason}`;
      log.log?.(`[follow-up] ${record.reason} ${pendingJob.repo}#${pendingJob.prNumber} job=${pendingJob.jobId}: ${waitingFor}`);
    }
    return { action: 'defer', reason: record.reason };
  };
}

// Claim one follow-up job after checking observed ownership.
// `claim(claimedAt, decision, pendingAfter)` runs the synchronous queue claim,
// rotating its lexical pending scan after pendingAfter (a filename, not a path).
// Without a lookup the claim is unchanged.
// Each `lookup` answer settles one repo#pr key and the claim is retried, so the
// loop ends after at most LIVE_PR_OWNER_LOOKUPS_PER_CLAIM lookups.
export async function claimWithLivePrOwnerGate({ claim, lookupImpl, rootDir, observedAt, log = console }) {
  if (!lookupImpl) return claim(observedAt, null);
  const cursorPath = rootDir ? join(rootDir, 'data', 'follow-up-jobs', 'live-pr-owner-scan-cursor.json') : null;
  let pendingAfter = null;
  if (cursorPath) {
    try {
      const cursor = JSON.parse(readFileSync(cursorPath, 'utf8'));
      if (typeof cursor.after === 'string' && /^[^/\\]+\.json$/u.test(cursor.after)) pendingAfter = cursor.after;
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn?.(`[follow-up] live PR-owner cursor unreadable: ${error.message}`);
    }
  }
  const results = new Map();
  const decision = createLivePrOwnerClaimDecision({ results, observedAt, log });
  let lastLookedUp = null;
  const saveCursor = after => {
    if (!cursorPath) return;
    try {
      if (after) writeFileAtomic(cursorPath, `${JSON.stringify({ after })}\n`);
      else rmSync(cursorPath, { force: true });
    } catch (error) {
      // Cursor persistence cannot strand an already claimed job before spawn.
      log.warn?.(`[follow-up] live PR-owner cursor update failed: ${error.message}`);
    }
  };
  for (;;) {
    const claimed = claim(observedAt, decision, pendingAfter);
    if (!claimed?.ownerLookup) {
      saveCursor(null);
      return claimed;
    }
    if (results.size >= LIVE_PR_OWNER_LOOKUPS_PER_CLAIM) {
      saveCursor(lastLookedUp);
      return { ownerLookupBudget: true };
    }
    const { key, repo, prNumber } = claimed.ownerLookup;
    // A thrown or empty answer is unknown, and unknown defers like an owner.
    results.set(key, await lookupOnce(lookupImpl, { repo, prNumber }));
    lastLookedUp = claimed.ownerLookup.pendingName;
  }
}

async function lookupOnce(lookupImpl, job) {
  let result = null;
  try { result = await lookupImpl({ repo: job.repo, prNumber: Number(job.prNumber) }); } catch { /* unknown below */ }
  return result && typeof result === 'object' ? result : unknown('lookup-failed');
}

// Spawn-time recheck for a claimed job that has not reached the worker runtime.
// Returns null when HQ reports no live owner. Otherwise the job goes back to
// pending through the shared budget-neutral pre-spawn requeue, carrying the
// typed `livePrOwnerDeferral` that names the owner, and keeps an explicit
// operator retrigger's one-shot override (see requeueClaimedJobForConflictedBaseProbe).
export async function deferClaimedJobForLivePrOwner({
  rootDir, claimed, lookupImpl, now = () => new Date().toISOString(), delayedPendingPaths = null,
  requeueImpl = requeueClaimedFollowUpJobBeforeSpawn, writeJobImpl = writeFollowUpJob, log = console,
}) {
  if (!lookupImpl || !claimed?.job || !claimed.jobPath) return null;
  const observedAt = now();
  const record = livePrOwnerDeferralRecord(await lookupOnce(lookupImpl, claimed.job), observedAt);
  if (!record) return null;
  const override = claimed.job.remediationPlan?.nextAction;
  const previous = claimed.job.livePrOwnerDeferral || null;
  const requeued = requeueImpl({ rootDir, jobPath: claimed.jobPath, requeuedAt: observedAt });
  const since = previous?.reason === record.reason ? previous.since || previous.observedAt || observedAt : observedAt;
  const job = { ...requeued.job, livePrOwnerDeferral: { ...record, since } };
  if (override?.operatorOverride === true) {
    job.remediationPlan = { ...job.remediationPlan,
      nextAction: { ...override, ...job.remediationPlan?.nextAction, operatorOverride: true } };
  }
  writeJobImpl(requeued.jobPath, job);
  delayedPendingPaths?.add?.(requeued.jobPath);
  const waitingFor = record.launchRequestId
    ? `${record.launchRequestId} (${record.workerClass || 'unknown class'}, ${record.launchStatus || 'live'})`
    : `unknown owner (${record.lookupReason})`;
  log.warn?.(`[follow-up] ${record.reason} before spawn ${claimed.job.repo}#${claimed.job.prNumber} `
    + `job=${claimed.job.jobId}: returned to pending; owner ${waitingFor}`);
  return {
    consumed: false,
    reason: record.reason,
    ...(record.launchRequestId ? { owner: { launchRequestId: record.launchRequestId, workerClass: record.workerClass,
      launchStatus: record.launchStatus, kind: record.kind } } : { lookupReason: record.lookupReason }),
    job,
    jobPath: requeued.jobPath,
  };
}
