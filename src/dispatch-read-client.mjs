// Read-only app boundary. No local ledger or filesystem fallback is permitted.
import { loadAppSdkSync } from './app-sdk-loader.mjs';
import { isTransientAppContractError, withAppContractTransientRetry } from './app-contract-retry.mjs';
import { observeSynchronousChild } from './watcher-latency.mjs';

let cachedSession;
function options(args) {
  return { app_id: 'adversarial-review', mode: 'agent-os',
    ...args.connectOptions, request_timeout_ms: args.timeoutMs ?? 8000 };
}
function sessionKey(config) {
  return JSON.stringify(Object.fromEntries(Object.entries(config)
    .filter(([key]) => key !== 'request_timeout_ms')
    .sort(([a], [b]) => a.localeCompare(b))));
}
// The composition seam accepts a packaged SDK session (also used by offline
// consumer fixtures); policy callers never select a ledger backend.
export const dispatchReadTransport = {
  sdk: loadAppSdkSync,
  async lookup(selector, args = {}) {
    const env = args.env ?? process.env;
    if (!args.dispatchSession) {
      if (selector.observation) assertObservationsEnabled(env);
      else assertReadsEnabled(env);
    }
    const ownId = env.HQ_LAUNCH_REQUEST_ID;
    if (!args.dispatchSession && ownId && !selector.include_retry_chain
      && selector.launch_request_ids?.length === 1 && selector.launch_request_ids[0] === ownId
      && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN)) {
      return dispatchReadTransport.sdk().readHcpDispatchLookup(selector, {token_path:env.HCP_TOKEN_PATH,
        token:env.HCP_TOKEN || env.HCP_BEARER_TOKEN, endpoint_url:env.HCP_BASE_URL,
        request_timeout_ms:args.timeoutMs ?? 8000});
    }
    const deadline = Date.now() + (args.timeoutMs ?? 8000);
    if (args.dispatchSession) return args.dispatchSession.dispatchLookup(selector);
    const session = await registeredSession(args);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('dispatch lookup timed out'), {code:'ETIMEDOUT'});
    // SDK 0.9.0 exposes a public token-based read with a per-request physical
    // HTTP timeout. Do not mutate a shared session's timeout across callers.
    return dispatchReadTransport.sdk().readSessionDispatchLookup(selector, {
      session_token: session.sessionToken, endpoint_url: session.endpoint_url,
      request_timeout_ms: remaining,
    });
  },
  observationSync(selector, args = {}) {
    if (!args.workerObservationSyncImpl) assertObservationsEnabled(args.env ?? process.env);
    const config = options(args);
    const session = cachedSession?.config && sessionKey(cachedSession.config) === sessionKey(config) ? cachedSession.session : null;
    // Reuse the SDK session established by async reads. Never register from a
    // synchronous accounting call or borrow a token from another endpoint.
    const syncOptions = { ...config, session_token: config.session_token || session?.sessionToken,
      endpoint_url: config.endpoint_url || session?.endpoint_url };
    return observeSynchronousChild('node', () =>
      (args.workerObservationSyncImpl ?? dispatchReadTransport.sdk().readWorkerObservationsSync)(selector, syncOptions));
  },
  lookupSync(selector, args = {}) {
    if (!args.dispatchLookupSyncImpl) assertReadsEnabled(args.env ?? process.env);
    return observeSynchronousChild('node', () =>
      (args.dispatchLookupSyncImpl ?? dispatchReadTransport.sdk().readDispatchLookupSync)(selector, options(args)));
  },
};
async function registeredSession(args) {
  const config = options(args);
  const key = sessionKey(config);
  if (config.session_token) return {sessionToken:config.session_token,
    endpoint_url:config.endpoint_url ?? (args.env ?? process.env).APP_CONTRACT_ENDPOINT_URL};
  if (cachedSession?.key !== key) {
    cachedSession = {key, config, promise:dispatchReadTransport.sdk().connect(config)};
  }
  const entry = cachedSession;
  try {
    const session = await entry.promise;
    if (cachedSession === entry) entry.session = session;
    return session;
  } catch (error) {
    if (cachedSession === entry) cachedSession = null;
    throw error;
  }
}

// Cold CLI composition roots register once before entering synchronous capture
// loops. Failure is explicit; no sync call registers or opens private OS state.
export async function prepareWorkerObservationSession(args = {}) {
  try {
    assertObservationsEnabled(args.env ?? process.env);
    await boundedCall(() => registeredSession(args), args);
    return {ok:true};
  } catch (error) { cachedSession = null; return unavailable(error); }
}

export async function readDispatchLaunches(selector, args = {}) {
  try { return checked(await retryingDispatchLookup(selector, args), selector); }
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

// Bound caller settlement across registration and lookup. SDK HTTP requests
// also receive the remaining physical timeout. AbortSignal settlement does not
// imply physical cancellation; SDK 0.9.0 has no AbortSignal API.
// One retry shares the caller's original deadline, including registration and
// retry delay. Never grant another full timeout or retry after abort/expiry.
async function retryingDispatchLookup(selector, args) {
  const deadline = Date.now() + (args.timeoutMs ?? 8000);
  return boundedCall(() => withAppContractTransientRetry(async () => {
    args.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('dispatch lookup timed out'), {code:'ETIMEDOUT'});
    try {
      return await dispatchReadTransport.lookup(selector, {...args, timeoutMs: remaining});
    } catch (error) {
      cachedSession = null;
      throw error;
    }
  }, {maxAttempts: 2}), args);
}

async function boundedLookup(selector, args) {
  return boundedCall(() => dispatchReadTransport.lookup(selector, args), args);
}
async function boundedCall(call, args) {
  const signal = args.signal;
  signal?.throwIfAborted();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(Object.assign(new Error('dispatch lookup timed out'),
      { code: 'ETIMEDOUT' })), args.timeoutMs ?? 8000);
  });
  try { return await Promise.race([call(), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function unavailable(error) {
  const transient = isTransientAppContractError(error);
  // Error messages can contain endpoint credentials or producer response data.
  return { ok: false, reason: 'dispatch-read-unavailable', transient,
    detail: error?.code === 'WORKER_OBSERVATION_DISABLED' ? 'worker observations disabled'
      : error?.code === 'DISPATCH_READ_DISABLED' ? 'dispatch lookup disabled'
      : error?.name === 'AbortError' ? 'dispatch lookup aborted'
      : transient ? 'transient dispatch lookup failure' : 'dispatch lookup failed' };
}

function assertReadsEnabled(env) {
  if (env.ADVERSARIAL_DISPATCH_READS_ENABLED !== '1') {
    throw Object.assign(new Error('dispatch lookup disabled'), { code: 'DISPATCH_READ_DISABLED' });
  }
}

function assertObservationsEnabled(env) {
  if (env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED !== '1') {
    throw Object.assign(new Error('worker observations disabled'), {code:'WORKER_OBSERVATION_DISABLED'});
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
      if (evidence.notLive) return {...observationRows([], selector.observation),outcome:'not-live'};
      rows.push(...evidence.rows);
      if (reply.complete) return observationRows(rows, selector.observation);
      offset = reply.next_offset;
    }
    return {ok:false,reason:'worker-observation-unavailable'};
  } catch (error) { cachedSession = null; return observationFailure(error); }
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
      if (evidence.notLive) return {...observationRows([], selector.observation),outcome:'not-live'};
      rows.push(...evidence.rows);
      if (reply.complete) return observationRows(rows, selector.observation);
      offset = reply.next_offset;
    }
    return {ok:false,reason:'worker-observation-unavailable'};
  } catch (error) { cachedSession = null; return observationFailure(error); }
}
function observationFailure(error) {
  if (Number(error?.status ?? error?.statusCode ?? error?.response?.status) === 403
    || ['scope_denied','read_scope_denied','dispatch_read_scope_denied','dag_read_scope_denied'].includes(error?.code)
    || /^app-contract (?:403|scope_denied|read_scope_denied|dispatch_read_scope_denied|dag_read_scope_denied)\b/.test(error?.message ?? '')) {
    return {ok:false,reason:'worker-observation-scope-denied'};
  }
  return unavailable(error);
}
function observationRows(rows, observation) {
  if (!rows.length && ['workers','sessions','provenance'].includes(observation)) return {ok:false,reason:'worker-observation-inconclusive',detail:'authorized observation returned no rows'};
  const identity = {workers:'run_id',sessions:'session_id',provenance:'launch_request_id',completions:'completion_id',dag_runs:'run_id',execution_verdicts:'verdictId',hardening_contracts:'contract_id',hardening_records:'record_id',hardening_exposure:'contract_id'}[observation];
  if (rows.some(row => typeof row?.[identity] !== 'string' || !row[identity].trim())
    || new Set(rows.map(row => row[identity])).size !== rows.length) return {ok:false,reason:'worker-observation-unavailable'};
  return {ok:true,rows,row:rows[0],target:{backend:'app-contract',source:'app-sdk'}};
}
function checkedObservation(reply, selector, offset) {
  // The producer's explicit refusal is distinct from an empty authorized page.
  // Unknown statuses always remain unavailable, including on later pages.
  if (reply?.schema_version === 1 && reply.observation === selector.observation
    && reply.status === 'scope_denied') return {ok:false,reason:'worker-observation-scope-denied'};
  if (reply?.schema_version === 1 && selector.observation === 'dag_runs'
    && reply.observation === 'dag_runs' && reply.status === 'not_live'
    && offset === 0 && reply.complete === true && reply.next_offset === null
    && reply.scope_complete === false && reply.mutation_authority === false
    && Array.isArray(reply.items) && reply.items.length === 0) return {ok:true,rows:[],notLive:true};
  const evidence = dispatchReadTransport.sdk().readWorkerObservations(reply);
  if (!evidence.available || reply.observation !== selector.observation
    || !reply.complete && (reply.next_offset !== offset + evidence.items.length || !evidence.items.length)) {
    return {ok:false, reason:'worker-observation-unavailable'};
  }
  return {ok:true,rows:evidence.items};
}

// Compatibility callers requesting the latest matching receipt do not claim a
// complete inventory. Keep the page's completeness distinct from row validity.
export async function readLatestReviewObservation(selector, args = {}) {
  try {
    const reply=await boundedLookup({...selector,limit:1,offset:0},args);
    const evidence=checkedObservation(reply,selector,0);
    if(!evidence.ok) return evidence;
    if(evidence.rows.length>1) return {ok:false,reason:'worker-observation-unavailable'};
    return {...observationRows(evidence.rows,selector.observation),complete:reply.complete};
  } catch(error) {cachedSession=null;return observationFailure(error);}
}
export function readLatestReviewObservationSync(selector, args = {}) {
  try {
    const reply=dispatchReadTransport.observationSync({...selector,limit:1,offset:0},args);
    const evidence=checkedObservation(reply,selector,0);
    if(!evidence.ok) return evidence;
    if(evidence.rows.length>1) return {ok:false,reason:'worker-observation-unavailable'};
    return {...observationRows(evidence.rows,selector.observation),complete:reply.complete};
  } catch(error) {cachedSession=null;return observationFailure(error);}
}
