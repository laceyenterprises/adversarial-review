import { writeFileAtomic } from './atomic-write.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeFireOperatorDecisionRequiredAlert,
  recordNoProgressLaneRun,
  readNoProgressLane,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
} from './watcher-no-progress-lane.mjs';

function decisionPath(rootDir, repo, prNumber, headSha) {
  const id = createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex');
  return join(rootDir, 'data', 'review-failure-decisions', `${id}.json`);
}

export function readReviewFailureDecision(rootDir, repo, prNumber, headSha) {
  try { return JSON.parse(readFileSync(decisionPath(rootDir, repo, prNumber, headSha), 'utf8')); }
  catch { return null; }
}

export async function parkExhaustedReview({
  rootDir, repo, prNumber, headSha, reason, deliverAlertFn, logger = console,
}) {
  try {
    const identity = { repo, prNumber };
    // Keep the legacy fingerprint so deploying durable records does not re-page
    // heads whose existing lane debounce is still authoritative.
    const fingerprint = 'review-retry-cap-exhausted';
    const lane = readNoProgressLane(rootDir, identity, { logger });
    const existing = readReviewFailureDecision(rootDir, repo, prNumber, headSha);
    const sameSeries = lane?.headSha === headSha && lane?.fingerprint === fingerprint
      && lane?.decisionFingerprint === fingerprint;
    const now = new Date().toISOString();
    let decision = {
      id: `review-failure-${createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex').slice(0, 20)}`,
      repo, prNumber, headSha, reason, kind: 'informational',
      seriesId: sameSeries && existing?.seriesId ? existing.seriesId : randomUUID(),
      createdAt: existing?.createdAt || now, updatedAt: now,
    };
    let persisted = false;
    try {
      const path = decisionPath(rootDir, repo, prNumber, headSha);
      mkdirSync(join(rootDir, 'data', 'review-failure-decisions'), { recursive: true });
      try {
        writeFileAtomic(path, JSON.stringify(decision, null, 2), { overwrite: Boolean(existing) });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A concurrent first writer owns this head's initial series identity.
        const winner = readReviewFailureDecision(rootDir, repo, prNumber, headSha);
        if (!winner?.id || !winner?.seriesId) throw new Error('unreadable concurrent failure record');
        decision = winner;
      }
      persisted = true;
    } catch (error) {
      logger.warn?.(`[watcher] Review failure record persistence failed for ${repo}#${prNumber}: ${error?.message || error}`);
    }
    recordNoProgressLaneRun(rootDir, identity, {
      headSha, fingerprint, decisionFingerprint: fingerprint,
      progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
      operatorReason: 'review-retry-cap-exhausted',
      now, logger,
    });
    const paged = await maybeFireOperatorDecisionRequiredAlert({
      rootDir, identity, headSha, fingerprint,
      operatorReason: 'review-retry-cap-exhausted',
      noProgressTicks: 1, thresholdTicks: 1,
      deliverAlertFn: typeof deliverAlertFn === 'function' ? (text, event) => deliverAlertFn(
        `${text} Failure record ${decision.id}: ${reason}. This record is informational; use the existing operator controls to retrigger, approve risk, or block.`,
        { ...event, payload: { ...event.payload, decisionId: decision.id, decisionSeriesId: persisted ? decision.seriesId : null, decision } }) : null, logger,
    });
    if (paged) logger.warn(`[watcher] Review retry cap exhausted for ${repo}#${prNumber}: ${reason}; awaiting operator decision`);
    return paged;
  } catch (error) {
    logger.warn?.(`[watcher] Review exhaustion park failed for ${repo}#${prNumber}: ${error?.message || error}`);
    return false;
  }
}
