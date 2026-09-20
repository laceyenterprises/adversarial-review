const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 512;

function positiveTtl(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_MS;
}

function positiveMaxEntries(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ENTRIES;
}

function emit(emitEvent, event, detail = {}) {
  emitEvent?.({ event, at: new Date().toISOString(), ...detail });
}

export function reviewContextCacheKey({ repo, prNumber, headSha, baseSha, reviewerProfile }) {
  const fields = [repo, prNumber, headSha, baseSha, reviewerProfile].map((value) => String(value || '').trim());
  if (fields.some((value) => !value)) {
    throw new TypeError('review context cache key requires repo, prNumber, headSha, baseSha, and reviewerProfile');
  }
  return JSON.stringify(fields);
}

export function createHotPathCache({
  name,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  nowFn = Date.now,
  emitEvent = null,
} = {}) {
  const cacheName = String(name || 'hot-path');
  const ttl = positiveTtl(ttlMs);
  const limit = positiveMaxEntries(maxEntries);
  const entries = new Map();

  function prune(now = nowFn()) {
    for (const [entryKey, entry] of entries) {
      if (now < entry.expiresAt) break;
      entries.delete(entryKey);
    }
    while (entries.size > limit) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  }

  async function get(key, load, detail = {}) {
    const normalizedKey = String(key);
    const now = nowFn();
    const cached = entries.get(normalizedKey);
    if (cached && now < cached.expiresAt) {
      emit(emitEvent, 'cache_hit', { cache: cacheName, key: normalizedKey, ...detail, ageMs: now - cached.writtenAt, savedMs: cached.loadMs });
      return cached.value;
    }
    if (cached) {
      entries.delete(normalizedKey);
      emit(emitEvent, 'cache_stale', { cache: cacheName, key: normalizedKey, ageMs: now - cached.writtenAt, ...detail });
    } else {
      emit(emitEvent, 'cache_miss', { cache: cacheName, key: normalizedKey, ...detail });
    }
    const loadStartedAt = nowFn();
    const value = await load();
    // Failed/unknown probes must remain live. Only cache successful values.
    if (value !== undefined && value !== null && value?.available !== false && value?.cacheable !== false) {
      const writtenAt = nowFn();
      entries.set(normalizedKey, { value, writtenAt, expiresAt: writtenAt + ttl, loadMs: Math.max(0, writtenAt - loadStartedAt) });
      prune(writtenAt);
    }
    return value;
  }

  function invalidate({ key = null, reason = 'explicit' } = {}) {
    const removed = key === null ? entries.size : Number(entries.delete(String(key)));
    if (key === null) entries.clear();
    emit(emitEvent, 'cache_invalidated', { cache: cacheName, key: key === null ? null : String(key), reason, removed });
    return removed;
  }

  return Object.freeze({ get, invalidate, size: () => entries.size, ttlMs: ttl, maxEntries: limit });
}

export function invalidationReasonForGrounding(previous, next) {
  const providers = new Set([
    ...Object.keys(previous?.providers || {}),
    ...Object.keys(next?.providers || {}),
  ]);
  for (const provider of providers) {
    const before = previous?.providers?.[provider] || {};
    const after = next?.providers?.[provider] || {};
    if (Boolean(before.hardGrounded) !== Boolean(after.hardGrounded)) return 'hard-grounding';
    if (Boolean(before.softGrounded) !== Boolean(after.softGrounded)) return 'soft-grounding';
  }
  return null;
}

export { DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS };
