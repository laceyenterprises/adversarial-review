// Shared "log once per key until its signature changes" gate.
//
// Several watcher/daemon paths re-log the SAME unchanged state on every poll:
// branch-protection warnings for the ~18 tracked repos, the AMA
// retained-ownership / auto-hammer-ineligible notes for a stuck PR, and the
// follow-up label-removal failures for a merged PR. These are LOG-ONLY lines
// (they never page via deliverAlert), so re-emitting them each tick only floods
// the operator's log feed without adding information.
//
// This gate emits on the FIRST occurrence for a key and on any STATE CHANGE
// (the signature for that key differs from the last one seen), and it suppresses
// unchanged repeats. It also tracks how many identical repeats were suppressed
// so a caller can surface a running count when the state finally changes -
// without per-poll spam. It NEVER changes caller behavior: it only decides
// whether a given log line is emitted on this tick.
export function createLogChangeGate() {
  const lastByKey = new Map();
  return {
    /**
     * Record an observation for `key` with an opaque `signature` describing the
     * current state. Returns { changed, count, suppressedSincePrevious }:
     *   - changed: true on the first observation for the key OR when the
     *     signature differs from the last observed signature. Callers log only
     *     when this is true.
     *   - count: number of consecutive observations of the CURRENT signature
     *     (1 on a change or first observation).
     *   - suppressedSincePrevious: how many identical observations were
     *     suppressed since the last time `changed` was true for this key (0 on
     *     the first observation).
     */
    note(key, signature) {
      const prev = lastByKey.get(key);
      if (!prev || prev.signature !== signature) {
        const suppressedSincePrevious = prev ? prev.count - 1 : 0;
        lastByKey.set(key, { signature, count: 1 });
        return { changed: true, count: 1, suppressedSincePrevious };
      }
      prev.count += 1;
      return { changed: false, count: prev.count, suppressedSincePrevious: 0 };
    },
    /** Forget a key (e.g. once the underlying PR/repo state resolves). */
    forget(key) {
      lastByKey.delete(key);
    },
    /** Clear all tracked state. */
    reset() {
      lastByKey.clear();
    },
    /** Number of distinct keys currently tracked (introspection for tests). */
    size() {
      return lastByKey.size;
    },
  };
}
