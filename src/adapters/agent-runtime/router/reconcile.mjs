// Resume reconcile (v2 app architecture §6.3). Before the router dispatches
// anything on resume, it reconciles every idempotency key it may have handed to
// the OS before failover: query `dispatch_status`, and ADOPT any dispatch the
// endpoint still knows about instead of re-issuing it. The endpoint's
// `(app_id, request_id)` idempotency is the server-side backstop; this pass is
// the client-side guarantee that a known key is never re-dispatched.
//
// This module NEVER dispatches. Its only side effect is calling the injected
// `adopt(key, statusPayload)` for accepted-but-unobserved dispatches so the
// router re-observes them (re-poll / re-attach) rather than launching duplicates.

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

// A dispatch the endpoint no longer / never knew about — safe to (re)issue
// through the normal run path later. Everything else is "known" and adopted.
const UNKNOWN_STATUSES = new Set(['not_found', 'notfound', 'unknown', 'missing', 'none', '']);

function isKnownDispatch(statusPayload) {
  if (!statusPayload || typeof statusPayload !== 'object') return false;
  return !UNKNOWN_STATUSES.has(normalizeStatus(statusPayload.status));
}

function dedupeKeys(keys) {
  const seen = new Set();
  const ordered = [];
  for (const raw of keys || []) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

// Reconcile a set of candidate idempotency keys.
//   - `dispatchStatus(key)` → status payload (or throws on transport failure).
//   - `adopt(key, statusPayload)` → re-observe an accepted dispatch. Optional.
// Returns { adopted, notFound, unknown, adoptedCount, notFoundCount,
//           unknownCount, duplicatedCount } — `duplicatedCount` is 0 by
// construction, since a known key is adopted and never re-issued.
async function reconcileDispatches({ keys, dispatchStatus, adopt, logger = console } = {}) {
  if (typeof dispatchStatus !== 'function') {
    throw new TypeError('reconcileDispatches requires a dispatchStatus(key) function');
  }
  const adopted = [];
  const notFound = [];
  const unknown = [];

  await Promise.all(dedupeKeys(keys).map(async (key) => {
    let statusPayload;
    try {
      statusPayload = await dispatchStatus(key);
    } catch (err) {
      // Acceptance is unknowable. Do NOT re-issue — the durable active-run
      // record supersede (§6.3) covers the local-replacement case; re-issuing
      // here is the one thing that could duplicate work.
      unknown.push({ key, error: err?.message || String(err) });
      return;
    }
    if (isKnownDispatch(statusPayload)) {
      const status = normalizeStatus(statusPayload.status);
      if (typeof adopt === 'function') {
        try {
          await adopt(key, statusPayload);
        } catch (err) {
          logger?.warn?.('[router-reconcile] adopt callback failed; dispatch left as-is', {
            key,
            error: err?.message || String(err),
          });
        }
      }
      adopted.push({ key, status });
    } else {
      notFound.push({ key, status: normalizeStatus(statusPayload?.status) || 'not_found' });
    }
  }));

  return {
    adopted,
    notFound,
    unknown,
    adoptedCount: adopted.length,
    notFoundCount: notFound.length,
    unknownCount: unknown.length,
    duplicatedCount: 0,
  };
}

export {
  isKnownDispatch,
  normalizeStatus,
  reconcileDispatches,
};
