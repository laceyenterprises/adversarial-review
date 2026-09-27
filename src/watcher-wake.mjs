import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createHandoffRateLimiter, normalizeHandoffMaxPerPrHead } from './handoff-rate-cap.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { recordHandoffWakeEvents } from './handoff-telemetry.mjs';

const WATCHER_WAKE_FILE = 'watcher-wake.json';
const WATCHER_WAKE_CONSUMED_FILE = 'watcher-wake-consumed.json';
const DEFAULT_WAKE_POLL_MS = 1000;

function watcherWakePath(rootDir) {
  return join(rootDir, 'data', WATCHER_WAKE_FILE);
}

function watcherWakeConsumedPath(rootDir) {
  return join(rootDir, 'data', WATCHER_WAKE_CONSUMED_FILE);
}

function readWakeSnapshot(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    try {
      const payload = JSON.parse(raw);
      const requestId = String(payload?.request_id || '').trim();
      if (requestId) return { key: `request_id:${requestId}`, payload };
      return {
        key: `content:${createHash('sha256').update(raw).digest('hex')}`,
        payload,
      };
    } catch {
      return {
        key: `content:${createHash('sha256').update(raw).digest('hex')}`,
        payload: null,
      };
    }
  } catch {
    return null;
  }
}

// Bound the carried list so a wedged watcher cannot grow the wake file without
// limit. Oldest subjects are dropped first; they are the ones most likely to
// have already been picked up by an ordinary poll.
const MAX_PENDING_WAKE_SUBJECTS = 64;

// Subjects from before watcher startup expire at this boundary. Subjects
// requested during a running watcher stay eligible until it consumes the wake,
// even if a poll lasts longer than the TTL.
const DEFAULT_WAKE_SUBJECT_TTL_MS = 30 * 60 * 1000;

function wakeSubjectTtlMs(env = process.env) {
  const raw = Number(env?.ADVERSARIAL_WATCHER_WAKE_SUBJECT_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WAKE_SUBJECT_TTL_MS;
}

function wakeSubjectKeyParts({ repo, prNumber, headSha = null, requestedAt = null }) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPr = normalizeWakePrNumber(prNumber);
  if (!normalizedRepo || normalizedPr === null) return null;
  const normalizedHead = String(headSha || '').trim();
  const normalizedRequestedAt = String(requestedAt || '').trim();
  return {
    repo: normalizedRepo,
    pr_number: normalizedPr,
    ...(normalizedHead ? { head_sha: normalizedHead } : {}),
    ...(normalizedRequestedAt ? { requested_at: normalizedRequestedAt } : {}),
  };
}

function wakeSubjectKey(subject) {
  return `${subject.repo}#${subject.pr_number}@${subject.head_sha || ''}`;
}

function dedupeWakeSubjects(subjects) {
  // Keep the LAST occurrence of each subject so a re-wake refreshes its
  // request time (and its position) instead of keeping the stale first one.
  const byKey = new Map();
  for (const subject of subjects) {
    if (!subject) continue;
    const key = wakeSubjectKey(subject);
    byKey.delete(key);
    byKey.set(key, subject);
  }
  return [...byKey.values()];
}

function wakeSubjectIsFresh(subject, nowMs, ttlMs) {
  const requestedMs = Date.parse(subject?.requested_at || '');
  if (!Number.isFinite(requestedMs)) return false;
  return nowMs - requestedMs <= ttlMs;
}

function carriedWakeSubjects(filePath, consumedPath, requestedAt) {
  // Best-effort: an unreadable or malformed wake file must never block a new
  // wake, so a failure here degrades to "no carried subjects" rather than
  // throwing into the caller's claim loop.
  try {
    const snapshot = readWakeSnapshot(filePath);
    const payload = snapshot?.payload;
    if (!payload || typeof payload !== 'object') return [];
    try {
      const consumed = JSON.parse(readFileSync(consumedPath, 'utf8'));
      if (consumed?.consumed_key === snapshot.key) return [];
    } catch {
      // A missing or unreadable receipt leaves the wake unconsumed.
    }
    const listed = Array.isArray(payload.pending_subjects) ? payload.pending_subjects : [];
    // Subjects written before per-subject times existed inherit the time of
    // the write that carried them. Invalid times are stamped on this carry.
    const inheritedAt = payload.requested_at ?? payload.requestedAt ?? null;
    const normalized = listed
      .map((entry) => wakeSubjectKeyParts({
        repo: entry?.repo,
        prNumber: entry?.pr_number ?? entry?.prNumber,
        headSha: entry?.head_sha ?? entry?.headSha,
        requestedAt: entry?.requested_at ?? entry?.requestedAt ?? inheritedAt,
      }))
      .filter(Boolean)
      .map((entry) => Number.isFinite(Date.parse(entry.requested_at || ''))
        ? entry : { ...entry, requested_at: requestedAt });
    const previous = wakeSubjectKeyParts({
      repo: payload.repo,
      prNumber: payload.pr_number ?? payload.prNumber,
      headSha: payload.head_sha ?? payload.headSha,
      requestedAt: inheritedAt,
    });
    const stampedPrevious = previous && !Number.isFinite(Date.parse(previous.requested_at || ''))
      ? { ...previous, requested_at: requestedAt } : previous;
    return dedupeWakeSubjects(stampedPrevious ? [...normalized, stampedPrevious] : normalized);
  } catch {
    return [];
  }
}

function freshWakePayload(payload, startedAtMs, ttlMs) {
  if (!payload || typeof payload !== 'object') return payload;
  const inheritedAt = payload.requested_at ?? payload.requestedAt;
  const pendingSubjects = Array.isArray(payload.pending_subjects)
    ? payload.pending_subjects.filter((entry) => wakeSubjectIsFresh({
      requested_at: entry?.requested_at ?? entry?.requestedAt ?? inheritedAt,
    }, startedAtMs, ttlMs))
    : [];
  const topLevelFresh = wakeSubjectIsFresh({ requested_at: inheritedAt }, startedAtMs, ttlMs);
  return {
    ...payload,
    ...(topLevelFresh ? {} : {
      repo: null, pr_number: null, prNumber: null, head_sha: null, headSha: null,
    }),
    pending_subjects: pendingSubjects,
  };
}

function writeConsumedReceipt(filePath, key) {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ consumed_key: key })}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function requestWatcherWake({
  rootDir,
  reason = 'unspecified',
  repo = null,
  prNumber = null,
  headSha = null,
  requestedAt = new Date().toISOString(),
  requestId = randomUUID(),
} = {}) {
  if (!rootDir) {
    throw new Error('requestWatcherWake requires rootDir');
  }
  const filePath = watcherWakePath(rootDir);
  const consumedPath = watcherWakeConsumedPath(rootDir);
  mkdirSync(dirname(filePath), { recursive: true });
  // The wake file is a single slot that `renameSync` overwrites, so a burst of
  // wakes used to keep only the last one: with N clean PRs settling in one
  // drainer pass, N-1 lost their priority and fell back to ordinary poll
  // latency. That is exactly the backlog case the hammer wake exists to clear.
  //
  // Carry the un-consumed subjects forward instead. `repo`/`pr_number`/
  // `head_sha` still describe the newest request, so any reader that predates
  // `pending_subjects` behaves exactly as before; readers that understand the
  // list match any subject in it.
  const writtenAt = new Date().toISOString();
  const stampedAt = Number.isFinite(Date.parse(requestedAt)) ? requestedAt : writtenAt;
  const carried = carriedWakeSubjects(filePath, consumedPath, writtenAt);
  const subject = wakeSubjectKeyParts({ repo, prNumber, headSha, requestedAt: stampedAt });
  const pendingSubjects = subject
    ? dedupeWakeSubjects([...carried, subject]).slice(-MAX_PENDING_WAKE_SUBJECTS)
    : carried.slice(-MAX_PENDING_WAKE_SUBJECTS);
  const payload = {
    schema_version: 1,
    request_id: requestId,
    requested_at: stampedAt,
    reason,
    repo,
    pr_number: prNumber,
    ...(headSha ? { head_sha: headSha } : {}),
    ...(pendingSubjects.length ? { pending_subjects: pendingSubjects } : {}),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
  return { requested: true, filePath, payload };
}

function normalizeWakePrNumber(value) {
  const prNumber = Number(value);
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

function watcherWakeMatchesSubject(payload, {
  repoPath = null,
  prNumber = null,
  headSha = null,
} = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const candidates = [
    { repo: payload.repo, pr_number: payload.pr_number ?? payload.prNumber, head_sha: payload.head_sha ?? payload.headSha },
    ...(Array.isArray(payload.pending_subjects) ? payload.pending_subjects : []),
  ];
  const wantRepo = String(repoPath || '').trim();
  const wantPr = normalizeWakePrNumber(prNumber);
  const wantHead = String(headSha || '').trim();
  for (const candidate of candidates) {
    const requestedRepo = String(candidate?.repo || '').trim();
    const requestedPrNumber = normalizeWakePrNumber(candidate?.pr_number ?? candidate?.prNumber);
    if (!requestedRepo || requestedPrNumber === null) continue;
    if (wantRepo !== requestedRepo) continue;
    if (wantPr !== requestedPrNumber) continue;
    const requestedHead = String(candidate?.head_sha || candidate?.headSha || '').trim();
    // An entry with no head pins only repo+PR, matching the prior behaviour.
    if (requestedHead && wantHead !== requestedHead) continue;
    return true;
  }
  return false;
}

function createWatcherWakePayloadAccessor({
  initialPayload = null,
  consumeWakePayload = null,
} = {}) {
  let activePayload = initialPayload || null;
  return () => {
    if (activePayload || typeof consumeWakePayload !== 'function') return activePayload;
    activePayload = consumeWakePayload() || null;
    return activePayload;
  };
}

function watcherWakeDispatchCandidate(payload, repoPath, entry) {
  return {
    repoPath,
    prNumber: entry.prNumber,
    subject: entry.subject,
    current: entry.current,
    hasPriorPostedReview: entry.hasPriorPostedReview,
    wakePriority: watcherWakeMatchesSubject(payload, {
      repoPath,
      prNumber: entry.prNumber,
      headSha: entry.subject?.headSha,
    }),
  };
}

function compareWatcherWakeSubjectEntries(payload, repoPath, a, b, compareCandidates) {
  return compareCandidates(
    watcherWakeDispatchCandidate(payload, repoPath, a),
    watcherWakeDispatchCandidate(payload, repoPath, b),
  );
}

function createWatcherWakeSource({
  rootDir,
  logger = console,
  pollMs = DEFAULT_WAKE_POLL_MS,
  rateLimiter = createHandoffRateLimiter({ rootDir, logger }),
  loadConfigImpl = loadConfigCached,
  env = process.env,
  recordHandoffWakeEventsImpl = recordHandoffWakeEvents,
  consumeExistingOnStart = false,
  now = Date.now,
} = {}) {
  if (!rootDir) {
    throw new Error('createWatcherWakeSource requires rootDir');
  }
  const filePath = watcherWakePath(rootDir);
  const consumedPath = watcherWakeConsumedPath(rootDir);
  const dirPath = dirname(filePath);
  mkdirSync(dirPath, { recursive: true });

  const startedAtMs = now();
  let lastSeen = consumeExistingOnStart ? null : (readWakeSnapshot(filePath)?.key || null);
  let closed = false;
  const waiters = new Set();

  function consumeIfChanged() {
    const nextSeen = readWakeSnapshot(filePath);
    if (!nextSeen || nextSeen.key === lastSeen) return null;
    lastSeen = nextSeen.key;
    try {
      const cfg = loadConfigImpl({ env }).getHandoffConfig();
      rateLimiter?.setMaxPerPrHead?.(normalizeHandoffMaxPerPrHead(cfg.maxPerPrHead));
    } catch (err) {
      logger?.warn?.(`[watcher] handoff rate-cap config load failed; using current cap: ${err?.message || err}`);
    }
    const payload = freshWakePayload(
      nextSeen.payload || { reason: 'unreadable-wake-file' },
      startedAtMs,
      wakeSubjectTtlMs(env),
    );
    const topLevel = wakeSubjectKeyParts({
      repo: payload.repo,
      prNumber: payload.pr_number ?? payload.prNumber,
      headSha: payload.head_sha ?? payload.headSha,
      requestedAt: payload.requested_at ?? payload.requestedAt,
    });
    const subjects = dedupeWakeSubjects([
      ...(Array.isArray(payload.pending_subjects) ? payload.pending_subjects : []),
      topLevel,
    ].map((subject) => wakeSubjectKeyParts({
      repo: subject?.repo,
      prNumber: subject?.pr_number ?? subject?.prNumber,
      headSha: subject?.head_sha ?? subject?.headSha,
      requestedAt: subject?.requested_at ?? subject?.requestedAt,
    })));
    const accepted = subjects.filter((subject) => rateLimiter?.inspect?.({
      ...subject,
      reason: payload.reason,
    })?.accepted !== false);
    // Do not acknowledge an all-capped snapshot: a later writer must still
    // carry its pending subjects, which may include a different PR head.
    if (subjects.length > 0 && accepted.length === 0) return null;
    const topLevelAccepted = topLevel && accepted.some((subject) =>
      wakeSubjectKey(subject) === wakeSubjectKey(topLevel));
    const promoted = topLevelAccepted ? null : accepted.at(-1);
    const delivered = {
      ...payload,
      ...(promoted ? {
        repo: promoted.repo,
        pr_number: promoted.pr_number,
        prNumber: null,
        head_sha: promoted.head_sha ?? null,
        headSha: null,
        requested_at: promoted.requested_at ?? payload.requested_at,
      } : {}),
      pending_subjects: accepted,
    };
    try {
      writeConsumedReceipt(consumedPath, nextSeen.key);
    } catch (err) {
      logger?.warn?.(`[watcher] wake receipt write failed; carrying subjects until next consume: ${err?.message || err}`);
    }
    try {
      recordHandoffWakeEventsImpl({
        rootDir,
        payload: delivered,
        target: 'watcher',
        wokeAt: new Date().toISOString(),
      });
    } catch {
      // Telemetry is best-effort and must not block the watcher wake path.
    }
    return delivered;
  }

  function notifyIfChanged() {
    if (closed || waiters.size === 0) return;
    const payload = consumeIfChanged();
    if (!payload) return;
    for (const waiter of [...waiters]) {
      waiter({ woken: true, reason: 'wake-file', payload });
    }
  }

  let watcher = null;
  try {
    watcher = watch(dirPath, { persistent: false }, (_eventType, filename) => {
      if (filename && String(filename) !== WATCHER_WAKE_FILE) return;
      notifyIfChanged();
    });
    watcher.on('error', (err) => {
      logger?.warn?.(`[watcher] wake-file watch failed; falling back to polling: ${err?.message || err}`);
    });
  } catch (err) {
    logger?.warn?.(`[watcher] wake-file watch unavailable; falling back to polling: ${err?.message || err}`);
  }

  function wait(timeoutMs) {
    if (closed) {
      return Promise.resolve({ woken: false, reason: 'closed' });
    }
    // Check the wake file BEFORE honouring a zero/negative timeout. The poll loop
    // computes its sleep as `Math.max(0, nextStart - Date.now())`, so any poll that
    // overruns the poll interval makes every subsequent call `wait(0)`. Returning
    // early on `timeoutMs <= 0` without reading the file meant a slow poll blinded
    // the wake path entirely — not "woke late", never woke at all, because the file
    // was never opened and `lastSeen` never advanced.
    //
    // Observed 2026-09-21: 64 subjects stranded in the wake file with zero
    // `wake pollOnce` entries in the watcher log, so every clean PR that requested
    // a hammer wake sat unmerged. A zero-length wait must still mean "check once,
    // do not block" — the non-blocking contract below is preserved.
    const immediatePayload = consumeIfChanged();
    if (immediatePayload) {
      return Promise.resolve({ woken: true, reason: 'wake-file', payload: immediatePayload });
    }
    if (timeoutMs <= 0) {
      return Promise.resolve({ woken: false, reason: 'timeout' });
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      let interval = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (interval) clearInterval(interval);
        waiters.delete(finish);
        resolve(result);
      }

      waiters.add(finish);
      timeout = setTimeout(() => finish({ woken: false, reason: 'timeout' }), timeoutMs);
      interval = setInterval(notifyIfChanged, Math.max(100, pollMs));
    });
  }

  function close() {
    closed = true;
    try {
      watcher?.close?.();
    } catch {
      // Best-effort cleanup only.
    }
    for (const waiter of [...waiters]) {
      waiter({ woken: false, reason: 'closed' });
    }
    waiters.clear();
  }

  return { filePath, wait, close, consumeCurrent: consumeIfChanged };
}

export {
  DEFAULT_WAKE_POLL_MS,
  compareWatcherWakeSubjectEntries,
  createWatcherWakePayloadAccessor,
  createWatcherWakeSource,
  requestWatcherWake,
  watcherWakeMatchesSubject,
  watcherWakePath,
};
