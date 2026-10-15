import { prepareQueueDepthSpillover } from './review-queue-depth.mjs';
import { compareReviewerDispatchCandidates, runBoundedReviewerDispatchQueue } from './watcher-reviewer-pool.mjs';

// Both poll and settlement admissions call this drain under the same mutex.
// Keep capacity, ordering and reservation settlement in one implementation.
export function createReviewerDispatchDrain({
  reviewerPoolConfig, reviewerDispatchCandidates, firstPassSpilloverController,
  detachedReviewerDispatchTracker, readWatcherDrainState,
  resolveGeminiCredentialConcurrencyForDispatchCandidates,
  singleWaveSettleGraceMs, splitPostReviewSettlement,
  logger = console,
  prepareSpillover = prepareQueueDepthSpillover,
  runQueue = runBoundedReviewerDispatchQueue,
}) {
  return async (reason) => {
    if (readWatcherDrainState().active || !reviewerPoolConfig.enabled || reviewerDispatchCandidates.length === 0) {
      return { dispatched: 0, maxObservedConcurrency: 0 };
    }
    // Keep waiting candidates visible to discovery's in-place FIFO refresh
    // while capacity probes, spillover and the launch wave await. Only a
    // started snapshot leaves the queue; a refreshed snapshot stays eligible.
    const candidates = [...reviewerDispatchCandidates];
    const startedCandidates = new Set();
    const startedAt = process.hrtime.bigint();
    logger.log(
      `[watcher] Draining ${candidates.length} reviewer dispatch candidate(s) before ${reason}`
    );
    try {
      // Unknown broker capacity uses the pool's conservative single-Gemini cap.
      const geminiCredentialConcurrency =
        await resolveGeminiCredentialConcurrencyForDispatchCandidates(candidates);
      const orderedCandidates = await prepareSpillover(candidates, { controller: firstPassSpilloverController, compareCandidates: compareReviewerDispatchCandidates });
      const drainResult = await runQueue(orderedCandidates, {
        maxConcurrent: reviewerPoolConfig.maxConcurrent,
        geminiCredentialConcurrency,
        activeReviewerCounts: detachedReviewerDispatchTracker.activeCounts(),
        usePersistentReviewerLaneState: true,
        singleWave: true,
        singleWaveSettleGraceMs,
        splitPostReviewSettlement,
        onCandidateStarted: (started) => {
          startedCandidates.add(started.candidate);
          const index = reviewerDispatchCandidates.indexOf(started.candidate);
          if (index >= 0) reviewerDispatchCandidates.splice(index, 1);
          detachedReviewerDispatchTracker.track(started);
        },
        logger,
      });
      if (drainResult.deferred > 0) {
        logger.log(
          `[watcher] reviewer dispatch drain yielded after one launch wave: ` +
          `dispatched=${drainResult.dispatched} deferred=${drainResult.deferred} ` +
          `max_observed_concurrency=${drainResult.maxObservedConcurrency}` +
          (drainResult.deferredReasonSummary ? ` deferred_reasons=${drainResult.deferredReasonSummary}` : '')
        );
      }
      return { ...drainResult, admissions: [...startedCandidates].map(candidate => candidate.admissionOutcome) };
    } finally {
      // Also settle reservations when the drain throws before returning its
      // deferred list. Started candidates own their spawn/refusal settlement.
      for (const candidate of candidates) {
        if (!startedCandidates.has(candidate)) {
          candidate.retainWakeForCapacity?.();
          candidate.refundDepthSpill?.();
        }
      }
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (elapsedMs >= 30_000) {
        logger.warn(
          `[watcher] reviewer dispatch drain exceeded SLA: ` +
          `elapsed_ms=${Math.round(elapsedMs)} candidates=${candidates.length} reason="${reason}"`
        );
      }
    }
  };
}
