import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfigCached } from './config-loader.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from './review-verdict.mjs';
import { HANDOFF_EVENTS, recordHandoffEvent } from './handoff-telemetry.mjs';
import { stmtGetReviewRow } from './review-state-db.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveFinalToHammerHandoffEnabled({
  loadConfigImpl = loadConfigCached,
  logger = console,
} = {}) {
  try {
    return loadConfigImpl().get('handoff.final_to_hammer', false) === true;
  } catch (err) {
    logger?.warn?.(
      `[watcher] handoff.final_to_hammer config load failed; keeping inline final hammer disabled: ${err?.message || err}`
    );
    return false;
  }
}

export function shouldInlineFinalHammerAfterReview({
  handoffFinalToHammerEnabled = false,
  passKind = null,
  result = null,
  completedRemediationRounds = 0,
  maxRemediationRounds = 0,
} = {}) {
  if (handoffFinalToHammerEnabled !== true) return false;
  if (passKind !== 'rereview') return false;
  if (!result?.ok) return false;
  if (normalizeReviewVerdict(extractReviewVerdict(result.reviewBody || '') || '') !== 'request-changes') return false;
  const completed = Number(completedRemediationRounds);
  const maxRounds = Number(maxRemediationRounds);
  return Number.isFinite(completed) &&
    Number.isFinite(maxRounds) &&
    maxRounds >= 0 &&
    completed >= maxRounds;
}

export async function maybeInlineFinalHammerAfterReview({
  rootDir = ROOT,
  repoPath,
  prNumber,
  result,
  passKind,
  completedRemediationRounds,
  maxRemediationRounds,
  subjectRef = null,
  currentRevisionRef = null,
  labelNames = [],
  projectGateStatusSafe,
  execFileImpl = execFileAsync,
  operatorSurface = null,
  logger = console,
  handoffFinalToHammerEnabled = resolveFinalToHammerHandoffEnabled({ logger }),
  getReviewRowImpl = (repo, pr) => stmtGetReviewRow.get(repo, pr),
  handlePostedReviewRowImpl,
  recordHandoffEventImpl = recordHandoffEvent,
} = {}) {
  if (!shouldInlineFinalHammerAfterReview({
    handoffFinalToHammerEnabled,
    passKind,
    result,
    completedRemediationRounds,
    maxRemediationRounds,
  })) {
    return { handled: false, reason: 'not-inline-final-hammer' };
  }
  const postedRow = getReviewRowImpl(repoPath, prNumber);
  logger?.log?.(
    `[watcher] HOM-04 inline final hammer handoff for ${repoPath}#${prNumber}: ` +
      `final re-review posted Request changes after ` +
      `${completedRemediationRounds}/${maxRemediationRounds} remediation rounds`
  );
  try {
    await handlePostedReviewRowImpl({
      rootDir,
      repoPath,
      prNumber,
      existing: postedRow,
      subjectRef,
      currentRevisionRef,
      labelNames,
      projectGateStatusSafe,
      execFileImpl,
      operatorSurface,
      logger,
    });
  } catch (err) {
    logger?.error?.(
      `[watcher] HOM-04 inline final hammer handoff failed for ${repoPath}#${prNumber}; ` +
        `posted-review recovery will retry on a later poll: ${err?.message || err}`
    );
    return { handled: false, reason: 'inline-final-hammer-failed', error: err };
  }
  try {
    const now = new Date().toISOString();
    recordHandoffEventImpl({
      rootDir,
      event: HANDOFF_EVENTS.fired,
      at: now,
      step: 'final-to-hammer',
      repo: repoPath,
      prNumber,
      headSha: currentRevisionRef || subjectRef || null,
      target: 'hammer',
    });
    recordHandoffEventImpl({
      rootDir,
      event: HANDOFF_EVENTS.latency,
      at: now,
      step: 'final-to-hammer',
      repo: repoPath,
      prNumber,
      headSha: currentRevisionRef || subjectRef || null,
      target: 'hammer',
      latencySeconds: 0.1,
    });
  } catch {
    // Telemetry must never affect the merge-authority guard path.
  }
  return { handled: true, reason: 'inline-final-hammer' };
}
