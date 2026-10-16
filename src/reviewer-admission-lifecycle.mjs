// PR ownership and credential capacity have different lifetimes: a completed
// review can hand the credential to another PR while its inline hammer settles.
const handoffs = new Map();
const keyFor = (repo, pr) => `${repo}#${pr}`;
export function reviewerHandoffPending(repo, pr) { return handoffs.has(keyFor(repo, pr)); }
export async function waitForReviewerHandoff(repo, pr) {
  await handoffs.get(keyFor(repo, pr));
}
export function startReviewerHandoff(repo, pr, run) {
  const key = keyFor(repo, pr);
  const previous = handoffs.get(key);
  const promise = Promise.resolve(previous).then(run);
  handoffs.set(key, promise);
  void promise.finally(() => {
    if (handoffs.get(key) === promise) handoffs.delete(key);
  }).catch(() => {});
  // Observe immediately; the runtime may still be doing slow accounting before
  // the watcher awaits this handoff. Preserve rejection for that caller.
  promise.catch(() => {});
  return promise;
}

