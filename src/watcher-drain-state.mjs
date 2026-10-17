import { readFileSync, statSync } from 'node:fs';

// Keep unreadable/corrupt markers fail closed within their bounded lifetime.
export function readWatcherDrainMarker({
  drainFile,
  now = new Date(),
  drainMaxMs,
} = {}) {
  let raw;
  let markerMtimeMs;
  try {
    raw = readFileSync(drainFile, 'utf8');
    markerMtimeMs = statSync(drainFile).mtimeMs;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { active: false };
    }
    return {
      active: true,
      reason: `unreadable drain marker at ${drainFile}: ${err?.message || err}`,
    };
  }

  const nowMs = now.getTime();
  const maxExpiresAt = markerMtimeMs + drainMaxMs;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    if (nowMs >= maxExpiresAt) {
      return { active: false, expired: true };
    }
    return {
      active: true,
      reason: `invalid drain marker at ${drainFile}: ${err?.message || err}`,
    };
  }

  const parsedExpiresAt = payload?.expiresAt ? Date.parse(payload.expiresAt) : NaN;
  const hasValidExpiresAt = Number.isFinite(parsedExpiresAt);
  const effectiveExpiresAt = hasValidExpiresAt
    ? Math.min(parsedExpiresAt, maxExpiresAt)
    : maxExpiresAt;
  if (nowMs >= effectiveExpiresAt) {
    return { active: false, expired: true };
  }

  return {
    active: true,
    reason: hasValidExpiresAt
      ? String(payload?.reason || 'watcher drain active')
      : `drain marker missing/invalid expiresAt at ${drainFile}`,
    requestedBy: payload?.requestedBy ? String(payload.requestedBy) : null,
    expiresAt: hasValidExpiresAt ? String(payload.expiresAt) : null,
  };
}
