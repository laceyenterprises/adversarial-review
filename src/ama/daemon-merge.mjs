/**
 * MSM-03 — daemon clean-path merge ("Path B").
 *
 * Operator intent (agent-os #3123): *"Hammer will almost always be needed
 * because the final review will almost always carry findings. In a world where
 * it's completely clean, the daemon clicks the button; otherwise it's hammer all
 * the way."* A fully-clean, green, mergeable settled PR does not need a
 * remediation agent — clicking merge is a deterministic GitHub API call, so the
 * watcher daemon performs it inline. Anything with a finding routes to the
 * hammer (MSM-04); this module never spawns an agent.
 *
 * Hard invariants (mirrors the module doc of `merge-eligibility.mjs`):
 *
 *   - **No local CI.** The daemon has no local environment and must NEVER run a
 *     local test battery — that was the original merge-agent state machine's
 *     fatal flaw. The daemon trusts GitHub's required checks + `mergeable` for
 *     the zero-findings case. Both the daemon and the hammer now trust GitHub's
 *     required checks as the sole CI authority (MSM-01); the hammer additionally
 *     remediates findings and rebases before merge, but it too runs no local
 *     test battery. This module reads GitHub state and calls `gh pr merge`; it
 *     has no local-CI seam and injects none.
 *   - **Clean-only by default (STRICT).** With strict mode on, the daemon is
 *     never allowed to merge a PR that carries ANY finding — blocking OR
 *     non-blocking — in the final review. Any finding (or an unknown finding
 *     classification) declines the daemon path so the caller routes to the
 *     hammer. When strict mode is explicitly off, the daemon may merge over
 *     known non-blocking findings only; blocking or unknown finding state still
 *     declines.
 *   - **Eligibility is the shared MSM-02 predicate.** The daemon reuses
 *     `evaluateMergeEligibility` so the hammer and daemon cannot drift apart on
 *     "may this PR merge right now?".
 *
 * Retry semantics are shared with the MSM-01 hammer merge loop
 * (`templates/hammer-prompt.md`): transient `gh`/GitHub failures (transport
 * reset, TLS handshake timeout, DNS/socket timeout, OS-level spawn/resource
 * errors, HTTP 5xx, rate-limit / secondary-rate-limit) retry with bounded
 * exponential backoff + jitter under the same lease, and the live head is
 * re-read before every attempt. A fresh read with no candidate head is treated
 * like a transient gate-read failure; the daemon never substitutes the earlier
 * validated head for that missing live data. Non-transient failures (head
 * mismatch, merge rejection, permission/auth failure, branch-protection/ruleset
 * failure, already-merged/closed, unmergeable state, required-check failure)
 * fail closed immediately with no retry. Exhausted retries write a non-merged
 * `daemon-merge` audit and release the lease. No path here spawns a hammer.
 *
 * @module ama/daemon-merge
 */

import {
  appendAmaAuditAttempt,
  readAmaAuditEntry,
  writeAmaAuditEntry,
} from './audit.mjs';
import { evaluateMergeEligibility } from './merge-eligibility.mjs';

/** Bounded-retry defaults, byte-for-byte the MSM-01 hammer merge budget. */
export const DAEMON_MERGE_DEFAULTS = Object.freeze({
  // Independent daemon merge retry budget. Hammer dispatch lifetime ceilings
  // must not change clean-path merge retries.
  retryCap: 2,
  // HAM_MERGE_BACKOFF_BASE_SECONDS default, in ms.
  backoffBaseMs: 2000,
  // Hammer jitter is `int(rand()*3)` seconds → 0/1/2 s.
  jitterSteps: 3,
});

export const DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS = 30_000;

const DAEMON_MERGE_DIAGNOSTIC_MAX_CHARS = 4_000;

/**
 * Marker recorded on every daemon-written audit doc + attempt so the audit is
 * distinguishable from the hammer's (`Closed-By: hammer`) audit for the same
 * `(repo, pr, head)` tuple.
 */
export const DAEMON_MERGE_CLOSURE_AUTHORITY = 'daemon-merge';

/**
 * Terminal `failed-without-merge` reasons that are PERMANENT for this validated
 * head — a subsequent tick must not re-take the daemon path and re-loop. A
 * transient budget exhaustion (`merge-retry-budget-exhausted`) is NOT in this
 * set: the next tick may re-attempt with a fresh lease.
 */
const PERMANENT_TERMINAL_REASONS = Object.freeze([
  'stale-head',
  'gate-not-eligible',
  'permanent-merge-rejection',
  'unclassified-merge-failure',
]);

/**
 * Disposition vocabulary returned to the watcher.
 *
 *   - `merged`       — the daemon merged; a `succeeded` audit was written and
 *                      the lease released. Caller skips closer + merge-agent.
 *   - `failed-closed`— the daemon took the path but failed closed (permanent
 *                      rejection or exhausted transient budget); a non-merged
 *                      audit was written and the lease released. Caller skips —
 *                      NO hammer is spawned from this path.
 *   - `deferred`     — the daemon did not take authority this tick (lease held
 *                      by another principal, or audit bootstrap failed). Caller
 *                      skips this tick and retries next tick. No double-merge.
 *   - `not-taken`    — the daemon declined (findings present/unknown, ineligible
 *                      GitHub state, or a prior permanent terminal failure on
 *                      this head). Caller falls through to the existing closer /
 *                      hammer dispatch path.
 */
export const DAEMON_MERGE_DISPOSITION = Object.freeze({
  MERGED: 'merged',
  FAILED_CLOSED: 'failed-closed',
  DEFERRED: 'deferred',
  NOT_TAKEN: 'not-taken',
});

/**
 * Is this settled review FULLY CLEAN — zero blocking AND zero non-blocking
 * findings, both classifications KNOWN? Fails closed on any unknown finding
 * state (a review whose finding classification is unavailable is NOT clean).
 *
 * @param {object} [reviewState]
 * @param {number=} reviewState.blockingFindingCount
 * @param {string=} reviewState.blockingFindingState     'known' | 'unknown'
 * @param {number=} reviewState.nonBlockingFindingCount
 * @param {string=} reviewState.nonBlockingFindingState  'known' | 'unknown'
 * @returns {boolean}
 */
export function isFullyCleanSettledReview(reviewState = {}) {
  const blockingState = String(reviewState.blockingFindingState || '').trim().toLowerCase();
  const nonBlockingState = String(reviewState.nonBlockingFindingState || '').trim().toLowerCase();
  if (blockingState !== 'known' || nonBlockingState !== 'known') return false;
  const blockingCount = normalizeFindingCount(reviewState.blockingFindingCount);
  const nonBlockingCount = normalizeFindingCount(reviewState.nonBlockingFindingCount);
  if (blockingCount === null || nonBlockingCount === null) return false;
  return blockingCount === 0 && nonBlockingCount === 0;
}

export function isDaemonMergeReviewAllowed(reviewState = {}, { strictMode = true } = {}) {
  const blockingState = String(reviewState.blockingFindingState || '').trim().toLowerCase();
  const nonBlockingState = String(reviewState.nonBlockingFindingState || '').trim().toLowerCase();
  if (blockingState !== 'known' || nonBlockingState !== 'known') return false;
  const blockingCount = normalizeFindingCount(reviewState.blockingFindingCount);
  const nonBlockingCount = normalizeFindingCount(reviewState.nonBlockingFindingCount);
  if (blockingCount === null || nonBlockingCount === null) return false;
  if (blockingCount !== 0) return false;
  if (strictMode !== false && nonBlockingCount !== 0) return false;
  return true;
}

/**
 * The precise reason a review is NOT daemon-clean, for surfacing to the caller.
 * `null` when the review IS fully clean.
 */
function uncleanReason(reviewState = {}, { strictMode = true } = {}) {
  const blockingState = String(reviewState.blockingFindingState || '').trim().toLowerCase();
  const nonBlockingState = String(reviewState.nonBlockingFindingState || '').trim().toLowerCase();
  if (blockingState !== 'known' || nonBlockingState !== 'known') return 'findings-unknown';
  const blockingCount = normalizeFindingCount(reviewState.blockingFindingCount);
  const nonBlockingCount = normalizeFindingCount(reviewState.nonBlockingFindingCount);
  if (blockingCount === null || nonBlockingCount === null) return 'findings-unknown';
  if (blockingCount !== 0) return 'blocking-findings-present';
  if (strictMode !== false && nonBlockingCount !== 0) return 'non-blocking-findings-present';
  return null;
}

function normalizeFindingCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Classify a `gh pr merge` (or live-gate read) failure, mirroring the MSM-01
 * hammer classifier order EXACTLY: already-merged wins first, then permanent,
 * then retryable; anything unmatched is `unclassified` (fail closed, no retry).
 *
 * @param {string} text  Combined stderr/stdout / error message.
 * @returns {'already-merged'|'permanent'|'retryable'|'unclassified'}
 */
export function classifyDaemonMergeError(text) {
  const haystack = String(text || '');
  // ham_merge_error_already_merged
  if (/already merged/i.test(haystack)) return 'already-merged';
  // ham_merge_error_retryable: throttling must win before generic HTTP 403.
  if (/rate limit|secondary rate limit|Retry-After/i.test(haystack)) return 'retryable';
  // ham_merge_error_permanent
  if (
    /match-head-commit|head.*(mismatch|changed|does not match)|not authorized|permission|authentication|forbidden|HTTP 401|HTTP 403|branch protection|ruleset|required check|status checks? (not|have not)|not mergeable|merge conflict|pull request.*closed|closed pull request|pr is closed|state:?\s*closed|pull request.*not open|draft/i.test(
      haystack,
    )
  ) {
    return 'permanent';
  }
  // ham_merge_error_retryable
  if (
    /connection (?:reset|closed)|ECONNRESET|TLS handshake timeout|timeout|timed out|ETIMEDOUT|DNS|ENOTFOUND|EAI_AGAIN|EIO|Input\/output error|EAGAIN|resource temporarily unavailable|socket|HTTP 5[0-9][0-9]|502|503|504|temporar(y|ily)|try again|service unavailable|gateway/i.test(
      haystack,
    )
  ) {
    return 'retryable';
  }
  return 'unclassified';
}

/**
 * Bounded exponential backoff + jitter, mirroring the hammer loop:
 * `HAM_MERGE_BACKOFF_BASE_SECONDS * 2^(attempt-1) + int(rand()*3)` seconds.
 *
 * @param {number} attempt   1-based attempt number.
 * @param {object} [opts]
 * @param {number} [opts.baseMs]
 * @param {number} [opts.jitterSteps]
 * @param {() => number} [opts.rng]
 * @returns {number} delay in ms.
 */
export function daemonMergeBackoffMs(
  attempt,
  { baseMs = DAEMON_MERGE_DEFAULTS.backoffBaseMs, jitterSteps = DAEMON_MERGE_DEFAULTS.jitterSteps, rng = Math.random } = {},
) {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  const jitterMs = Math.floor(rng() * Math.max(1, jitterSteps)) * 1000;
  return baseMs * multiplier + jitterMs;
}

function normalizeGateState(live = {}) {
  return {
    candidateHead: String(live.candidateHead ?? live.headSha ?? live.headRefOid ?? '').trim(),
    requiredChecks: Array.isArray(live.requiredChecks)
      ? live.requiredChecks
      : Array.isArray(live.statusCheckRollup)
        ? live.statusCheckRollup
        : live.requiredChecks,
    mergeable: live.mergeable,
    mergeStateStatus: live.mergeStateStatus,
    prState: String(live.prState ?? live.state ?? '').trim().toUpperCase(),
    merged: Boolean(live.merged) || String(live.prState ?? live.state ?? '').toUpperCase() === 'MERGED',
  };
}

function truncateDaemonMergeDiagnostic(value) {
  const text = String(value || '');
  if (text.length <= DAEMON_MERGE_DIAGNOSTIC_MAX_CHARS) return text;
  return `${text.slice(0, DAEMON_MERGE_DIAGNOSTIC_MAX_CHARS)}...[truncated]`;
}

function daemonMergeDiagnostics(mergeRes) {
  return {
    stderr: truncateDaemonMergeDiagnostic(mergeRes?.stderr),
    stdout: truncateDaemonMergeDiagnostic(mergeRes?.stdout),
  };
}

/**
 * Read the prior audit for this exact `(repo, pr, validatedHead)` and report
 * whether the daemon already recorded a PERMANENT terminal failure on it. Fails
 * open (returns false) on any read error — the guard only ever DECLINES, so a
 * false negative just means one more bounded attempt, never an unsafe merge.
 */
function priorDaemonPermanentFailure({ readAuditImpl, hqRoot, repo, prNumber, validatedHead }) {
  let doc;
  try {
    doc = readAuditImpl(hqRoot, repo, prNumber, validatedHead);
  } catch {
    return false;
  }
  if (!doc || String(doc.status || '').toLowerCase() !== 'failed-without-merge') return false;
  if (String(doc.closureAuthority || '') !== DAEMON_MERGE_CLOSURE_AUTHORITY) return false;
  const attempts = Array.isArray(doc.attempts) ? doc.attempts : [];
  const last = attempts[attempts.length - 1];
  return Boolean(last && PERMANENT_TERMINAL_REASONS.includes(String(last.reason || '')));
}

/**
 * Attempt the daemon clean-path merge for a fully-clean, settled-success PR.
 *
 * The orchestration is fully dependency-injected so it is deterministic and
 * unit-testable without a live GitHub, filesystem lease, or clock. See
 * {@link DAEMON_MERGE_DISPOSITION} for the returned `disposition` contract.
 *
 * @param {object} args
 * @param {string} args.repo             `<owner>/<name>`.
 * @param {number} args.prNumber
 * @param {string} args.base             Base branch (the lease key's base).
 * @param {string} args.validatedHead    Reviewed / validated head SHA.
 * @param {string} args.verdict          Normalized eligibility verdict token
 *                                       (must be `settled-success` to clear the
 *                                       verdict gate).
 * @param {object} args.reviewState      Finding counts/states (clean gate input).
 * @param {object} args.liveGate         Initial fetched GitHub gate snapshot.
 * @param {string} [args.mergeMethod]    `squash` (default) | `merge`.
 * @param {string} args.hqRoot          HQ root for the audit doc.
 * @param {object} [args.auditMetadata] Extra top-level audit fields (reviewer, risk).
 *
 * Injected collaborators (all required for the merge path; defaulted for audit):
 * @param {() => Promise<object>} args.fetchLiveGateImpl  Re-read live head+gate.
 * @param {() => (object|Promise<object>)} args.acquireLeaseImpl  `{ acquired, lease, existingLease }`.
 * @param {(lease: object) => any} args.releaseLeaseImpl
 * @param {(ctx: object) => Promise<{exitCode:number, stdout?:string, stderr?:string}>} args.runMergeImpl
 * @param {Function} [args.evaluateEligibilityImpl]
 * @param {Function} [args.writeAuditImpl]
 * @param {Function} [args.appendAuditImpl]
 * @param {Function} [args.readAuditImpl]
 * @param {() => string} [args.now]
 * @param {(ms:number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.rng]
 * @param {object} [args.logger]
 * @param {number} [args.retryCap]
 * @param {number} [args.backoffBaseMs]
 * @returns {Promise<object>} `{ disposition, reason, merged, attempts, leaseAcquired, auditWritten, reasons }`.
 */
export async function attemptDaemonCleanMerge({
  repo,
  prNumber,
  base,
  validatedHead,
  verdict,
  reviewState = {},
  liveGate = {},
  mergeMethod = 'squash',
  hqRoot,
  auditMetadata = {},
  flags = {},
  strictMode = flags.strictMode ?? true,
  allowHamTerminalRemediation = false,
  fetchLiveGateImpl,
  acquireLeaseImpl,
  releaseLeaseImpl,
  runMergeImpl,
  evaluateEligibilityImpl = evaluateMergeEligibility,
  writeAuditImpl = writeAmaAuditEntry,
  appendAuditImpl = appendAmaAuditAttempt,
  readAuditImpl = readAmaAuditEntry,
  now = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rng = Math.random,
  logger = console,
  retryCap = DAEMON_MERGE_DEFAULTS.retryCap,
  backoffBaseMs = DAEMON_MERGE_DEFAULTS.backoffBaseMs,
} = {}) {
  const notTaken = (reason, extra = {}) => ({
    disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
    reason,
    merged: false,
    attempts: 0,
    leaseAcquired: false,
    auditWritten: false,
    ...extra,
  });

  // ── Gate 1: STRICT clean-only. Any finding (or unknown classification) routes
  // to the hammer. When strict mode is explicitly off, known non-blocking
  // findings may stay on the daemon path. No hammer is spawned here — the caller
  // falls through. ───────────────────────────────────────────────────────────
  const hamTerminalVerdict = String(verdict || '').trim().toLowerCase() === 'ham_terminal_remediation_validated';
  if (
    !(allowHamTerminalRemediation === true && hamTerminalVerdict) &&
    !isDaemonMergeReviewAllowed(reviewState, { strictMode })
  ) {
    return notTaken(uncleanReason(reviewState, { strictMode }) || 'findings-unknown');
  }

  // ── Gate 2: substantive eligibility (verdict + green CI + mergeable +
  // head-match) via the shared MSM-02 predicate. Evaluated BEFORE spending a
  // lease acquisition; `leaseHeld:true` isolates the non-lease gates. ─────────
  const preLease = normalizeGateState(liveGate);
  const preEligibility = evaluateEligibilityImpl({
    verdict,
    leaseHeld: true,
    requiredChecks: preLease.requiredChecks,
    mergeable: preLease.mergeable,
    mergeStateStatus: preLease.mergeStateStatus,
    prState: preLease.prState,
    candidateHead: preLease.candidateHead,
    validatedHead,
  });
  if (!preEligibility.eligible) {
    return notTaken('not-eligible', { reasons: preEligibility.reasons });
  }

  // ── Gate 3: don't re-loop a head that already failed permanently. ──────────
  if (priorDaemonPermanentFailure({ readAuditImpl, hqRoot, repo, prNumber, validatedHead })) {
    return notTaken('prior-daemon-terminal-failure');
  }

  // ── Acquire the merge lease for the head. Contention defers cleanly. ───────
  let leaseResult;
  try {
    leaseResult = await acquireLeaseImpl({ repo, base, prNumber, head: validatedHead });
  } catch (err) {
    logger?.warn?.(
      `[daemon-merge] lease acquisition error for ${repo}#${prNumber}@${validatedHead}: ${err?.message || err}`,
    );
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'lease-acquire-error',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
    };
  }
  if (!leaseResult?.acquired) {
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'lease-contended',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
      existingLease: leaseResult?.existingLease || leaseResult?.lease || null,
    };
  }
  const lease = leaseResult.lease || leaseResult;

  // Everything past here holds the lease — release it on every exit path.
  const releaseLease = () => {
    try {
      releaseLeaseImpl(lease);
    } catch (err) {
      logger?.warn?.(
        `[daemon-merge] lease release failed for ${repo}#${prNumber}@${validatedHead}: ${err?.message || err}`,
      );
    }
  };

  try {
  // ── Bootstrap the daemon-merge audit doc (in_progress). If we can't even
  // record intent, don't merge — release and defer. ─────────────────────────
  const auditKeys = { hqRoot, repo, prNumber, headSha: validatedHead };
  const flagState = {
    autonomousMergeExecutionEnabled: flags.autonomousMergeExecutionEnabled !== false,
    strictMode: strictMode !== false,
  };
  const closureAuthority = auditMetadata.closureAuthority || DAEMON_MERGE_CLOSURE_AUTHORITY;
  const auditMetadataDoc = {
    ...auditMetadata,
    closureAuthority,
    flagState,
  };
  try {
    writeAuditImpl({
      ...auditKeys,
      attempt: {
        outcome: 'in_progress',
        path: closureAuthority,
        attemptPhase: 'daemon-pre-merge',
        validatedHead,
        mergeMethod,
        preMergeReasons: [],
        eligibilityReasons: [],
        flagState,
      },
      metadata: auditMetadataDoc,
      now: now(),
    });
  } catch (err) {
    logger?.warn?.(
      `[daemon-merge] audit bootstrap failed for ${repo}#${prNumber}@${validatedHead}; not merging: ${err?.message || err}`,
    );
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'audit-init-failed',
      merged: false,
      attempts: 0,
      leaseAcquired: true,
      auditWritten: false,
    };
  }

  // ── Bounded merge loop under the held lease. ───────────────────────────────
  let attempts = 0;
  let merged = false;
  let terminal = null; // { reason, permanent, reasons }

  while (attempts < retryCap && !merged && !terminal) {
    attempts += 1;

    // Re-read the LIVE head/gate before every attempt (retry included).
    let live;
    try {
      live = normalizeGateState(await fetchLiveGateImpl());
    } catch {
      // A gate read failure is transient by construction here (the network read
      // itself failed). Retry within the bounded budget; exhausting it is a
      // fail-closed, non-permanent terminal (next tick may re-attempt).
      if (attempts >= retryCap) {
        terminal = { reason: 'gate-read-failed', permanent: false };
        break;
      }
      await sleep(daemonMergeBackoffMs(attempts, { baseMs: backoffBaseMs, rng }));
      continue;
    }

    // Already merged at the validated head → success (idempotent re-entry).
    if (live.merged && live.candidateHead === validatedHead) {
      merged = true;
      break;
    }
    // MISSING head ≠ MOVED head — the two branches below must stay distinct.
    // An empty candidateHead means the read itself was incomplete (GraphQL
    // field blip, partial gh output): we know nothing new about the PR, so it
    // is a TRANSIENT retry within the bounded budget, and we must never
    // substitute the earlier validatedHead for the missing live value — that
    // would let a merge proceed on a head nobody just observed. Exhaustion is
    // fail-closed but NON-permanent ('gate-read-failed'): the next tick may
    // re-attempt with fresh reads.
    if (!live.candidateHead) {
      if (attempts >= retryCap) {
        terminal = { reason: 'gate-read-failed', permanent: false };
        break;
      }
      await sleep(daemonMergeBackoffMs(attempts, { baseMs: backoffBaseMs, rng }));
      continue;
    }
    // Live head moved off the validated head → permanent for this head.
    // This is POSITIVE evidence of head movement (someone pushed), which
    // invalidates the review the merge authority rests on — no retry can fix
    // it for THIS validatedHead. 'stale-head' is in PERMANENT_TERMINAL_REASONS
    // so later ticks skip the daemon path for this head (Gate 3); the new head
    // gets its own review/audit/lease lifecycle.
    if (live.candidateHead !== validatedHead) {
      terminal = { reason: 'stale-head', permanent: true };
      break;
    }
    // Re-verify the full gate on the fresh read (CI could have gone red, the PR
    // could have been closed, mergeable could have flipped).
    const elig = evaluateEligibilityImpl({
      verdict,
      leaseHeld: true,
      requiredChecks: live.requiredChecks,
      mergeable: live.mergeable,
      mergeStateStatus: live.mergeStateStatus,
      prState: live.prState,
      candidateHead: live.candidateHead,
      validatedHead,
    });
    if (!elig.eligible) {
      terminal = { reason: 'gate-not-eligible', permanent: true, reasons: elig.reasons };
      break;
    }

    // Click the button.
    let mergeRes;
    try {
      mergeRes = await runMergeImpl({ repo, prNumber, head: validatedHead, mergeMethod, base });
    } catch (err) {
      mergeRes = { exitCode: 1, stdout: '', stderr: String(err?.stderr || err?.message || err) };
    }
    if (Number(mergeRes?.exitCode) === 0) {
      merged = true;
      break;
    }
    const cls = classifyDaemonMergeError(`${mergeRes?.stderr || ''}\n${mergeRes?.stdout || ''}`);
    if (cls === 'already-merged') {
      merged = true;
      break;
    }
    if (cls === 'permanent') {
      terminal = {
        reason: 'permanent-merge-rejection',
        permanent: true,
        mergeDiagnostics: daemonMergeDiagnostics(mergeRes),
      };
      break;
    }
    if (cls === 'unclassified') {
      terminal = {
        reason: 'unclassified-merge-failure',
        permanent: true,
        mergeDiagnostics: daemonMergeDiagnostics(mergeRes),
      };
      break;
    }
    // Retryable: back off within the bounded budget, then re-read + re-attempt.
    if (attempts >= retryCap) {
      terminal = {
        reason: 'merge-retry-budget-exhausted',
        permanent: false,
        mergeDiagnostics: daemonMergeDiagnostics(mergeRes),
      };
      break;
    }
    logger?.log?.(
      `[daemon-merge] transient gh pr merge failure for ${repo}#${prNumber}@${validatedHead}; ` +
        `retrying ${attempts}/${retryCap}`,
    );
    await sleep(daemonMergeBackoffMs(attempts, { baseMs: backoffBaseMs, rng }));
  }

  if (!merged && !terminal) {
    // Defensive: loop fell through without a decision (retryCap === 0, etc.).
    terminal = { reason: 'merge-retry-budget-exhausted', permanent: false };
  }

  // ── Finalize: append the terminal audit before the outer lease release. ────
  // LAC-1559 Fix 2: a fail-closed daemon path is by construction a FULLY-CLEAN
  // (zero-finding) settled review that could not be landed and has NO hammer
  // fallback (the retry path never hammers). Mark that terminal park as an
  // operator-visible "manual close required" signal so the superproject
  // observability layer (ARR-02) can page on it instead of it being a silent
  // failed-without-merge. This does NOT change the merge decision.
  const cleanParkManualCloseRequired = !merged && isFullyCleanSettledReview(reviewState);
  let auditWritten = false;
  try {
    if (merged) {
      appendAuditImpl({
        ...auditKeys,
        attempt: {
          outcome: 'succeeded',
          path: closureAuthority,
          attemptPhase: 'daemon-merged',
          reason: 'merged',
          validatedHead,
          mergeMethod,
          attempts,
          eligibilityReasons: [],
          flagState,
        },
        now: now(),
      });
    } else {
      appendAuditImpl({
        ...auditKeys,
        attempt: {
          outcome: 'failed-without-merge',
          path: closureAuthority,
          attemptPhase: 'daemon-failed',
          reason: terminal.reason,
          permanent: Boolean(terminal.permanent),
          ...(terminal.reasons ? { preMergeReasons: terminal.reasons } : {}),
          eligibilityReasons: terminal.reasons || [],
          flagState,
          ...(terminal.mergeDiagnostics ? { mergeDiagnostics: terminal.mergeDiagnostics } : {}),
          ...(cleanParkManualCloseRequired
            ? { manualCloseRequired: true, operatorAction: 'clean-pr-parked-manual-close-required' }
            : {}),
          validatedHead,
          mergeMethod,
          attempts,
        },
        now: now(),
      });
    }
    auditWritten = true;
  } catch (err) {
    logger?.warn?.(
      `[daemon-merge] terminal audit append failed for ${repo}#${prNumber}@${validatedHead}: ${err?.message || err}`,
    );
  }

  if (merged) {
    logger?.log?.(
      `[daemon-merge] merged ${repo}#${prNumber}@${validatedHead} inline after ${attempts} attempt(s)`,
    );
    return {
      disposition: DAEMON_MERGE_DISPOSITION.MERGED,
      reason: 'merged',
      merged: true,
      attempts,
      leaseAcquired: true,
      auditWritten,
    };
  }
  logger?.warn?.(
    `[daemon-merge] fail-closed for ${repo}#${prNumber}@${validatedHead}: ${terminal.reason} ` +
      // Name the exact eligibility gate(s) behind a generic `gate-not-eligible`
      // (e.g. ci-not-green) so the operator log is self-diagnosing.
      (Array.isArray(terminal.reasons) && terminal.reasons.length ? `gates=${terminal.reasons.join(',')} ` : '') +
      `(after ${attempts} attempt(s); no hammer spawned` +
      (cleanParkManualCloseRequired ? '; clean PR parked — manual close required' : '') +
      ')' +
      (terminal.mergeDiagnostics
        ? ` stderr=${JSON.stringify(terminal.mergeDiagnostics.stderr)} stdout=${JSON.stringify(terminal.mergeDiagnostics.stdout)}`
        : ''),
  );
  return {
    disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
    reason: terminal.reason,
    merged: false,
    attempts,
    leaseAcquired: true,
    auditWritten,
    manualCloseRequired: cleanParkManualCloseRequired,
    ...(terminal.reasons ? { reasons: terminal.reasons } : {}),
  };
  } finally {
    releaseLease();
  }
}

// Internal helpers exposed for unit tests.
export const __testables__ = Object.freeze({
  uncleanReason,
  normalizeFindingCount,
  normalizeGateState,
  priorDaemonPermanentFailure,
  truncateDaemonMergeDiagnostic,
  PERMANENT_TERMINAL_REASONS,
});
