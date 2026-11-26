import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deliverAlert } from './alert-delivery.mjs';
import { buildBrokerAdapterEnv, resolveGitHubAdapterBin } from './github-adapter-client.mjs';
import { BROKER_REVIEWER_ROLES } from './reviewer-broker-refresh.mjs';
import { grokReviewerLaneEnabled } from './grok-reviewer-lane.mjs';

const exec = promisify(execFile);

export async function checkReviewServiceIdentityAtBoot(service, {
  env = process.env, execFileImpl = exec, deliverAlertImpl = deliverAlert,
  laneEnabled = grokReviewerLaneEnabled, log = console,
} = {}) {
  const roles = ['merge-agent', ...BROKER_REVIEWER_ROLES
    .filter(({ role, flag }) => env[flag] === 'true' && (role !== 'grok-reviewer' || laneEnabled({ env })))
    .map(({ role }) => role)];
  if (service === 'follow-up' && env.MERGE_AGENT_AUTH_VIA_BROKER === 'true') {
    roles.push('claude', 'codex', 'gemini');
  }
  let result;
  try {
    const bin = resolveGitHubAdapterBin({ env });
    if (!bin) throw new Error('adapter unavailable');
    const childEnv = buildBrokerAdapterEnv(env);
    const args = ['identity-check', '--json', ...roles.flatMap(role => ['--role', role])];
    const stdout = await execFileImpl(bin, args, { env: childEnv, timeout: 120_000, maxBuffer: 256 * 1024 })
      .then(output => output.stdout, error => error.stdout);
    result = JSON.parse(stdout);
  } catch { /* Page a bounded diagnostic for a failed invocation. */ }
  const checks = Array.isArray(result?.checks) ? result.checks.filter(check => roles.includes(check?.role)
    && typeof check.owner === 'string' && /^[a-z0-9-]{1,39}$/.test(check.owner) && typeof check?.ok === 'boolean') : [];
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
