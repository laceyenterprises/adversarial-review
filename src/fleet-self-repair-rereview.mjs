// FSR-06B — honour a fleet-self-repair re-review request for a trailer-only
// head move, and never leave one silently parked.
//
// `modules/fleet-self-repair` (agent-os) sweeps the watcher's `reviewed_prs`
// hourly for a `posted` row whose PR head moved after the review with an EMPTY
// branch diff (a trailer / provenance commit). Its clear flips that row to
// `pending` with a `rereview_reason` that starts with the FSR-06B marker and
// names both heads:
//
//   FSR-06B: trailer-only head move detected; request fresh adversarial review.
//   reviewed=<40-hex> live=<40-hex>
//
// That request is automation, not an operator. It therefore does NOT get the
// operator `retrigger-review:` bypass. Instead the watcher re-derives the
// premise from its own daemon clone — `reviewed` is an ancestor of `live`, the
// two trees are identical, and `live` is the head the tick is looking at — and
// only a verified request may pass the remediation-round budget suppression and
// the hard review ceilings. Verification fails CLOSED: a git error, a missing
// checkout, a missing SHA, or a moved head is "not verified", never "empty".
//
// A request the watcher will not spawn (terminal closer head, review-cycle-cap
// pause, or an unverified request that ordinary policy suppresses) is DECLINED:
// the row is restored to `posted` with `rereview_reason` set to
// `FSR-06B declined: <reason>; reviewed=<sha> live=<sha>`, so merge authority
// keeps its verdict and the next FSR sweep escalates to an operator instead of
// re-requesting every hour. A `pending` FSR-06B row is therefore always either
// spawned or declined within the tick that reads it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  fetchVerifiedCommitFromLocalGit,
  resolveLocalRepoCheckout,
} from './head-closer-commit-suppression.mjs';

const execFileAsync = promisify(execFile);

export const FLEET_SELF_REPAIR_TRAILER_ONLY_REREVIEW_MARKER = 'FSR-06B';
export const FLEET_SELF_REPAIR_REREVIEW_DECLINED_MARKER = 'FSR-06B declined';

const LOCAL_GIT_TIMEOUT_MS = 5000;
const LOCAL_GIT_MAX_BUFFER = 1024 * 1024 * 16;
const FULL_SHA_RE = /^[a-f0-9]{40}$/;
const REVIEWED_HEAD_RE = /\breviewed=([a-f0-9]{40})\b/i;
const LIVE_HEAD_RE = /\blive=([a-f0-9]{40})\b/i;

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return FULL_SHA_RE.test(sha) ? sha : null;
}

export function isFleetSelfRepairTrailerOnlyRereviewReason(reason) {
  return String(reason || '')
    .trim()
    .toLowerCase()
    .startsWith(`${FLEET_SELF_REPAIR_TRAILER_ONLY_REREVIEW_MARKER.toLowerCase()}:`);
}

export function isFleetSelfRepairRereviewDeclinedReason(reason) {
  return String(reason || '')
    .trim()
    .toLowerCase()
    .startsWith(`${FLEET_SELF_REPAIR_REREVIEW_DECLINED_MARKER.toLowerCase()}:`);
}

// A row is an FSR-06B request only while it is armed for review: the marker
// plus `rereview_requested_at`, mirroring `isExplicitOperatorReviewRetrigger`.
export function isFleetSelfRepairTrailerOnlyRereview(reviewRow = null) {
  return Boolean(
    reviewRow?.rereview_requested_at
      && isFleetSelfRepairTrailerOnlyRereviewReason(reviewRow.rereview_reason)
  );
}

export function parseFleetSelfRepairTrailerOnlyRereviewReason(reason) {
  const text = String(reason || '');
  if (!isFleetSelfRepairTrailerOnlyRereviewReason(text)) {
    return { marker: false, reviewedHeadSha: null, liveHeadSha: null };
  }
  return {
    marker: true,
    reviewedHeadSha: normalizeSha(text.match(REVIEWED_HEAD_RE)?.[1]),
    liveHeadSha: normalizeSha(text.match(LIVE_HEAD_RE)?.[1]),
  };
}

export function buildFleetSelfRepairRereviewDeclinedReason({
  reason,
  reviewedHeadSha = null,
  liveHeadSha = null,
} = {}) {
  const detail = String(reason || 'declined').trim().replace(/\s+/g, ' ');
  const heads = [
    reviewedHeadSha ? `reviewed=${String(reviewedHeadSha).trim()}` : null,
    liveHeadSha ? `live=${String(liveHeadSha).trim()}` : null,
  ].filter(Boolean).join(' ');
  return `${FLEET_SELF_REPAIR_REREVIEW_DECLINED_MARKER}: ${detail}${heads ? `; ${heads}` : ''}`;
}

function gitExitCode(err) {
  const code = err?.code;
  return Number.isInteger(code) ? code : null;
}

// Run a boolean git predicate whose exit status is the answer: 0 => true,
// 1 => false, anything else => a real error (caller fails closed).
async function runGitPredicate(execFileImpl, checkoutDir, args) {
  try {
    await execFileImpl('git', ['-C', checkoutDir, ...args], {
      timeout: LOCAL_GIT_TIMEOUT_MS,
      maxBuffer: LOCAL_GIT_MAX_BUFFER,
    });
    return true;
  } catch (err) {
    if (gitExitCode(err) === 1 && !String(err?.stderr || '').trim()) return false;
    throw err;
  }
}

async function runGitOutput(execFileImpl, checkoutDir, args) {
  const { stdout } = await execFileImpl('git', ['-C', checkoutDir, ...args], {
    timeout: LOCAL_GIT_TIMEOUT_MS,
    maxBuffer: LOCAL_GIT_MAX_BUFFER,
  });
  return String(stdout || '');
}

// Re-derive "the head moved by trailer-only commits" from the daemon clone.
// Every non-affirmative outcome is `verified: false` with a reason; the caller
// must treat those identically (no bypass), which is the postmortem's rule
// that a failed diff read must never read as an empty diff.
export async function verifyTrailerOnlyHeadDelta({
  repoPath,
  prNumber,
  reviewedHeadSha,
  currentHeadSha,
  hqRoot = process.env.HQ_ROOT,
  execFileImpl = execFileAsync,
  fetchVerifiedCommitFromLocalGitImpl = fetchVerifiedCommitFromLocalGit,
  resolveLocalRepoCheckoutImpl = resolveLocalRepoCheckout,
  logger = console,
} = {}) {
  const reviewed = normalizeSha(reviewedHeadSha);
  const current = normalizeSha(currentHeadSha);
  const base = { verified: false, reviewedHeadSha: reviewed, currentHeadSha: current };
  if (!reviewed || !current) {
    return { ...base, reason: 'heads-unresolved' };
  }
  if (reviewed === current) {
    return { ...base, reason: 'reviewed-head-is-current-head' };
  }
  let checkoutDir = null;
  try {
    checkoutDir = await resolveLocalRepoCheckoutImpl(repoPath, hqRoot);
  } catch (err) {
    return { ...base, reason: 'checkout-resolve-failed', detail: err?.message || String(err) };
  }
  if (!checkoutDir) {
    return { ...base, reason: 'no-local-checkout' };
  }
  // Make sure both objects are present locally (fetches a missing head into
  // the clone the same way the closer-commit reader does).
  for (const sha of [reviewed, current]) {
    let commit = null;
    try {
      commit = await fetchVerifiedCommitFromLocalGitImpl({
        repoPath,
        prNumber,
        headSha: sha,
        hqRoot,
        execFileImpl,
        logger,
      });
    } catch (err) {
      return { ...base, reason: 'commit-read-failed', detail: err?.message || String(err), sha };
    }
    if (!commit) {
      return { ...base, reason: 'commit-unavailable-locally', sha };
    }
  }
  try {
    const ancestor = await runGitPredicate(execFileImpl, checkoutDir, [
      'merge-base', '--is-ancestor', '--end-of-options', reviewed, current,
    ]);
    if (!ancestor) {
      return { ...base, reason: 'reviewed-head-not-ancestor' };
    }
    const emptyDiff = await runGitPredicate(execFileImpl, checkoutDir, [
      'diff', '--quiet', '--exit-code', '--end-of-options', reviewed, current,
    ]);
    if (!emptyDiff) {
      return { ...base, reason: 'non-empty-delta' };
    }
    const countOut = await runGitOutput(execFileImpl, checkoutDir, [
      'rev-list', '--count', '--end-of-options', `${reviewed}..${current}`,
    ]);
    const commitCount = Number.parseInt(countOut.trim(), 10);
    if (!Number.isInteger(commitCount) || commitCount <= 0) {
      return { ...base, reason: 'no-commits-after-reviewed-head', detail: countOut.trim() };
    }
    return { ...base, verified: true, reason: 'empty-delta', commitCount, checkoutDir };
  } catch (err) {
    return { ...base, reason: 'git-error', detail: err?.message || String(err) };
  }
}

// Decide, once per tick, what an FSR-06B row is owed.
//   requested: the row carries the armed marker.
//   honored:   the request is verified against local git AND names the head
//              this tick is processing — the only state that lifts budget /
//              ceiling gates.
//   stale:     the head moved again after the request; ordinary policy applies
//              and the row is NOT declined (a moved head owes its own review).
export async function resolveFleetSelfRepairTrailerOnlyRereview({
  reviewRow = null,
  repoPath,
  prNumber,
  currentHeadSha,
  hqRoot = process.env.HQ_ROOT,
  execFileImpl = execFileAsync,
  verifyTrailerOnlyHeadDeltaImpl = verifyTrailerOnlyHeadDelta,
  logger = console,
} = {}) {
  if (!isFleetSelfRepairTrailerOnlyRereview(reviewRow)) {
    return { requested: false, honored: false, stale: false, reason: null };
  }
  const parsed = parseFleetSelfRepairTrailerOnlyRereviewReason(reviewRow.rereview_reason);
  const current = normalizeSha(currentHeadSha);
  const requestedLive = parsed.liveHeadSha
    || normalizeSha(reviewRow.revision_ref);
  const base = {
    requested: true,
    honored: false,
    stale: false,
    reviewedHeadSha: parsed.reviewedHeadSha,
    liveHeadSha: requestedLive,
    currentHeadSha: current,
  };
  if (!current) {
    return { ...base, reason: 'current-head-unknown' };
  }
  if (requestedLive && requestedLive !== current) {
    logger?.log?.(
      `[watcher] FSR-06B re-review request for ${repoPath}#${prNumber} is stale: ` +
        `requested live head ${requestedLive.slice(0, 12)} but current head is ` +
        `${current.slice(0, 12)}; ordinary review policy applies`
    );
    return { ...base, stale: true, reason: 'request-head-moved' };
  }
  if (!parsed.reviewedHeadSha) {
    return { ...base, reason: 'reviewed-head-missing-from-request' };
  }
  const verification = await verifyTrailerOnlyHeadDeltaImpl({
    repoPath,
    prNumber,
    reviewedHeadSha: parsed.reviewedHeadSha,
    currentHeadSha: current,
    hqRoot,
    execFileImpl,
    logger,
  });
  if (!verification.verified) {
    logger?.log?.(
      `[watcher] FSR-06B re-review request for ${repoPath}#${prNumber} NOT verified ` +
        `(${verification.reason}${verification.detail ? `: ${verification.detail}` : ''}); ` +
        `no budget/ceiling bypass — ordinary review policy applies`
    );
    return { ...base, reason: `unverified:${verification.reason}`, verification };
  }
  logger?.log?.(
    `[watcher] FSR-06B re-review request for ${repoPath}#${prNumber} verified: ` +
      `${parsed.reviewedHeadSha.slice(0, 12)} → ${current.slice(0, 12)} is an empty delta ` +
      `over ${verification.commitCount} commit(s); honoring past budget/ceiling gates`
  );
  return { ...base, honored: true, reason: 'verified-empty-delta', verification };
}

// Restore the FSR-06B row to `posted` and record why the watcher would not
// spawn. CAS on the armed marker so a row that moved on (claimed, re-armed by
// an operator, closed) is never clobbered. Returns { declined, changes }.
export function declineFleetSelfRepairTrailerOnlyRereview({
  db,
  repoPath,
  prNumber,
  reason,
  reviewedHeadSha = null,
  liveHeadSha = null,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  if (!db) throw new TypeError('declineFleetSelfRepairTrailerOnlyRereview requires db');
  const declinedReason = buildFleetSelfRepairRereviewDeclinedReason({
    reason,
    reviewedHeadSha,
    liveHeadSha,
  });
  const result = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'posted',
            posted_at = COALESCE(posted_at, ?),
            failed_at = NULL,
            failure_message = NULL,
            reviewer_lease_expires_at = NULL,
            reviewer_head_sha = COALESCE(NULLIF(reviewer_head_sha, ''), ?),
            rereview_requested_at = NULL,
            rereview_reason = ?
      WHERE repo = ?
        AND pr_number = ?
        AND pr_state = 'open'
        AND review_status = 'pending'
        AND rereview_requested_at IS NOT NULL
        AND LOWER(COALESCE(rereview_reason, '')) LIKE ?`
  ).run(
    now,
    normalizeSha(reviewedHeadSha),
    declinedReason,
    repoPath,
    prNumber,
    `${FLEET_SELF_REPAIR_TRAILER_ONLY_REREVIEW_MARKER.toLowerCase()}:%`,
  );
  const declined = result.changes === 1;
  if (declined) {
    logger?.warn?.(
      `[watcher] FSR-06B re-review request DECLINED for ${repoPath}#${prNumber}: ${reason}; ` +
        `restored review_status='posted' so the existing verdict stays with merge authority ` +
        `and the next fleet-self-repair sweep escalates instead of re-requesting`
    );
  } else {
    logger?.warn?.(
      `[watcher] FSR-06B decline for ${repoPath}#${prNumber} skipped by CAS (${reason}); ` +
        `row is no longer the armed fleet-self-repair request`
    );
  }
  return { declined, changes: result.changes, reason: declinedReason };
}
