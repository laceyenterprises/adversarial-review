import { prepareQueueDepthSpillover } from './review-queue-depth.mjs';
import { compareReviewerDispatchCandidates, reviewerDispatchCandidateUsesGemini, runBoundedReviewerDispatchQueue } from './watcher-reviewer-pool.mjs';

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
  capacityFreedRetryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const drainOnce = async (reason) => {
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
      const eligible = candidates.filter(candidate => !candidate.admissionBlocked?.());
      const orderedCandidates = await prepareSpillover(eligible, { controller: firstPassSpilloverController, compareCandidates: compareReviewerDispatchCandidates });
      await Promise.all(orderedCandidates.slice(0, reviewerPoolConfig.maxConcurrent).map(candidate => candidate.prepareAdmission?.()));
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
      // Prepare the next bounded wave while the current reviewers use their
      // seats. This continuation owns no reviewer capacity and is observed.
      void Promise.allSettled(reviewerDispatchCandidates.filter(candidate => !candidate.admissionBlocked?.()).slice(0, reviewerPoolConfig.maxConcurrent)
        .map(candidate => candidate.prepareAdmission?.()));
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

  const shouldRetry = (result) => {
    if (result.dispatched !== 0 || result.maxObservedConcurrency !== 0 || !(result.deferred > 0)) return false;
    if (result.deferredReasons?.length !== result.deferred || !result.deferredReasons.every(
      row => row.reason === 'gemini-credential-concurrency-saturated'
    )) return false;
    // Missing liveness evidence is not proof of a freed credential. Include
    // inherited processes and pipeline reservations, even non-Gemini stages.
    if (typeof detachedReviewerDispatchTracker?.liveSpawnEntries !== 'function') return false;
    return !detachedReviewerDispatchTracker.liveSpawnEntries().some(reviewerDispatchCandidateUsesGemini);
  };

  return async (reason) => {
    let result = await drainOnce(reason);
    // A release from another watcher/runtime may become visible just after the
    // ordered handoff. Re-probe briefly under the admission mutex; never clear
    // reservations or relax the normal credential/process admission guards.
    for (let attempt = 1; reason === 'capacity-freed' && attempt <= 3 && shouldRetry(result); attempt++) {
      await capacityFreedRetryDelay(2000);
      logger.log(`[watcher] capacity-freed drain retried: attempt=${attempt}`);
      result = await drainOnce(reason);
    }
    return result;
  };
}
