// NOOWNER-01 (SEV1) — a hammer that never launched keeps an owner.
//
// On 2026-10-10 agent-os PRs 8005, 7997, 8025 and 8017 each hit a provisioning
// refusal ("hammer close branch-holder resolution refused or did not free
// branch ..."). The refusal was counted as an ordinary dispatch failure, so
// two of them spent the per-head redispatch budget and every later tick
// answered `dispatch-retry-exhausted` without trying. HAMHOLDER-01 fixed the
// cause at 20:31, and the watcher still refused five minutes later. Only an
// operator relabel released the PRs.
//
// A dispatch that fails before the worker exists (provisioning or admission
// refusal: no launch request was ever emitted) now keeps a slow, bounded
// cadence after its fast retries are spent:
//   - one attempt per closer reclaim window (the pending-lease reclaim age,
//     about 31 minutes at the default 600 s dispatch timeout), and
//   - only inside a 6 hour window that starts when the fast retries ran out.
// The operator is paged once when the slow cadence starts, with the exact
// refusal text, and once more when the window closes and retries stop.
//
// The window and page markers live on the per-head closer dispatch record, so
// a new head starts a fresh budget, and a launch that succeeds clears them.

export const PRELAUNCH_REFUSAL_SLOW_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const PRELAUNCH_REFUSAL_SLOW_RETRY_WAIT_REASON = 'dispatch-refusal-slow-retry-wait';
export const PRELAUNCH_REFUSAL_SLOW_RETRY_EVENT = 'ama_closer.prelaunch_refusal_slow_retry';
export const PRELAUNCH_REFUSAL_EXHAUSTED_EVENT = 'ama_closer.prelaunch_refusal_exhausted';

const REFUSAL_TEXT_LIMIT = 600;

// Process-local debounce, as for the hammer retry-cap page: if the record write
// keeps failing, the persisted page marker never lands and every tick would
// page again. A watcher restart clears it, which re-pages at most once.
const PAGED_IN_PROCESS = new Set();

export function _resetPrelaunchRefusalPageDebounceForTests() {
  PAGED_IN_PROCESS.clear();
}

function parseMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The exact refusal line hq printed, without the `stderr:`/`message:` framing
// formatHqDispatchError adds. Falls back to the first non-empty line.
export function prelaunchRefusalText(lastError) {
  const lines = String(lastError || '').split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:message|stderr|stdout):\s*/i, '').trim())
    .filter(Boolean);
  const named = lines.find((line) => /\[hq\]\s+(?:error|dispatch refused)\b/i.test(line))
    || lines.find((line) => /\brefus(?:ed|ing)\b/i.test(line))
    || lines[0]
    || 'unknown dispatch refusal';
  return named.length > REFUSAL_TEXT_LIMIT ? `${named.slice(0, REFUSAL_TEXT_LIMIT - 3)}...` : named;
}

/**
 * Decide the slow-cadence phase for a closer record whose fast retries are
 * spent. Pure: the caller supplies the refusal kind and the record's clock.
 *
 * @returns {null | {
 *   kind: string, phase: 'wait'|'due'|'exhausted', startedAt: string,
 *   windowEndsAt: string, nextAttemptAt: string|null, intervalMs: number,
 *   refusal: string, firstObservation: boolean,
 * }}
 */
export function planPrelaunchRefusalSlowRetry({
  record,
  kind,
  nowMs,
  lastTouchMs,
  intervalMs,
  windowMs = PRELAUNCH_REFUSAL_SLOW_RETRY_WINDOW_MS,
} = {}) {
  if (!kind || !record || !Number.isFinite(nowMs)) return null;
  const slow = record.prelaunchRefusalSlowRetry && typeof record.prelaunchRefusalSlowRetry === 'object'
    ? record.prelaunchRefusalSlowRetry
    : {};
  const recordedStartMs = parseMs(slow.startedAt);
  const startedMs = recordedStartMs ?? nowMs;
  const windowEndsMs = startedMs + windowMs;
  const nextAttemptMs = Number.isFinite(lastTouchMs) ? lastTouchMs + intervalMs : null;
  let phase;
  if (nowMs >= windowEndsMs) phase = 'exhausted';
  else if (nextAttemptMs === null || nowMs >= nextAttemptMs) phase = 'due';
  else phase = 'wait';
  return {
    kind,
    phase,
    startedAt: isoOrNull(startedMs),
    windowEndsAt: isoOrNull(windowEndsMs),
    nextAttemptAt: isoOrNull(nextAttemptMs),
    intervalMs,
    refusal: prelaunchRefusalText(record.lastError),
    firstObservation: recordedStartMs === null,
  };
}

function kindText(kind) {
  return kind === 'branch-holder'
    ? 'the hammer worktree provision was refused (branch holder)'
    : 'hq refused the hammer dispatch before a worker launched';
}

/**
 * Persist the window start and send each of the two pages at most once.
 * A failed page delivery is not recorded, so the next tick retries it.
 */
export async function notePrelaunchRefusalSlowRetry({
  plan,
  record,
  repo,
  prNumber,
  headSha,
  persistImpl,
  deliverAlertImpl,
  logger = console,
  nowIso,
}) {
  if (!plan) return { paged: false };
  const slow = record?.prelaunchRefusalSlowRetry && typeof record.prelaunchRefusalSlowRetry === 'object'
    ? record.prelaunchRefusalSlowRetry
    : {};
  const exhausted = plan.phase === 'exhausted';
  const pageField = exhausted ? 'exhaustedPagedAt' : 'pagedAt';
  const next = { ...slow, startedAt: slow.startedAt || plan.startedAt, kind: plan.kind };
  const shortHead = String(headSha || 'unknown').slice(0, 12);
  const minutes = Math.round(plan.intervalMs / 60_000);
  const debounceKey = `${repo}\0${prNumber}\0${headSha || ''}\0${next.startedAt}\0${pageField}`;
  let paged = false;
  if (!slow[pageField] && !PAGED_IN_PROCESS.has(debounceKey) && typeof deliverAlertImpl === 'function') {
    const text = exhausted
      ? `Adversarial-review hammer for ${repo}#${prNumber} (head ${shortHead}) still could not launch `
        + `when its slow retry window closed at ${plan.windowEndsAt}; retries have stopped. `
        + `Last refusal: ${plan.refusal}. Operator action required: clear the cause. `
        + 'A new PR head starts a fresh closer dispatch budget.'
      : `Adversarial-review hammer for ${repo}#${prNumber} (head ${shortHead}) could not launch: `
        + `${kindText(plan.kind)} and the fast retries are spent. Refusal: ${plan.refusal}. `
        + `The closer retries every ${minutes} min until ${plan.windowEndsAt}, then stops and pages again. `
        + 'No action is needed if the cause clears before then.';
    try {
      await deliverAlertImpl(text, {
        event: exhausted ? PRELAUNCH_REFUSAL_EXHAUSTED_EVENT : PRELAUNCH_REFUSAL_SLOW_RETRY_EVENT,
        payload: {
          repo,
          prNumber,
          headSha: headSha || null,
          kind: plan.kind,
          refusal: plan.refusal,
          startedAt: next.startedAt,
          windowEndsAt: plan.windowEndsAt,
          intervalMs: plan.intervalMs,
        },
      });
      next[pageField] = nowIso;
      paged = true;
      PAGED_IN_PROCESS.add(debounceKey);
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: `${exhausted ? PRELAUNCH_REFUSAL_EXHAUSTED_EVENT : PRELAUNCH_REFUSAL_SLOW_RETRY_EVENT}_page_failed`,
        repo,
        prNumber,
        headSha: headSha || null,
        error: err?.message || String(err),
      }));
    }
  }
  if (next.startedAt !== slow.startedAt || next.kind !== slow.kind || paged) {
    try {
      persistImpl(next);
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.prelaunch_refusal_slow_retry_persist_failed',
        repo,
        prNumber,
        error: err?.message || String(err),
      }));
    }
  }
  return { paged, slowRetry: next };
}
