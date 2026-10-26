// Read-only app boundary. No local ledger or filesystem fallback is permitted.
import { connect, readDispatchLookupSync, readHcpDispatchLookup, readDispatchLookupResult, dispatchRetryDescendants } from '@agent-os/app-sdk';
import { isExpiredAppContractSessionError } from './app-contract-retry.mjs';

let sessionPromise;
function options(args) {
  return { app_id: 'adversarial-review', mode: 'agent-os',
    request_timeout_ms: args.timeoutMs ?? 8000, ...args.connectOptions };
}
// The composition seam accepts a packaged SDK session (also used by offline
// consumer fixtures); policy callers never select a ledger backend.
export const dispatchReadTransport = {
  async lookup(selector, args = {}) {
    const env = args.env ?? process.env;
    const ownId = env.HQ_LAUNCH_REQUEST_ID;
    if (!args.dispatchSession && ownId && !selector.include_retry_chain
      && selector.launch_request_ids?.length === 1 && selector.launch_request_ids[0] === ownId
      && (env.HCP_TOKEN_PATH || env.HCP_TOKEN || env.HCP_BEARER_TOKEN)) {
      return readHcpDispatchLookup(selector, {token_path:env.HCP_TOKEN_PATH,
        token:env.HCP_TOKEN || env.HCP_BEARER_TOKEN, endpoint_url:env.HCP_BASE_URL,
        request_timeout_ms:args.timeoutMs ?? 8000});
    }
    const session = args.dispatchSession ?? await (sessionPromise ??= connect(options(args)).catch(error => {
      sessionPromise = null;
      throw error;
    }));
    return session.dispatchLookup(selector);
  },
  lookupSync(selector, args = {}) {
    return (args.dispatchLookupSyncImpl ?? readDispatchLookupSync)(selector, options(args));
  },
};
export async function readDispatchLaunches(selector, args = {}) {
  try { return checked(await dispatchReadTransport.lookup(selector, args)); }
  catch (error) {
    if (isExpiredAppContractSessionError(error)) sessionPromise = null;
    return { ok: false, reason: 'dispatch-read-unavailable' };
  }
}
export function readDispatchLaunchesSync(selector, args = {}) {
  try { return checked(dispatchReadTransport.lookupSync(selector, args)); }
  catch { return { ok: false, reason: 'dispatch-read-unavailable' }; }
}
function checked(result) {
  const evidence = readDispatchLookupResult(result);
  if (!evidence.available) return {ok:false,reason:evidence.reason};
  return { ok: true, rows: result.items, roots: result.roots, retryEdges: result.retry_edges,
    target: { backend: 'app-contract', source: 'app-sdk' } };
}
export function launchProbe(result, launchRequestId, includeRetryChain) {
  if (!result.ok) return result;
  const row = result.rows.find(row => row.launch_request_id === launchRequestId);
  if (!row) return { ok: false, reason: 'missing-launch-request-row', launchRequestId };
  return { ok: true, row, target: result.target, ...(includeRetryChain ? { retryChain: dispatchRetryDescendants(result.rows, result.retryEdges, launchRequestId) } : {}) };
}
