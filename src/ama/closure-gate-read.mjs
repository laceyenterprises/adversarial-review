// CLOSERGATES-01: one retry policy for the mandatory reads a closing hammer
// makes after its expensive work (credential refresh, PR context, branch
// protection, required checks, mergeability, predicate inputs). A transient
// failure is retried in place with spaced backoff inside a closure budget; a
// definitive answer refuses at once, exactly as strictly as before. Nothing
// here ever turns an unreadable result into a passing one.

// HAMMERLAUNCHREAD-01: a failed read waits before the next one. Remote reads
// fail in bursts, so back-to-back retries land inside the same burst. Each wait
// is capped by the caller's own budget; this never widens it.
export const LAUNCH_READ_BACKOFF_MS = Object.freeze([2_000, 5_000, 10_000, 20_000, 30_000]);
export function launchReadBackoffMs(failures) {
  return LAUNCH_READ_BACKOFF_MS[Math.min(Math.max(failures, 1), LAUNCH_READ_BACKOFF_MS.length) - 1];
}

// Synchronous helpers sleep without an event loop; offline fixtures replace it.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export const closureGateClock = {
  now: () => performance.now(),
  sleep: ms => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); },
};

// Each gate gets the same window the launch-environment read already had.
export const CLOSURE_GATE_BUDGET_MS = 120_000;

// GitHub, gh and Node transport wording for failures a re-read can outlast.
const TRANSIENT = new RegExp([
  'Something went wrong while executing your query', '"type"\\s*:\\s*"INTERNAL"',
  'HTTP[ /]?\\S*\\s*5\\d\\d', '"status"\\s*:\\s*"?5\\d\\d', '(^|[^0-9])(500|502|503|504)([^0-9]|$)',
  'timed? out', 'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'socket hang up', 'connection (reset|refused|aborted|closed)',
  'temporary failure', 'network is unreachable', 'TLS handshake', 'unexpected EOF',
  'rate limit', 'secondary rate limit', 'abuse detection', 'bad gateway', 'service unavailable',
  'gateway timeout', 'server error',
  // The per-call credential mint timed out or its command failed (hammer-token).
  'entitled token refresh failed \\((timeout or signal|command error)\\)',
].join('|'), 'i');
// A 404 from GitHub. Some 404s are real answers, which callers decide first
// (for example "Branch not protected"); what remains is a not-found claim that
// a confirming re-read must settle before it can refuse.
const NOT_FOUND = /\bnot found\b[^\n]*\b404\b|\bHTTP\s*404\b|"status"\s*:\s*"?404\b/i;

// `transient` retries in place, `not-found` needs a confirming re-read, and
// anything else is definitive: identity, permission and malformed answers
// refuse at once, as they always have.
export function classifyClosureGateFailure(detail) {
  const text = String(detail ?? '');
  if (TRANSIENT.test(text)) return 'transient';
  if (NOT_FOUND.test(text)) return 'not-found';
  return 'definitive';
}

export function closureGateFailureDetail(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  return [error.message, error.stderr, error.stdout, error.code].filter(Boolean).join('\n');
}

// Run `read` until it succeeds, refuses definitively, or the budget is spent.
// `confirmNotFound` settles a 404: true means a re-read agrees the target is
// missing (definitive), false means it contradicts the 404 (retried as
// transient). A failing confirmation is itself transient. Results:
//   { ok: true, value, attempts }
//   { ok: false, kind: 'definitive' | 'not-found' | 'exhausted', detail, attempts }
// `exhausted` covers transient failures and contradicted 404s that outlast the
// budget; `notFoundContradicted` says whether any 404 was contradicted.
export function readClosureGateSync(read, {
  budgetMs = CLOSURE_GATE_BUDGET_MS, clock = closureGateClock,
  classify = classifyClosureGateFailure, confirmNotFound,
} = {}) {
  const begun = clock.now();
  let notFoundContradicted = false;
  for (let attempts = 1; ; attempts += 1) {
    let detail;
    try { return { ok: true, value: read(attempts), attempts }; }
    catch (error) { detail = closureGateFailureDetail(error); }
    let kind = classify(detail);
    if (kind === 'not-found') {
      let confirmed;
      try { confirmed = confirmNotFound ? confirmNotFound(detail) : true; } catch { confirmed = null; }
      if (confirmed === true) return { ok: false, kind: 'not-found', detail, attempts, notFoundContradicted };
      if (confirmed === false) notFoundContradicted = true;
      kind = 'transient';
    }
    if (kind !== 'transient') return { ok: false, kind: 'definitive', detail, attempts, notFoundContradicted };
    const remaining = begun + budgetMs - clock.now();
    if (!(remaining > 0)) return { ok: false, kind: 'exhausted', detail, attempts, notFoundContradicted };
    clock.sleep(Math.min(launchReadBackoffMs(attempts), remaining));
  }
}
