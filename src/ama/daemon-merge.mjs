import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import { buildAllowlistedGhEnv } from '../gh-cli.mjs';
import { fetchPullRequestHeadAndState } from '../github-api.mjs';
import { appendAmaAuditAttempt, writeAmaAuditEntry } from './audit.mjs';
import { evaluateMergeEligibility } from './merge-eligibility.mjs';
import { acquireMergeLease, releaseMergeLease } from './merge-lease.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_MERGE_TIMEOUT_MS = 120_000;
const DEFAULT_MERGE_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000]);
const PERMANENT_PATTERNS = [
  /\bhead\s+(?:commit\s+)?(?:does not match|mismatch|changed|is not)\b/i,
  /\bmatch-head-commit\b/i,
  /\b(branch protection|protected branch|ruleset|required status check|required check)\b/i,
  /\b(permission denied|authentication failed|not authorized|forbidden|resource not accessible by integration)\b/i,
  /\b(pull request is not mergeable|merge conflict|cannot be merged|blocked|dirty|behind)\b/i,
  /\b(pull request.*(?:closed|merged)|already merged|state.*closed)\b/i,
];
const TRANSIENT_PATTERNS = [
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b/i,
  /\b(TLS handshake|socket hang up|network timeout|request timeout|i\/o timeout)\b/i,
  /\bHTTP\s+(?:429|5\d\d)\b/i,
  /\b(rate limit|secondary rate limit|too many requests|retry-after|temporarily unavailable)\b/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err) {
  return String(err?.stderr || err?.stdout || err?.message || err || '').trim();
}

function retryAfterMs(err) {
  const text = errText(err);
  const match = text.match(/\bretry-after\s*:?\s*(\d+)\b/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function classifyMergeFailure(err) {
  const text = errText(err);
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { transient: false, reason: 'permanent-merge-failure', detail: text };
  }
  if (
    err?.killed === true ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(String(err?.code || '')) ||
    TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { transient: true, reason: 'transient-merge-failure', detail: text };
  }
  return { transient: false, reason: 'permanent-merge-failure', detail: text };
}

function boundedDelay(baseDelayMs, attempt, random = Math.random) {
  const jitter = Math.floor(Number(baseDelayMs) * 0.2 * random());
  return Math.max(0, Number(baseDelayMs) + jitter + (attempt * 25));
}

function isFullyCleanStrictReview(reviewState) {
  return (
    Number(reviewState?.blockingFindingCount) === 0 &&
    Number(reviewState?.nonBlockingFindingCount) === 0
  );
}

function mergeEligibilityState({ reviewState, prMetadata, leaseHeld }) {
  return {
    verdict: reviewState?.verdict,
    requiredChecks: prMetadata?.statusCheckRollup,
    mergeable: prMetadata?.mergeableState,
    mergeStateStatus: prMetadata?.mergeStateStatus,
    prState: prMetadata?.isOpen === false ? 'CLOSED' : 'OPEN',
    candidateHead: prMetadata?.headSha,
    validatedHead: reviewState?.headSha,
    leaseHeld,
  };
}

function daemonAuditAttempt({ outcome, reason, eligibility, detail, attempts }) {
  return {
    outcome,
    authority: 'daemon-merge',
    reason,
    eligibilityReasons: Array.isArray(eligibility?.reasons) ? eligibility.reasons : [],
    mergeAttempts: attempts,
    ...(detail ? { detail: String(detail).slice(0, 1000) } : {}),
  };
}

async function runGhPrMerge({
  repo,
  prNumber,
  headSha,
  execFileImpl,
  env,
  timeoutMs,
}) {
  return execFileImpl('gh', [
    'pr',
    'merge',
    String(prNumber),
    '--repo',
    repo,
    '--squash',
    '--match-head-commit',
    headSha,
  ], {
    env: buildAllowlistedGhEnv(env),
    maxBuffer: DEFAULT_MERGE_MAX_BUFFER,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
}

export async function maybeDaemonMergeCleanReview({
  rootDir,
  repo,
  prNumber,
  reviewState,
  prMetadata,
  cfg,
  env = process.env,
  execFileImpl = execFileAsync,
  fetchHeadAndStateImpl = fetchPullRequestHeadAndState,
  acquireMergeLeaseImpl = acquireMergeLease,
  releaseMergeLeaseImpl = releaseMergeLease,
  writeAmaAuditEntryImpl = writeAmaAuditEntry,
  appendAmaAuditAttemptImpl = appendAmaAuditAttempt,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  mergeTimeoutMs = DEFAULT_MERGE_TIMEOUT_MS,
  random = Math.random,
  logger = console,
} = {}) {
  if (!cfg?.enabled) return { handled: false, reason: 'ama-disabled' };
  if (!isFullyCleanStrictReview(reviewState)) {
    // TODO(MSM-05): read the strict-mode flag when landed; until then strict
    // daemon merging is hard-gated on zero blocking AND zero non-blocking findings.
    return { handled: false, reason: 'findings-present' };
  }

  const base = String(prMetadata?.baseBranch || '').trim();
  const headSha = String(prMetadata?.headSha || '').trim();
  if (!rootDir || !repo || !base || !headSha) {
    return { handled: false, reason: 'daemon-merge-metadata-missing' };
  }

  const pre = evaluateMergeEligibility(mergeEligibilityState({ reviewState, prMetadata, leaseHeld: true }));
  if (!pre.eligible) {
    return { handled: true, merged: false, reason: 'not-eligible', reasons: pre.reasons };
  }

  const acquired = acquireMergeLeaseImpl({
    rootDir,
    repo,
    base,
    holderPr: prNumber,
    holderHead: headSha,
    holderPid: process.pid,
    holderHost: hostname(),
    registerWaiter: false,
  });
  if (!acquired?.acquired) {
    return { handled: true, merged: false, reason: 'merge-lease-contended', lease: acquired?.existingLease || acquired?.lease || null };
  }

  const lease = acquired.lease;
  const auditIdentity = { hqRoot: rootDir, repo, prNumber, headSha };
  let auditWritten = false;
  const appendFinalAudit = (attempt) => {
    if (!auditWritten) {
      auditWritten = true;
      return writeAmaAuditEntryImpl({
        ...auditIdentity,
        metadata: { authority: 'daemon-merge' },
        attempt,
      });
    }
    return appendAmaAuditAttemptImpl({ ...auditIdentity, attempt });
  };

  let mergeAttempts = 0;
  try {
    const eligibility = evaluateMergeEligibility(mergeEligibilityState({ reviewState, prMetadata, leaseHeld: true }));
    if (!eligibility.eligible) {
      appendFinalAudit(daemonAuditAttempt({
        outcome: 'deferred',
        reason: 'not-eligible',
        eligibility,
        attempts: mergeAttempts,
      }));
      return { handled: true, merged: false, reason: 'not-eligible', reasons: eligibility.reasons };
    }

    let lastFailure = null;
    const maxAttempts = retryDelaysMs.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const live = await fetchHeadAndStateImpl(repo, prNumber, { execFileImpl, withLabels: false, env });
      const liveHead = String(live?.headRefOid || live?.headSha || '').trim();
      const liveState = String(live?.state || '').toUpperCase();
      if (liveHead !== headSha) {
        appendFinalAudit(daemonAuditAttempt({
          outcome: 'deferred',
          reason: 'stale-head',
          eligibility,
          attempts: mergeAttempts,
          detail: `live head ${liveHead || 'unknown'} did not match ${headSha}`,
        }));
        return { handled: true, merged: false, reason: 'stale-head', liveHead };
      }
      if (liveState && liveState !== 'OPEN') {
        appendFinalAudit(daemonAuditAttempt({
          outcome: 'deferred',
          reason: 'pr-not-open',
          eligibility,
          attempts: mergeAttempts,
          detail: `live state ${liveState}`,
        }));
        return { handled: true, merged: false, reason: 'pr-not-open', liveState };
      }

      mergeAttempts += 1;
      try {
        await runGhPrMerge({ repo, prNumber, headSha, execFileImpl, env, timeoutMs: mergeTimeoutMs });
        appendFinalAudit(daemonAuditAttempt({
          outcome: 'succeeded',
          reason: 'daemon-merge',
          eligibility,
          attempts: mergeAttempts,
        }));
        logger?.log?.(`[watcher] daemon merged clean AMA PR ${repo}#${prNumber}@${headSha}`);
        return { handled: true, merged: true, reason: 'daemon-merge', attempts: mergeAttempts };
      } catch (err) {
        const classified = classifyMergeFailure(err);
        lastFailure = { err, classified };
        if (!classified.transient || attempt >= retryDelaysMs.length) break;
        await sleep(boundedDelay(retryAfterMs(err) ?? retryDelaysMs[attempt], attempt, random));
      }
    }

    const finalReason = lastFailure?.classified?.reason || 'merge-failed';
    appendFinalAudit(daemonAuditAttempt({
      outcome: 'failed-without-merge',
      reason: finalReason,
      eligibility,
      attempts: mergeAttempts,
      detail: lastFailure?.classified?.detail,
    }));
    return {
      handled: true,
      merged: false,
      reason: finalReason,
      transient: Boolean(lastFailure?.classified?.transient),
      attempts: mergeAttempts,
    };
  } finally {
    releaseMergeLeaseImpl({
      rootDir,
      repo,
      base,
      leaseId: lease.leaseId,
      holderPr: lease.holderPr,
      holderHead: lease.holderHead,
      acquiredAt: lease.acquiredAt,
    });
  }
}

export const __testables__ = Object.freeze({
  classifyMergeFailure,
  isFullyCleanStrictReview,
  mergeEligibilityState,
});
