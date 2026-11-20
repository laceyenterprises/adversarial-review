import { loadRoleConfig } from './role-config.mjs';

function parseBooleanEnvFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '' || normalized === '0' || normalized === 'false') return false;
  return null;
}

// Kill-switch for the fail-closed harness-identity assert at the remediation
// spawn boundary. DEFAULT true: a remediation worker's git identity + push
// provider must match its physical harness, and a mismatch fails closed. Set the
// env override or roles.adversarial.remediation.enforce_harness_identity=false to
// downgrade to warn+audit+continue (the assert still records the mismatch, it
// just does not block the spawn). Empty/unset falls through to the config default.
export function isHarnessIdentityEnforcementEnabled(env = process.env, options = {}) {
  const envValue = env.ADVERSARIAL_REMEDIATION_ENFORCE_HARNESS_IDENTITY;
  const parsedEnv = envValue === undefined || envValue === '' ? null : parseBooleanEnvFlag(envValue);
  if (parsedEnv !== null) return parsedEnv;
  try {
    return loadRoleConfig({
      env,
      topPath: options.topPath,
      modulePaths: options.modulePaths,
      loaderImpl: options.loaderImpl,
      contextKey: 'roles.adversarial.remediation.enforce_harness_identity',
    }).get('roles.adversarial.remediation.enforce_harness_identity', true) === true;
  } catch {
    // Fail SAFE toward enforcement: if config can't be read, keep the assert on
    // so a misconfigured host still rejects a mismatched harness identity.
    return true;
  }
}
