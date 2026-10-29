// Compatibility names for review policy callers; every observation uses the public SDK.
import { readDispatchLaunches, readDispatchLaunchesSync, launchProbe,
  readWorkerObservation, readWorkerObservationSync, readLatestReviewObservation, readLatestReviewObservationSync } from './dispatch-read-client.mjs';
import { withLiveLaunchRetry, launchRequestInFlight, isTerminalLaunchRequestStatus,
  launchRequestMeaning } from './ama/launch-request-status.mjs';

function recoveryScope(args) {
  return args.repo ? { project_ref: args.projectRef || args.project_ref || 'adversarial-merge-authority', repo: args.repo } : {};
}

function normalizeText(value) { return String(value ?? '').trim() || null; }

function workerSelector(args) {
  return {observation:'workers', launch_request_id:args.launchRequestId,
    worker_run_id:args.workerRunId, limit:100};
}
export function readLatestWorkerRunStatusFromLedger(args = {}) {
  if (!normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-launch-request-id'};
  return readWorkerObservationSync(workerSelector(args), args);
}
export async function readLatestWorkerRunStatusFromLedgerAsync(args = {}) {
  if (!normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-launch-request-id'};
  return readWorkerObservation(workerSelector(args), args);
}

// The SDK transports producer-owned launch identity and retry evidence.
export async function readLaunchRequestSnapshotFromLedgerAsync(args = {}) {
  const ids = args.launchRequestIds ?? [];
  if (!ids.length) return { ok: true, rows: [], roots: [], retryEdges: [] };
  return readDispatchLaunches({ launch_request_ids: ids, include_retry_chain: true }, args);
}
export async function readLaunchRequestByIdempotencyKeyAsync(args = {}) {
  if (!normalizeText(args.idempotencyKey)) return { ok: false, reason: 'missing-idempotency-key' };
  return readDispatchLaunches({ ...recoveryScope(args), idempotency_key: args.idempotencyKey }, args);
}
export async function readLaunchRequestsForTicketSinceAsync(args = {}) {
  if (!normalizeText(args.ticketRef) || typeof args.requestedAtOrAfter !== 'string'
    || !Number.isFinite(Date.parse(args.requestedAtOrAfter))) {
    return { ok: false, reason: 'invalid-ticket-attempt-query' };
  }
  return readDispatchLaunches({ ...recoveryScope(args), ticket_ref: args.ticketRef,
    requested_at_or_after: new Date(args.requestedAtOrAfter).toISOString() }, args);
}

// With includeRetryChain, incomplete traversal makes the whole read unavailable.
// No base-row status or absence evidence escapes an incomplete SDK reply.
export function readLaunchRequestStatusFromLedger(args = {}) {
  if (!normalizeText(args.launchRequestId)) return { ok: false, reason: 'missing-launch-request-id' };
  const result = args.launchSnapshot ?? readDispatchLaunchesSync({
    launch_request_ids: [args.launchRequestId], include_retry_chain: !!args.includeRetryChain }, args);
  return launchProbe(result, args.launchRequestId, args.includeRetryChain);
}
export async function readLaunchRequestStatusFromLedgerAsync(args = {}) {
  if (!normalizeText(args.launchRequestId)) return { ok: false, reason: 'missing-launch-request-id' };
  const result = args.launchSnapshot ?? await readDispatchLaunches({
    launch_request_ids: [args.launchRequestId], include_retry_chain: !!args.includeRetryChain }, args);
  return launchProbe(result, args.launchRequestId, args.includeRetryChain);
}

// Collection seam only. Reuse the bounded public observation reader;
// terminal launch evidence outranks a stale worker projection. Neither process
// success nor a wake supplies evidence of a remote merge.
export async function readLaunchRequestObservationFromLedgerAsync({
  readLaunchRequestStatusImpl = readLaunchRequestStatusFromLedgerAsync,
  readWorkerStatusImpl = readLatestWorkerRunStatusFromLedgerAsync,
  ...args
} = {}) {
  const launch = await readLaunchRequestStatusImpl({ ...args, includeRetryChain: true });
  const effective = withLiveLaunchRetry(launch);
  const chainReadable = Array.isArray(launch?.retryChain) && launch.retryChainUnreadable !== true;
  const ownershipProbe = chainReadable ? effective : { ...effective, retryChainUnreadable: true };
  const statusKnown = Boolean(launchRequestMeaning(effective?.row).status)
    || typeof effective?.row?.terminal === 'boolean';
  let worker = null;
  if (effective?.ok && ['starting', 'running'].includes(effective.row?.status)) {
    worker = await readWorkerStatusImpl({ ...args,
      launchRequestId: effective.liveRetryLaunchRequestId || effective.row?.launch_request_id || args.launchRequestId });
  }
  return {
    state: !effective?.ok || !statusKnown || !chainReadable ? 'unknown' : 'complete',
    value: {
      launchRequestId: args.launchRequestId,
      launch: launch?.row ?? null,
      retryChain: launch?.retryChain ?? null,
      retryChainUnreadable: !chainReadable,
      retryChainReadState: chainReadable ? 'complete' : 'failed',
      effectiveLaunch: effective?.row ?? null,
      liveRetryLaunchRequestId: effective?.liveRetryLaunchRequestId ?? null,
      worker: worker?.ok ? worker.row : null,
      inFlight: statusKnown ? launchRequestInFlight(ownershipProbe) : null,
      terminal: statusKnown && launchRequestInFlight(ownershipProbe) === false
        && isTerminalLaunchRequestStatus(effective?.row),
      processSucceeded: launchRequestMeaning(effective?.row).succeeded,
      // The PR observation owns merged/closed receipts, independently.
      remoteMerge: null,
    },
    provenance: { sourceRef: 'launch-requests', backend: launch?.target?.backend ?? null,
      launchRead: launch?.ok === true, launchReadReason: launch?.reason ?? null,
      retryReadReason: launch?.retryChainFailure?.reason ?? null, workerRead: worker?.ok ?? null,
      workerReadReason: worker?.reason ?? null },
  };
}

export function readWorkerRunUsageFromLedger(args = {}) {
  if (!args.workerRunId && !normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-worker-run-selector'};
  return readWorkerObservationSync(workerSelector(args), args);
}
export function readReviewerSessionUsageFromLedger(args = {}) {
  const keys = [...new Set([args.adapterSessionKey, ...(args.sessionKeys ?? [])].filter(Boolean))];
  if (!keys.length) return {ok:false,reason:'missing-runtime-session-selector'};
  const result = readWorkerObservationSync({observation:'sessions',session_keys:keys,limit:100}, args);
  if (!result.ok) return result;
  const rows = result.rows.filter(row => {
    const startedAt = normalizeText(row.started_at);
    const lastActiveAt = normalizeText(row.ended_at) || startedAt;
    // Preserve the ledger window semantics explicitly: unknown starts satisfy
    // the upper bound, but unknown activity cannot satisfy a lower bound.
    return (!args.endedAt || !startedAt || Date.parse(startedAt) <= Date.parse(args.endedAt))
      && (!args.startedAt || lastActiveAt !== null && Date.parse(lastActiveAt) >= Date.parse(args.startedAt));
  });
  return rows.length ? {...result,rows,row:rows[0]} : {ok:false,reason:'no-session-in-window'};
}

// ROUTEPROV-01: latest PR build completion -> LRQ -> actual launch identity.
// Builder identity survives follow-up commits; review/retrigger guards still
// bind to the current head independently.
// These reads never touch PgBouncer session settings or mutate the ledger.
function builderSelector(args) {
  return {observation:'provenance',repo:args.repo,pr_number:Number(args.prNumber),builder_identity:true,limit:100};
}
function builderResult(result) {
  // Review intake may retain a valid title route even when observations are
  // disabled, unsupported or inconclusive. This result is never merge identity
  // or an absence certificate; authority readers retain the original failure.
  return result.ok ? {ok:true,launchRequestId:result.row.launch_request_id,
    workerClass:result.row.worker_class,actualHarness:result.row.actual_harness}
    : {...result,reason:result.reason === 'worker-observation-inconclusive' ? 'missing-builder-provenance' : result.reason,
      deferClaim:false};
}
export function readPrBuilderProvenance(args = {}) {
  if (!normalizeText(args.repo) || !Number.isInteger(Number(args.prNumber)) || Number(args.prNumber)<=0) return {ok:false,reason:'missing-pr-identity'};
  return builderResult(readWorkerObservationSync(builderSelector(args), args));
}
export async function readPrBuilderProvenanceAsync(args = {}) {
  if (!normalizeText(args.repo) || !Number.isInteger(Number(args.prNumber)) || Number(args.prNumber)<=0) return {ok:false,reason:'missing-pr-identity'};
  return builderResult(await readWorkerObservation(builderSelector(args), args));
}


export const LIVE_DAG_RUN_STATES = Object.freeze(['pending', 'running', 'parked', 'awaiting-merge']);
function dagSelector(args) {
  return {observation:'dag_runs', plan_id:args.planId, states:args.states ?? LIVE_DAG_RUN_STATES, limit:100};
}
function dagResult(result, args) {
  // Keep the producer's authorization/liveness answer explicit for PR-local
  // guards. An unavailable or unknown answer never becomes an empty run list.
  if (!result.ok) return {...result,planId:args.planId,
    outcome:result.reason === 'worker-observation-scope-denied' ? 'scope-denied' : 'unavailable'};
  return {...result,planId:args.planId,outcome:result.outcome ?? 'allowed',
    runs:result.rows.slice(0, Math.max(1, Math.min(20, Number.parseInt(args.limit,10)||20)))};
}
export function readActiveDagRunsForPlan(args = {}) {
  if (!normalizeText(args.planId)) return {ok:false,reason:'missing-plan-id'};
  return dagResult(readWorkerObservationSync(dagSelector(args), args), args);
}
export async function readActiveDagRunsForPlanAsync(args = {}) {
  if (!normalizeText(args.planId)) return {ok:false,reason:'missing-plan-id'};
  return dagResult(await readWorkerObservation(dagSelector(args), args), args);
}
function completionSelector(args) {
  return {observation:'completions',repo:args.repo,pr_number:args.prNumber == null ? undefined : Number(args.prNumber),
    launch_request_id:args.launchRequestId,head_sha:args.headSha ?? undefined,
    signal_kind:args.signalKind === null ? undefined : args.signalKind ?? 'merged',limit:100};
}
function completionResult(result, args, producer = false) {
  if (!result.ok) return result;
  if (!result.rows.length) return {ok:false,reason:producer ? 'missing-build-completion-producer-evidence' : 'missing-build-completion-signal',
    repo:args.repo,prNumber:args.prNumber == null ? undefined : Number(args.prNumber),signalKind:args.signalKind ?? 'merged',target:result.target};
  return {...result,row:result.rows[0]};
}
function validCompletion(args) {
  if (!normalizeText(args.repo)) return {ok:false,reason:'missing-repo'};
  if (!Number.isInteger(Number(args.prNumber)) || Number(args.prNumber)<=0) return {ok:false,reason:'missing-pr-number'};
  if (!normalizeText(args.signalKind ?? 'merged')) return {ok:false,reason:'missing-signal-kind'};
  return null;
}
export function readBuildCompletionSignalForPr(args = {}) {
  return validCompletion(args) ?? completionResult(readLatestReviewObservationSync(completionSelector(args),args),args);
}
export async function readBuildCompletionSignalForPrAsync(args = {}) {
  return validCompletion(args) ?? completionResult(await readLatestReviewObservation(completionSelector(args),args),args);
}
export function readBuildCompletionProducerEvidence(args = {}) {
  if (!normalizeText(args.repo)) return {ok:false,reason:'missing-repo'};
  return completionResult(readLatestReviewObservationSync(completionSelector({...args,prNumber:undefined}),args),args,true);
}
export async function readBuildCompletionProducerEvidenceAsync(args = {}) {
  if (!normalizeText(args.repo)) return {ok:false,reason:'missing-repo'};
  return completionResult(await readLatestReviewObservation(completionSelector({...args,prNumber:undefined}),args),args,true);
}
export function readExecutionVerdictsFromLedger(args = {}) {
  return verdictResult(readWorkerObservationSync({observation:'execution_verdicts',launch_request_id:args.launchRequestId,limit:100},args));
}
export async function readExecutionVerdictsFromLedgerAsync(args = {}) {
  return verdictResult(await readWorkerObservation({observation:'execution_verdicts',launch_request_id:args.launchRequestId,limit:100},args));
}
function verdictResult(result) {
  return result.ok ? {ok:true,source:'app-sdk.execution-verdicts',verdicts:result.rows}
    : {...result,reason:'execution-verdict-source-unavailable'};
}
