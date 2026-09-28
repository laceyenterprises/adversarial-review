import { beginReviewerPass, recordReviewerPassProgress } from './reviewer-pass-tokens.mjs';

export function createReviewerProgressRecorder({ rootDir, repo, prNumber, attemptNumber, passKind,
  reviewerSessionUuid, log = console }) {
  let lastWriteMs = 0;
  return ({ changedLines, effort }) => {
    const observedMs = Date.now();
    if (observedMs - lastWriteMs < 30_000) return;
    try {
      if (recordReviewerPassProgress(rootDir, { repo, prNumber, attemptNumber, passKind,
        reviewerSessionUuid, changedLines, effort })) {
        lastWriteMs = observedMs;
        log.error?.('[reviewer] reviewer stream progress');
      }
    } catch (err) {
      log.error?.(`[reviewer] progress write failed: ${err?.message || err}`);
    }
  };
}

// The reviewer CLI learns the resolved harness model only after dispatch.
// Persist it on the watcher's running pass before best-effort GitHub body capture.
export function persistHostedReviewerExecution({
  rootDir, repo, prNumber, reviewDbAttemptNumber, reviewAttemptNumber,
  reviewerClass, passKind, headSha, execution, log = console,
}) {
  if (!execution?.model) return false;
  try {
    beginReviewerPass(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number.isFinite(Number(reviewDbAttemptNumber))
        ? Number(reviewDbAttemptNumber)
        : Number(reviewAttemptNumber),
      reviewerClass,
      reviewerModel: execution.model,
      reasoningEffort: execution.effort || null,
      passKind,
      headSha: headSha || null,
      metadata: { reviewerExecution: execution },
    });
    return true;
  } catch (err) {
    log.warn(`[reviewer] reviewer execution pass write failed for ${repo}#${prNumber}: ${err?.message || err}`);
    return false;
  }
}
