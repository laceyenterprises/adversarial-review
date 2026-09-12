import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createHandoffRateLimiter, normalizeHandoffMaxPerPrHead } from './handoff-rate-cap.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { recordHandoffWakeEvents } from './handoff-telemetry.mjs';

const WATCHER_WAKE_FILE = 'watcher-wake.json';
const DEFAULT_WAKE_POLL_MS = 1000;

function watcherWakePath(rootDir) {
  return join(rootDir, 'data', WATCHER_WAKE_FILE);
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

function wakeSubjectKeyParts({ repo, prNumber, headSha = null }) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPr = normalizeWakePrNumber(prNumber);
  if (!normalizedRepo || normalizedPr === null) return null;
  const normalizedHead = String(headSha || '').trim();
  return {
    repo: normalizedRepo,
    pr_number: normalizedPr,
    ...(normalizedHead ? { head_sha: normalizedHead } : {}),
  };
}

function wakeSubjectKey(subject) {
  return `${subject.repo}#${subject.pr_number}@${subject.head_sha || ''}`;
}

function dedupeWakeSubjects(subjects) {
  const seen = new Set();
  const out = [];
  for (const subject of subjects) {
    if (!subject) continue;
    const key = wakeSubjectKey(subject);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(subject);
  }
  return out;
}

function carriedWakeSubjects(filePath) {
  // Best-effort: an unreadable or malformed wake file must never block a new
  // wake, so a failure here degrades to "no carried subjects" rather than
  // throwing into the caller's claim loop.
  try {
    const snapshot = readWakeSnapshot(filePath);
    const payload = snapshot?.payload;
    if (!payload || typeof payload !== 'object') return [];
    const listed = Array.isArray(payload.pending_subjects) ? payload.pending_subjects : [];
    const normalized = listed
      .map((entry) => wakeSubjectKeyParts({
        repo: entry?.repo,
        prNumber: entry?.pr_number ?? entry?.prNumber,
        headSha: entry?.head_sha ?? entry?.headSha,
      }))
      .filter(Boolean);
    const previous = wakeSubjectKeyParts({
      repo: payload.repo,
      prNumber: payload.pr_number ?? payload.prNumber,
      headSha: payload.head_sha ?? payload.headSha,
    });
    return dedupeWakeSubjects(previous ? [...normalized, previous] : normalized);
  } catch {
    return [];
  }
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
  const carried = carriedWakeSubjects(filePath);
  const subject = wakeSubjectKeyParts({ repo, prNumber, headSha });
  const pendingSubjects = subject
    ? dedupeWakeSubjects([...carried, subject]).slice(-MAX_PENDING_WAKE_SUBJECTS)
    : carried.slice(-MAX_PENDING_WAKE_SUBJECTS);
  const payload = {
    schema_version: 1,
    request_id: requestId,
    requested_at: requestedAt,
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
} = {}) {
  if (!rootDir) {
    throw new Error('createWatcherWakeSource requires rootDir');
  }
  const filePath = watcherWakePath(rootDir);
  const dirPath = dirname(filePath);
  mkdirSync(dirPath, { recursive: true });

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
    const payload = nextSeen.payload || { reason: 'unreadable-wake-file' };
    const cap = rateLimiter?.inspect?.(payload);
    if (cap?.accepted === false) {
      return null;
    }
    try {
      recordHandoffWakeEventsImpl({
        rootDir,
        payload,
        target: 'watcher',
        wokeAt: new Date().toISOString(),
      });
    } catch {
      // Telemetry is best-effort and must not block the watcher wake path.
    }
    return payload;
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
    if (closed || timeoutMs <= 0) {
      return Promise.resolve({ woken: false, reason: closed ? 'closed' : 'timeout' });
    }
    const immediatePayload = consumeIfChanged();
    if (immediatePayload) {
      return Promise.resolve({ woken: true, reason: 'wake-file', payload: immediatePayload });
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
