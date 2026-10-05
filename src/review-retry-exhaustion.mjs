import { writeFileAtomic } from './atomic-write.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeFireOperatorDecisionRequiredAlert,
  recordNoProgressLaneRun,
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
    const path = decisionPath(rootDir, repo, prNumber, headSha);
    let decision = readReviewFailureDecision(rootDir, repo, prNumber, headSha);
    if (!decision) {
      decision = { id: `review-failure-${createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex').slice(0, 20)}`,
        repo, prNumber, headSha, reason, status: 'pending',
        question: `Review failed for ${repo}#${prNumber}@${headSha}. How should this head proceed?`,
        options: ['retrigger after a fix', 'accept partial review', 'block'], recommended: 'retrigger after a fix',
        createdAt: new Date().toISOString() };
      mkdirSync(join(rootDir, 'data', 'review-failure-decisions'), { recursive: true });
      try { writeFileAtomic(path, JSON.stringify(decision, null, 2), { overwrite: false }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; decision = readReviewFailureDecision(rootDir, repo, prNumber, headSha); }
    }
    const identity = { repo, prNumber };
    const fingerprint = 'review-retry-cap-exhausted:durable-decision-v1';
    recordNoProgressLaneRun(rootDir, identity, {
      headSha, fingerprint, decisionFingerprint: fingerprint,
      progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
      operatorReason: 'review-retry-cap-exhausted',
      now: new Date().toISOString(), logger,
    });
    const paged = await maybeFireOperatorDecisionRequiredAlert({
      rootDir, identity, headSha, fingerprint,
      operatorReason: 'review-retry-cap-exhausted',
      noProgressTicks: 1, thresholdTicks: 1,
      deliverAlertFn: typeof deliverAlertFn === 'function' ? (text, event) => deliverAlertFn(
        `${text} Decision ${decision.id}: ${decision.question} Options: ${decision.options.join(' / ')}.`,
        { ...event, payload: { ...event.payload, decisionId: decision.id, decision } }) : null, logger,
    });
    if (paged) logger.warn(`[watcher] Review retry cap exhausted for ${repo}#${prNumber}: ${reason}; awaiting operator decision`);
    return paged;
  } catch (error) {
    logger.warn?.(`[watcher] Review exhaustion park failed for ${repo}#${prNumber}: ${error?.message || error}`);
    return false;
  }
}
