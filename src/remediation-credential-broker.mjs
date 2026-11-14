import { requeueClaimedFollowUpJobBeforeSpawn } from './remediation-claimed-requeue.mjs';
import { writeFollowUpJob } from './follow-up-jobs.mjs';

export const CREDENTIAL_BROKER_UNREADY = 'credential-broker-unready';
export const CREDENTIAL_REFRESH_UNAVAILABLE = 'remediation-credential-refresh-unavailable';
const DEFAULT_BROKER_URL = 'http://127.0.0.1:4099';

// Plain Git installations without a broker retain their existing behavior.
export async function credentialBrokerReady({ env = process.env, fetchImpl = globalThis.fetch,
  timeoutMs = 2000, signalImpl = AbortSignal.timeout } = {}) {
  if (!env.OAUTH_BROKER_URL && !env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND
    && !Object.entries(env).some(([key, value]) => key.endsWith('_AUTH_VIA_BROKER')
      && ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()))) {
    return { ready: true, skipped: 'broker-not-configured' };
  }
  try {
    const base = String(env.OAUTH_BROKER_URL || DEFAULT_BROKER_URL).replace(/\/+$/u, '');
    const response = await fetchImpl(`${base}/readyz`, {
      signal: signalImpl(timeoutMs), redirect: 'error',
    });
    // /readyz is unauthenticated and its HTTP status is the readiness contract.
    void response.body?.cancel?.().catch(() => {});
    return { ready: response.status === 200 };
  } catch {
    return { ready: false };
  }
}

export async function deferForCredentialBroker({ rootDir, claimed, env, now,
  delayedPendingPaths, probeImpl = credentialBrokerReady }) {
  if ((await probeImpl({ env })).ready) return null;
  const at = now();
  const priorAttempts = claimed.job.credentialBrokerDeferral?.attempts;
  const attempts = Math.min(6, Number.isSafeInteger(priorAttempts) && priorAttempts >= 0 ? priorAttempts + 1 : 1);
  const retryAfter = new Date(Date.parse(at) + Math.min(300_000, 10_000 * (2 ** (attempts - 1)))).toISOString();
  const override = claimed.job.remediationPlan?.nextAction;
  const requeued = requeueClaimedFollowUpJobBeforeSpawn({ rootDir, jobPath: claimed.jobPath, requeuedAt: at });
  requeued.job.credentialBrokerDeferral = { reason: CREDENTIAL_BROKER_UNREADY, attempts, observedAt: at, retryAfter };
  requeued.job.remediationPlan.retryAfter = retryAfter;
  if (override?.operatorOverride === true) requeued.job.remediationPlan.nextAction = override;
  writeFollowUpJob(requeued.jobPath, requeued.job);
  delayedPendingPaths?.add?.(requeued.jobPath);
  return { consumed: false, reason: CREDENTIAL_BROKER_UNREADY, ...requeued };
}

// Only the credential preflight's own diagnostics can classify this failure.
// An ordinary authentication error or rejected lease never earns a refund.
function independentPushFailure(error) {
  return error?.signal || error?.killed
    || (error?.code != null && ![1, 75, 128].includes(error.code))
    || /stale info|fetch first|non-fast-forward|lease.*(?:mismatch|reject)|\[rejected\]|remote rejected/iu.test(String(error?.stderr || ''));
}

export function credentialRefreshNeedsBrokerEvidence(error) {
  const text = String(error?.stderr || '');
  return !independentPushFailure(error)
    && /entitled GitHub re-mint unavailable: (?:remint_transient_exhausted|refresh_unavailable); refusing credential fallback/u.test(text);
}

export function credentialRefreshUnavailable(error) {
  const text = String(error?.stderr || '');
  if (independentPushFailure(error)) return false;
  const entitled = /entitled GitHub re-mint unavailable: broker_unavailable; refusing credential fallback/u.test(text);
  const legacy = /worker GitHub push credential is unusable and could not be refreshed/u.test(text)
    && /broker mode: transient broker failure exhausted retries[^\n]*\(curl_rc=(?:6|7|28|52|56), HTTP (?:000|<no-code>)\)/u.test(text)
    && /could not read Username[^\n]*terminal prompts disabled/u.test(text);
  return entitled || legacy;
}

export function credentialPublicationRefund({ failure, worker, job, outcome, reply }) {
  if (failure?.code !== CREDENTIAL_REFRESH_UNAVAILABLE
    || failure.previousHead !== job.revisionRef
    || !/^[a-f0-9]{40}$/u.test(failure.localCommit || '')
    || failure.localCommit === job.revisionRef
    || !Number.isFinite(Date.parse(worker.spawnedAt))
    || !(Date.parse(failure.refusedAt) >= Date.parse(worker.spawnedAt))
    || reply?.outcome !== 'blocked' || reply.blockers?.length
    || reply.pushback?.length
    || reply.operationalBlockers?.some(entry => entry.code !== CREDENTIAL_REFRESH_UNAVAILABLE)) return null;
  const failures = [outcome?.failureReason, outcome?.failure_reason, outcome?.failureClass, outcome?.failure_class,
    outcome?.failureCode, outcome?.failure_code].filter(Boolean);
  if (failures.some(reason => reason !== CREDENTIAL_REFRESH_UNAVAILABLE)) return null;
  if (outcome?.signal || [137, 143].includes(outcome?.exitCode ?? outcome?.exit_code)
    || ['cancelled', 'canceled', 'superseded'].includes(outcome?.status)) return null;
  return 'credential-refresh-unavailable';
}
