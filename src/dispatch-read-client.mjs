// Read-only app boundary. No local ledger or filesystem fallback is permitted.
import { loadAppSdkSync } from './app-sdk-loader.mjs';
import { isTransientAppContractError } from './app-contract-retry.mjs';
import { observeSynchronousChild } from './watcher-latency.mjs';

let cachedSession;
function options(args) {
  return { app_id: 'adversarial-review', mode: 'agent-os',
    ...args.connectOptions, request_timeout_ms: args.timeoutMs ?? 8000 };
}
// The composition seam accepts a packaged SDK session (also used by offline
// consumer fixtures); policy callers never select a ledger backend.
export const dispatchReadTransport = {
  sdk: loadAppSdkSync,
  async lookup(selector, args = {}) {
    const env = args.env ?? process.env;
    if (!args.dispatchSession) assertReadsEnabled(env);
    const ownId = env.HQ_LAUNCH_REQUEST_ID;
    if (!args.dispatchSession && ownId && !selector.include_retry_chain
      && selector.launch_request_ids?.length === 1 && selector.launch_request_ids[0] === ownId
      && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN)) {
      return dispatchReadTransport.sdk().readHcpDispatchLookup(selector, {token_path:env.HCP_TOKEN_PATH,
        token:env.HCP_TOKEN || env.HCP_BEARER_TOKEN, endpoint_url:env.HCP_BASE_URL,
        request_timeout_ms:args.timeoutMs ?? 8000});
    }
    const config = options(args);
    const key = JSON.stringify(config);
    if (!args.dispatchSession && cachedSession?.key !== key) {
      cachedSession = { key, promise: dispatchReadTransport.sdk().connect(config) };
    }
    const session = args.dispatchSession ?? await cachedSession.promise;
    return session.dispatchLookup(selector);
  },
  lookupSync(selector, args = {}) {
    if (!args.dispatchLookupSyncImpl) assertReadsEnabled(args.env ?? process.env);
    return observeSynchronousChild('node', () =>
      (args.dispatchLookupSyncImpl ?? dispatchReadTransport.sdk().readDispatchLookupSync)(selector, options(args)));
  },
};
export async function readDispatchLaunches(selector, args = {}) {
  try { return checked(await boundedLookup(selector, args), selector); }
  catch (error) {
    cachedSession = null;
    return unavailable(error);
  }
}
export function readDispatchLaunchesSync(selector, args = {}) {
  try { return checked(dispatchReadTransport.lookupSync(selector, args), selector); }
  catch (error) { return unavailable(error); }
}
function checked(result, selector) {
  const evidence = dispatchReadTransport.sdk().readDispatchLookupResult(result);
  if (!evidence.available) return {ok:false,reason:evidence.reason};
  // A grant-filtered reply cannot certify absence outside that grant. Retain
  // ownership until the producer can attest complete authorization scope.
  if (!evidence.found && !completeAbsence(result, selector)) return unprovenAbsence();
  return { ok: true, rows: result.items, roots: result.roots, retryEdges: result.retry_edges,
    ...(!evidence.found ? { absenceProof: result.absence_proof } : {}),
    target: { backend: 'app-contract', source: 'app-sdk' } };
}

// This additive producer envelope passes unchanged through released SDK 0.8/0.9
// transports. Traversal completeness, grants or emptiness alone are insufficient.
function completeAbsence(result, selector) {
  const proof = result.absence_proof;
  const keys = Object.keys(selector).sort();
  const exactKey = keys.length === 1 && keys[0] === 'idempotency_key';
  const exactTicket = keys.length === 2 && keys[0] === 'requested_at_or_after' && keys[1] === 'ticket_ref';
  if ((!exactKey && !exactTicket) || result.scope_complete !== true
    || proof?.version !== 1 || proof.kind !== 'canonical-exact-selector-absence'
    || typeof proof.grant_id !== 'string' || !proof.grant_id.trim() || proof.grant_id.length > 256
    || typeof proof.observed_at !== 'string' || !Number.isFinite(Date.parse(proof.observed_at))
    || !proof.selector || Object.keys(proof.selector).length !== keys.length) return false;
  return keys.every(key => Object.hasOwn(proof.selector, key)
    && selector[key] !== undefined && proof.selector[key] === selector[key]);
}
export function launchProbe(result, launchRequestId, includeRetryChain) {
  if (!result.ok) return result;
  const row = result.rows.find(row => row.launch_request_id === launchRequestId);
  if (!row) return { ...unprovenAbsence(), launchRequestId };
  return { ok: true, row, target: result.target, ...(includeRetryChain ? { retryChain: dispatchReadTransport.sdk().dispatchRetryDescendants(result.rows, result.retryEdges, launchRequestId) } : {}) };
}

// SDK 0.8.0 has no per-call cancellation API. Bound caller settlement across
// registration and lookup. The SDK owns outstanding HTTP work after caller
// cancellation; physical cancellation needs SDK support. Never switch routes.
async function boundedLookup(selector, args) {
  const signal = args.signal;
  signal?.throwIfAborted();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(Object.assign(new Error('dispatch lookup timed out'),
      { code: 'ETIMEDOUT' })), args.timeoutMs ?? 8000);
  });
  try { return await Promise.race([dispatchReadTransport.lookup(selector, args), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function unavailable(error) {
  const transient = isTransientAppContractError(error);
  // Error messages can contain endpoint credentials or producer response data.
  return { ok: false, reason: 'dispatch-read-unavailable', transient,
    detail: error?.code === 'DISPATCH_READ_DISABLED' ? 'dispatch lookup disabled'
      : error?.name === 'AbortError' ? 'dispatch lookup aborted'
      : transient ? 'transient dispatch lookup failure' : 'dispatch lookup failed' };
}

function assertReadsEnabled(env) {
  if (env.ADVERSARIAL_DISPATCH_READS_ENABLED !== '1') {
    throw Object.assign(new Error('dispatch lookup disabled'), { code: 'DISPATCH_READ_DISABLED' });
  }
}

function unprovenAbsence() {
  return { ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch absence scope unproven' };
}
