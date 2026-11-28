import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { deliverAlert } from './alert-delivery.mjs';
import { buildBrokerAdapterEnv, resolveGitHubAdapterBin } from './github-adapter-client.mjs';
import { BROKER_REVIEWER_ROLES, brokerTokenTimeoutMs } from './reviewer-broker-refresh.mjs';
import { WORKER_ROLES } from './remediation-owner-auth.mjs';
import { grokReviewerLaneEnabled } from './grok-reviewer-lane.mjs';

const exec = promisify(execFile);

export async function checkReviewServiceIdentityAtBoot(service, {
  env = process.env, execFileImpl = exec, deliverAlertImpl = deliverAlert,
  laneEnabled = grokReviewerLaneEnabled, log = console, sleepImpl = sleep,
} = {}) {
  const serviceFlag = service === 'follow-up' ? 'FOLLOW_UP_GH_AUTH_VIA_BROKER' : 'WATCHER_GH_AUTH_VIA_BROKER';
  const roles = [...(env[serviceFlag] === 'true' ? ['merge-agent'] : []), ...BROKER_REVIEWER_ROLES
    .filter(({ role, flag }) => env[flag] === 'true' && (role !== 'grok-reviewer' || laneEnabled({ env })))
    .map(({ role }) => role)];
  if (service === 'follow-up' && env.MERGE_AGENT_AUTH_VIA_BROKER === 'true') {
    roles.push(...new Set(['merge-agent', ...Object.values(WORKER_ROLES)].filter(role => !roles.includes(role))));
  }
  if (roles.length === 0) return true;
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bin = resolveGitHubAdapterBin({ env });
      if (!bin) break;
      const childEnv = { ...buildBrokerAdapterEnv(env), AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS: '1' };
      const args = ['identity-check', '--json', ...roles.flatMap(role => ['--role', role])];
      const stdout = await execFileImpl(bin, args, {
        env: childEnv, timeout: brokerTokenTimeoutMs(env), maxBuffer: 256 * 1024,
      }).then(output => output.stdout, error => error.stdout);
      result = JSON.parse(stdout);
      if (Array.isArray(result?.checks)) break;
    } catch { /* Retry an invocation without structured identity evidence. */ }
    if (attempt < 2) await sleepImpl(attempt === 0 ? 100 : 250);
  }
  const checks = Array.isArray(result?.checks) ? result.checks
    .map(check => ({ ...check, owner: typeof check?.owner === 'string' ? check.owner.toLowerCase() : null }))
    .filter(check => roles.includes(check.role) && /^[a-z0-9-]{1,39}$/.test(check.owner ?? '')
      && typeof check.ok === 'boolean') : [];
  const failures = new Map();
  for (const check of checks) {
    if (check.ok) continue;
    const { role, owner } = check;
    const code = typeof check.code === 'string' && /^[a-z0-9-]{1,64}$/.test(check.code)
      ? check.code : 'identity-check-failed';
    failures.set(`${role}/${owner}`, { role, owner, code });
  }
  const inconsistent = result?.ok !== true && failures.size === 0;
  for (const role of roles) {
    if (inconsistent || !checks.some(check => check.role === role)) {
      failures.set(role, { role, owner: 'unknown', code: 'identity-check-unavailable' });
    }
  }
  for (const failure of failures.values()) {
    const { role, owner, code } = failure;
    const message = `[adversarial-${service}] boot GitHub identity check failed role=${role} owner=${owner} code=${code}`;
    log.error?.(message);
    try {
      await deliverAlertImpl(message, {
        event: 'adversarial_review.github_identity_boot_failed', payload: { service, ...failure }, env,
      });
    } catch {
      log.warn?.(`[adversarial-${service}] could not queue GitHub identity boot page for ${role}/${owner}`);
    }
  }
  return failures.size === 0;
}

const serviceTokenOutages = new WeakMap();

export async function observeReviewServiceToken(service, available, summary, {
  env = process.env, log = console, deliverAlertImpl = deliverAlert,
} = {}) {
  let services = serviceTokenOutages.get(env);
  if (!services) serviceTokenOutages.set(env, services = new Map());
  if (available) {
    services.delete(service);
    return true;
  }
  const previous = services.get(service);
  const reason = summary?.failed || (summary?.skipped === 'broker-mode-disabled' && summary.skipped)
    || previous?.reason || 'service-token-missing';
  const outage = { ticks: (previous?.ticks ?? 0) + 1, reason, paged: previous?.paged ?? false };
  services.set(service, outage);
  const message = `[adversarial-${service}] GitHub-dependent work deferred: ${reason}`;
  log.warn?.(message);
  if (outage.ticks >= 3 && !outage.paged) {
    outage.paged = true;
    try {
      const queued = await deliverAlertImpl(message, {
        event: 'adversarial_review.github_service_token_unavailable', payload: { service, reason }, env,
      });
      if (queued === false) outage.paged = false;
    } catch {
      outage.paged = false;
      log.warn?.(`[adversarial-${service}] could not queue GitHub service token page`);
    }
  }
  return false;
}

export function watcherServiceTokenForRequest(env = process.env) {
  if (env.WATCHER_GH_AUTH_VIA_BROKER === 'true' && !env.GITHUB_TOKEN) {
    throw Object.assign(new Error('GitHub service token unavailable'), {
      code: 'service-token-unavailable', authOutage: true,
    });
  }
  return env.GITHUB_TOKEN;
}
