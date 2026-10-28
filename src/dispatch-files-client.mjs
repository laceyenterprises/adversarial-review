// Public dispatch-file evidence only. Transport failure always retains custody.
import { dispatchReadTransport, readWorkerObservation, readWorkerObservationSync } from './dispatch-read-client.mjs';

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

export function readHostIdentitySync(args = {}) {
  try {
    const env = args.env ?? process.env;
    const ownToken = env.HQ_LAUNCH_REQUEST_ID && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN);
    const reply = ownToken ? dispatchReadTransport.sdk().readHcpDispatchLookupSync({observation: 'host_identity'}, {
      token_path: env.HCP_TOKEN_PATH, token: env.HCP_TOKEN || env.HCP_BEARER_TOKEN,
      endpoint_url: env.HCP_BASE_URL, request_timeout_ms: args.timeoutMs ?? 8000})
      : dispatchReadTransport.observationSync({observation: 'host_identity'}, args);
    return reply?.schema_version === 1 && reply.status === 'found' && typeof reply.ownerUser === 'string'
      ? {ownerUser: reply.ownerUser} : {ownerUser: null, reason: 'host-identity-unavailable'};
  } catch { return {ownerUser: null, reason: 'host-identity-unavailable'}; }
}

export function readHostObservationSync(action, args = {}) {
  try {
    const reply = dispatchReadTransport.hostServicesSync({action, ...args.parameters}, args);
    return reply?.schema_version === 1 && reply.status === 'found' && reply.data && typeof reply.data === 'object'
      ? {ok: true, data: reply.data} : {ok: false, reason: 'host-observation-unavailable'};
  } catch { return {ok: false, reason: 'host-observation-unavailable'}; }
}

export async function readHostObservation(action, args = {}) {
  try {
    const reply = await dispatchReadTransport.hostServices({action, ...args.parameters}, args);
    return reply?.schema_version === 1 && reply.status === 'found' && reply.data && typeof reply.data === 'object'
      ? {ok: true, data: reply.data} : {ok: false, reason: 'host-observation-unavailable'};
  } catch { return {ok: false, reason: 'host-observation-unavailable'}; }
}
