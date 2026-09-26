// Claims are synchronous up to the first await in run(). The caller reserves
// each PR at that point, before the next preparation is started.
export async function drainRemediationJobs({ capacity, activeAtStart, shouldStop, run, onError }) {
  const inFlight = new Set();
  const results = [];
  let spawned = 0;
  let stopped = 0;
  let queueEmpty = false;
  const launch = () => {
    let task;
    task = run().then(result => ({ task, result }), err => ({ task, err }));
    inFlight.add(task);
  };
  while (inFlight.size > 0 || (!shouldStop() && activeAtStart + spawned < capacity)) {
    while (!queueEmpty && !shouldStop() && activeAtStart + spawned + inFlight.size < capacity) launch();
    if (inFlight.size === 0) break;
    const settled = await Promise.race(inFlight);
    inFlight.delete(settled.task);
    if (settled.err) {
      try {
        await onError(settled.err);
      } catch (err) {
        await Promise.all(inFlight);
        throw err;
      }
      continue;
    }
    const { result } = settled;
    results.push(result);
    if (result.consumed) spawned += 1;
    else if (result.reason === 'no-pending-jobs') queueEmpty = true;
    else if (result.job) stopped += 1;
    else queueEmpty = true;
  }
  return { results, spawned, stopped };
}
