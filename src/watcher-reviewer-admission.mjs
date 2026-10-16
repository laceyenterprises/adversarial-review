// Process-lifetime admission queue. Polling discovers work; settlement hands
// capacity straight to the same guarded drain without waiting for a poll.
export function createReviewerAdmissionQueue({ candidates = [], logger = console, now = Date.now, schedule = setImmediate } = {}) {
  let drainImpl = async () => ({ dispatched: 0 });
  let tail = Promise.resolve();
  let capacityEvent = null;
  const postedByModel = new Map();
  let refill = null;
  let onSettled = null;
  const identity = candidate => `${candidate.repoPath}#${candidate.prNumber}`;

  function enqueue(candidate) {
    candidate.onAdmissionReady = capacityFreed;
    // Resolve admission at the actual spawn boundary, independently of the
    // review's long-lived completion promise. Refusals resolve on return.
    let admitted = false;
    let resolveAdmission;
    candidate.admissionOutcome = new Promise(resolve => { resolveAdmission = resolve; });
    candidate.markAdmissionStarted = () => {
      if (admitted) return;
      admitted = true;
      const at = now();
      resolveAdmission({ dispatched: true, at });
    };
    let spawned = false;
    candidate.markReviewerSpawned = () => {
      if (spawned) return;
      spawned = true;
      const postedAt = postedByModel.get(candidate.reviewerModel);
      if (Number.isFinite(postedAt)) {
        logger.log?.(`[watcher] reviewer seat handoff: model=${candidate.reviewerModel} post_to_spawn_ms=${Math.max(0, now() - postedAt)}`);
        postedByModel.delete(candidate.reviewerModel);
      }
    };
    const run = candidate.run;
    candidate.run = async function () {
      const observeSettlement = () => {
        try { onSettled?.(candidate); }
        catch (error) { logger.error?.('[watcher] reviewer settlement snapshot failed:', error?.message || error); }
      };
      const release = this.admissionReleaseCapacity;
      if (release) this.admissionReleaseCapacity = (...args) => {
        observeSettlement();
        return release(...args);
      };
      try {
        return await run.call(this);
      } finally {
        // Split capacity release can precede the final durable state. Always
        // refresh the snapshot when the continuation finishes or throws.
        observeSettlement();
        if (!admitted) resolveAdmission({ dispatched: false, at: now() });
      }
    };
    const key = identity(candidate);
    const index = candidates.findIndex(queued => identity(queued) === key);
    // Refresh discovery snapshots in place without changing FIFO position.
    // In-flight ownership stays with the existing head lease and claim CAS;
    // a new head (or a recovered expired claim) must remain eligible to queue.
    if (index >= 0) {
      candidates[index].refundDepthSpill?.();
      candidates[index] = candidate;
    } else {
      candidates.push(candidate);
    }
  }

  function drain(reason) {
    const result = tail.then(async () => {
      const initial = await drainImpl(reason);
      if (reason !== 'capacity-freed' || (initial?.dispatched > 0 || initial?.admissions?.length > 0) || !refill) return initial;
      // Refill and re-drain share the poll/settlement mutex. Candidate preflight
      // still runs only after the ordinary pool has reserved capacity.
      const found = await refill(candidates);
      for (const candidate of found) enqueue(candidate);
      const refilled = found.length ? await drainImpl(reason) : initial;
      return { ...refilled, refillFound: found.length };
    });
    tail = result.catch(() => {});
    return result;
  }

  function capacityFreed({ candidate } = {}) {
    if (Number.isFinite(candidate?.durablePostedAt)) {
      postedByModel.set(candidate.reviewerModel, candidate.durablePostedAt);
    }
    if (capacityEvent) return;
    const event = { freedAt: now() };
    capacityEvent = event;
    // Callers have already released capacity. Scheduling coalesces signals;
    // correctness does not depend on a later event-loop turn. Never await
    // this from candidate.run(): its drain may still own the admission mutex.
    schedule(() => {
      capacityEvent = null;
      void drain('capacity-freed').then(async result => {
        const outcomes = await Promise.all(result?.admissions || []);
        const dispatched = outcomes.filter(outcome => outcome?.dispatched);
        const count = outcomes.length ? dispatched.length : result?.dispatched || 0;
        const admittedAt = dispatched.length ? Math.min(...dispatched.map(outcome => outcome.at)) : now();
        if (result?.refillFound !== undefined) {
          logger.log?.(`[watcher] reviewer admission refill: candidates=${result.refillFound} admitted=${count} idle_ms=${Math.max(0, admittedAt - event.freedAt)}`);
        }
        if (count > 0) {
          logger.log?.(`[watcher] reviewer admission on capacity-freed: dispatched=${count} idle_ms=${Math.max(0, admittedAt - event.freedAt)}`);
        }
      }).catch(error => {
        logger.error?.('[watcher] reviewer admission on capacity-freed failed:', error?.message || error);
      });
    });
  }

  return {
    candidates, enqueue, drain, capacityFreed,
    setDrain(impl) { drainImpl = impl; },
    setRefill(impl, settled) { refill = impl; onSettled = settled; },
  };
}
