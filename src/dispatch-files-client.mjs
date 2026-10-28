// Public dispatch-file evidence only. Transport failure always retains custody.
import { resolve } from 'node:path';
import { dispatchReadTransport, hostObservationFailure, readWorkerObservation, readWorkerObservationSync } from './dispatch-read-client.mjs';

const unavailable = () => ({ok: false, reason: 'dispatch-files-unavailable'});
function checked(reply) {
  const evidence = dispatchReadTransport.sdk().readDispatchFiles(reply);
  return evidence.available && evidence.found ? {ok: true, ...evidence} : unavailable();
}
export async function readDispatchFiles(selector, args = {}) {
  try { return checked(await dispatchReadTransport.lookup({...selector, observation: 'dispatch_files'}, args)); }
  catch { return unavailable(); }
}
export function readDispatchFilesSync(selector, args = {}) {
  try {
    const env = args.env ?? process.env;
    const request = {...selector, observation: 'dispatch_files'};
    if (typeof selector.launch_request_id === 'string' && selector.launch_request_id.trim() && selector.launch_request_id === env.HQ_LAUNCH_REQUEST_ID && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN)) {
      return checked(dispatchReadTransport.sdk().readHcpDispatchLookupSync(request, {
        token_path: env.HCP_TOKEN_PATH, token: env.HCP_TOKEN || env.HCP_BEARER_TOKEN,
        endpoint_url: env.HCP_BASE_URL, request_timeout_ms: args.timeoutMs ?? 8000}));
    }
    return checked(dispatchReadTransport.observationSync(request, args));
  }
  catch { return unavailable(); }
}
export async function readWorkerDispatchFiles(workerId, args = {}) {
  const observed = await readWorkerObservation({observation: 'workers', worker_id: workerId}, args);
  // Worker slots are reused. Without a producer ordering contract, multiple runs
  // cannot identify the current slot safely, regardless of their status.
  if (!observed.ok || observed.rows?.length !== 1) return unavailable();
  const row = observed.rows[0];
  const result = await readDispatchFiles({launch_request_id: row.launch_request_id, worker_run_id: row.run_id, tail: true}, args);
  if (result.ok && (result.metadata?.status !== 'found'
    || !['available', 'missing'].includes(result.metadata.fileStates?.run) || !['available', 'missing'].includes(result.metadata.fileStates?.workspace))) return unavailable();
  return result.ok ? {...result, row} : result;
}
export function readWorkerDispatchFilesSync(workerId, args = {}) {
  const observed = readWorkerObservationSync({observation: 'workers', worker_id: workerId}, args);
  // Worker slots are reused. Without a producer ordering contract, multiple runs
  // cannot identify the current slot safely, regardless of their status.
  if (!observed.ok || observed.rows?.length !== 1) return unavailable();
  const row = observed.rows[0];
  const result = readDispatchFilesSync({launch_request_id: row.launch_request_id, worker_run_id: row.run_id, tail: true}, args);
  if (result.ok && (result.metadata?.status !== 'found'
    || !['available', 'missing'].includes(result.metadata.fileStates?.run) || !['available', 'missing'].includes(result.metadata.fileStates?.workspace))) return unavailable();
  return result.ok ? {...result, row} : result;
}

// Identity is static for this process. Keep authorities separate for callers
// that explicitly select another host/root; never retain failed observations.
const hostOwners = new Map();
const identityBackoff = new Int32Array(new SharedArrayBuffer(4));
const transientIdentityReasons = new Set(['timeout', 'spawn-failure', 'unavailable']);

// Only fixed classes leave this boundary. SDK messages may contain credentials
// or response bodies; inspect them for classification, never return them.
function hostIdentityFailure(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = error?.cause?.code || error?.code;
  const message = String(error?.message || '');
  if ([401, 403, 404].includes(status)
    || ['EACCES', 'EPERM', 'scope_denied', 'read_scope_denied', 'dispatch_read_scope_denied', 'dag_read_scope_denied'].includes(code)
    || /^app-contract (?:401|403|404|scope_denied|read_scope_denied|dispatch_read_scope_denied|dag_read_scope_denied)\b/.test(message)) return 'denied';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'].includes(code)
    || error?.name === 'AbortError' || /timeout|timed out/i.test(message)) return 'timeout';
  if (['ENOENT', 'EAGAIN', 'ENOMEM', 'ENOEXEC'].includes(code)
    || /^spawn(?:Sync)?\b/.test(error?.syscall || '') || /^spawn(?:Sync)?\b/.test(message)) return 'spawn-failure';
  if (error instanceof SyntaxError || /^app-contract bad_response\b/.test(message)) return 'malformed';
  return 'unavailable';
}

export function readHostIdentitySync(args = {}) {
  const env = args.env ?? process.env;
  const ownToken = env.HQ_LAUNCH_REQUEST_ID && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN);
  const hqRoot = args.hqRoot || env.HQ_ROOT || env.AGENT_OS_HQ_ROOT;
  const key = JSON.stringify([hqRoot ? resolve(hqRoot) : null,
    ownToken ? env.HCP_BASE_URL || null : args.connectOptions?.endpoint_url || env.APP_CONTRACT_ENDPOINT_URL || null,
    // Synthetic transports can model multiple host lifetimes in one process.
    // The production transport has no scope override: its cache never expires.
    dispatchReadTransport.hostIdentityCacheScope?.(args) ?? null]);
  if (hostOwners.has(key)) return {ownerUser: hostOwners.get(key)};
  const deadline = Math.min(args.deadlineMs ?? Infinity, Date.now() + (args.timeoutMs ?? 8000));
  let reason = 'timeout';
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || args.signal?.aborted) return {ownerUser: null, reason: 'timeout'};
    try {
      const reply = ownToken ? dispatchReadTransport.sdk().readHcpDispatchLookupSync({observation: 'host_identity'}, {
        token_path: env.HCP_TOKEN_PATH, token: env.HCP_TOKEN || env.HCP_BEARER_TOKEN,
        endpoint_url: env.HCP_BASE_URL, request_timeout_ms: remaining})
        : dispatchReadTransport.observationSync({observation: 'host_identity'}, {...args, timeoutMs: remaining});
      if (reply?.schema_version !== 1) reason = 'malformed';
      else if (reply.status === 'found' && typeof reply.ownerUser === 'string' && reply.ownerUser.trim()) {
        const ownerUser = reply.ownerUser.trim();
        hostOwners.set(key, ownerUser);
        return {ownerUser};
      } else if (['not_found', 'denied', 'scope_denied'].includes(reply.status)) reason = 'denied';
      else reason = reply.status === 'unavailable' ? 'unavailable' : 'malformed';
    } catch (error) { reason = hostIdentityFailure(error); }
    if (!transientIdentityReasons.has(reason) || attempt === 2) break;
    const delay = 50 * (attempt + 1);
    // Leave room for another attempt; backoff never extends the caller budget.
    if (Date.now() + delay >= deadline || args.signal?.aborted) break;
    Atomics.wait(identityBackoff, 0, 0, delay);
  }
  return {ownerUser: null, reason};
}

export function readHostObservationSync(action, args = {}) {
  try {
    const reply = dispatchReadTransport.hostServicesSync({action, ...args.parameters}, args);
    return reply?.schema_version === 1 && reply.status === 'found' && reply.data && typeof reply.data === 'object'
      ? {ok: true, data: reply.data} : hostObservationFailure(reply);
  } catch (error) { return hostObservationFailure(error); }
}

export async function readHostObservation(action, args = {}) {
  try {
    const reply = await dispatchReadTransport.hostServices({action, ...args.parameters}, args);
    return reply?.schema_version === 1 && reply.status === 'found' && reply.data && typeof reply.data === 'object'
      ? {ok: true, data: reply.data} : hostObservationFailure(reply);
  } catch (error) { return hostObservationFailure(error); }
}
