// Process-lifetime admission queue. Polling discovers work; settlement hands
// capacity straight to the same guarded drain without waiting for a poll.
export function createReviewerAdmissionQueue({ candidates = [], logger = console, now = Date.now, schedule = setImmediate } = {}) {
  let drainImpl = async () => ({ dispatched: 0 });
  let tail = Promise.resolve();
  let capacityEvent = null;
  const identity = candidate => `${candidate.repoPath}#${candidate.prNumber}`;

  function enqueue(candidate) {
    // Resolve admission at the actual spawn boundary, independently of the
    // review's long-lived completion promise. Refusals resolve on return.
    let admitted = false;
    let resolveAdmission;
    candidate.admissionOutcome = new Promise(resolve => { resolveAdmission = resolve; });
    candidate.markAdmissionStarted = () => {
      admitted = true;
      resolveAdmission({ dispatched: true, at: now() });
    };
    const run = candidate.run;
    candidate.run = async function () {
      try {
        return await run.call(this);
      } finally {
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
    const result = tail.then(() => drainImpl(reason));
    tail = result.catch(() => {});
    return result;
  }

  function capacityFreed() {
    if (capacityEvent) return;
    const event = { freedAt: now() };
    capacityEvent = event;
    // Let the candidate's finally and the detached tracker's finally both
    // clear their reservations before sampling capacity. Never await this
    // from candidate.run(): its drain may still own the admission mutex.
    schedule(() => {
      capacityEvent = null;
      void drain('capacity-freed').then(async result => {
        const outcomes = await Promise.all(result?.admissions || []);
        const dispatched = outcomes.filter(outcome => outcome?.dispatched);
        const count = outcomes.length ? dispatched.length : result?.dispatched || 0;
        const admittedAt = dispatched.length ? Math.min(...dispatched.map(outcome => outcome.at)) : now();
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
  };
}
