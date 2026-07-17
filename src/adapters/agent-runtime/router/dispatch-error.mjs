// Classify a dispatch failure as a system-wide "hard contract error" (fail the
// whole router over to local) versus a per-subject "request error" (fail only
// that run, leave router state alone) — v2 app architecture §6.2:
//
//   "Request-level 4xx responses caused by an invalid subject or malformed
//    dispatch payload fail only that subject run. They do not count as
//    health-probe failures ... a single fail-closed server-side or transport
//    dispatch rejection [does]."
//
// Rule of thumb: if the endpoint is telling us "this ONE request is bad" it's a
// request error; if it's telling us (or implying by transport) "the endpoint
// isn't serving", it's hard.

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE',
]);

// Per-subject 4xx: the request itself is bad, not the endpoint.
const REQUEST_LEVEL_STATUSES = new Set([400, 404, 409, 422]);

function errorStatus(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  return Number.isFinite(status) ? status : null;
}

function errorCode(err) {
  return String(err?.code ?? err?.cause?.code ?? '').toUpperCase();
}

function classifyDispatchError(err) {
  if (!err) return 'request';

  // Transport-level failure (connection refused/reset, DNS, socket, timeout) —
  // the endpoint isn't reachable/serving: hard.
  if (err.retryable === true) return 'hard';
  if (TRANSIENT_NETWORK_CODES.has(errorCode(err))) return 'hard';

  const status = errorStatus(err);
  if (status != null) {
    if (REQUEST_LEVEL_STATUSES.has(status)) return 'request';
    // 401/403 (auth/entitlement), 408/425/429 (endpoint distress), 5xx, and any
    // other non-request 4xx are fail-closed server-side rejections: hard.
    if (status >= 400) return 'hard';
    return 'request';
  }

  // A client-side configuration error (bad app_id, missing bootstrap token)
  // means we cannot reach the OS at all — failing over to local keeps reviews
  // flowing, so treat it as hard rather than wedging on OS.
  if (err.configurationError === true) return 'hard';

  // Unclassifiable non-HTTP throw during a live dispatch: conservatively hard,
  // so a novel transport fault still triggers the lifeline.
  return 'hard';
}

export {
  REQUEST_LEVEL_STATUSES,
  TRANSIENT_NETWORK_CODES,
  classifyDispatchError,
};
