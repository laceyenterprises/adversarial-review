import {
  maybeFireOperatorDecisionRequiredAlert,
  recordNoProgressLaneRun,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
} from './watcher-no-progress-lane.mjs';

export async function parkExhaustedReview({
  rootDir, repo, prNumber, headSha, reason, deliverAlertFn, logger = console,
}) {
  try {
    const identity = { repo, prNumber };
    const fingerprint = 'review-retry-cap-exhausted';
    recordNoProgressLaneRun(rootDir, identity, {
      headSha, fingerprint, decisionFingerprint: fingerprint,
      progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
      operatorReason: 'review-retry-cap-exhausted',
      now: new Date().toISOString(), logger,
    });
    const paged = await maybeFireOperatorDecisionRequiredAlert({
      rootDir, identity, headSha, fingerprint,
      operatorReason: 'review-retry-cap-exhausted',
      noProgressTicks: 1, thresholdTicks: 1, deliverAlertFn, logger,
    });
    if (paged) logger.warn(`[watcher] Review retry cap exhausted for ${repo}#${prNumber}: ${reason}; awaiting operator decision`);
    return paged;
  } catch (error) {
    logger.warn?.(`[watcher] Review exhaustion park failed for ${repo}#${prNumber}: ${error?.message || error}`);
    return false;
  }
}
