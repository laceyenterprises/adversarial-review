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
  observationSync(selector, args = {}) {
    if (!args.workerObservationSyncImpl) assertReadsEnabled(args.env ?? process.env);
    return observeSynchronousChild('node', () =>
      (args.workerObservationSyncImpl ?? dispatchReadTransport.sdk().readWorkerObservationsSync)(selector, options(args)));
  },
  lookupSync(selector, args = {}) {
    if (!args.dispatchLookupSyncImpl) assertReadsEnabled(args.env ?? process.env);
    return observeSynchronousChild('node', () =>
      (args.dispatchLookupSyncImpl ?? dispatchReadTransport.sdk().readDispatchLookupSync)(selector, options(args)));
  },
};
export async function readDispatchLaunches(selector, args = {}) {
  try { return checked(await boundedLookup(selector, args)); }
  catch (error) {
    cachedSession = null;
    return unavailable(error);
  }
}
export function readDispatchLaunchesSync(selector, args = {}) {
  try { return checked(dispatchReadTransport.lookupSync(selector, args)); }
  catch (error) { return unavailable(error); }
}
function checked(result) {
  const evidence = dispatchReadTransport.sdk().readDispatchLookupResult(result);
  if (!evidence.available) return {ok:false,reason:evidence.reason};
  // A grant-filtered reply cannot certify absence outside that grant. Retain
  // ownership until the producer can attest complete authorization scope.
  if (!evidence.found) return unprovenAbsence();
  return { ok: true, rows: result.items, roots: result.roots, retryEdges: result.retry_edges,
    target: { backend: 'app-contract', source: 'app-sdk' } };
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


export async function readWorkerObservation(selector, args = {}) {
  try {
    const rows = [];
    let offset = 0;
    const deadline = Date.now() + (args.timeoutMs ?? 8000);
    for (let page = 0; page < 10; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return {ok:false,reason:'worker-observation-unavailable'};
      const reply = await boundedLookup({...selector, offset}, {...args,timeoutMs:remaining});
      const evidence = checkedObservation(reply, selector, offset);
      if (!evidence.ok) return evidence;
      rows.push(...evidence.rows);
      if (reply.complete) return observationRows(rows);
      offset = reply.next_offset;
    }
    return {ok:false,reason:'worker-observation-unavailable'};
  } catch (error) { cachedSession = null; return unavailable(error); }
}
export function readWorkerObservationSync(selector, args = {}) {
  try {
    const rows = [];
    let offset = 0;
    const deadline = Date.now() + (args.timeoutMs ?? 8000);
    for (let page = 0; page < 10; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return {ok:false,reason:'worker-observation-unavailable'};
      const reply = dispatchReadTransport.observationSync({...selector,offset}, {...args,timeoutMs:remaining});
      const evidence = checkedObservation(reply, selector, offset);
      if (!evidence.ok) return evidence;
      rows.push(...evidence.rows);
      if (reply.complete) return observationRows(rows);
      offset = reply.next_offset;
    }
    return {ok:false,reason:'worker-observation-unavailable'};
  } catch (error) { return unavailable(error); }
}
function observationRows(rows) {
  if (!rows.length || new Set(rows.map(row => row.run_id ?? row.session_id ?? row.launch_request_id)).size !== rows.length) return {ok:false,reason:'worker-observation-unavailable'};
  return {ok:true,rows,row:rows[0],target:{backend:'app-contract',source:'app-sdk'}};
}
function checkedObservation(reply, selector, offset) {
  const evidence = dispatchReadTransport.sdk().readWorkerObservations(reply);
  if (!evidence.available || reply.observation !== selector.observation
    || !reply.complete && (reply.next_offset !== offset + evidence.items.length || !evidence.items.length)) {
    return {ok:false, reason:'worker-observation-unavailable'};
  }
  return {ok:true,rows:evidence.items};
}
