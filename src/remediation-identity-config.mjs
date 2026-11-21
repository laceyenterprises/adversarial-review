// Config access for repository-specific remediation git identities
// (RDXREMIDENTITY-02). The resolver in remediation-worker-provenance.mjs stays
// free of config imports because hammer scripts reach it through lane-reversal;
// the callers that need the config layer wire it in through this module.
//
// The value comes from the cascade-cached role-config loader, so it is not
// re-read from disk on every call, and it is only read when the env layer
// (REMEDIATION_WORKER_GIT_IDENTITY_REPO_OVERRIDES) did not settle the identity.
import { loadRoleConfig } from './role-config.mjs';
import {
  configureRemediationWorkspaceIdentity,
  remediationWorkerGitIdentity,
} from './remediation-worker-provenance.mjs';

export const REPO_IDENTITY_OVERRIDES_CONFIG_KEY = 'remediation.git_identity_repo_overrides';

// Lazy reader handed to the resolver as `configOverrides`. A loader failure
// surfaces as a throw here; the resolver turns it into its fixed warning.
export function repoIdentityConfigOverrides(env = process.env, { loaderImpl } = {}) {
  return () => loadRoleConfig({
    env,
    loaderImpl,
    contextKey: REPO_IDENTITY_OVERRIDES_CONFIG_KEY,
  }).get(REPO_IDENTITY_OVERRIDES_CONFIG_KEY, null);
}

// remediationWorkerGitIdentity with the config layer wired in.
export function remediationWorkerGitIdentityWithConfig(workerClass, env = process.env, { repo, loaderImpl } = {}) {
  return remediationWorkerGitIdentity(workerClass, env, {
    repo,
    configOverrides: repoIdentityConfigOverrides(env, { loaderImpl }),
  });
}

// configureRemediationWorkspaceIdentity with the config layer wired in.
export function configureRemediationWorkspaceIdentityWithConfig({ env = process.env, ...options }) {
  return configureRemediationWorkspaceIdentity({
    ...options,
    env,
    configOverrides: repoIdentityConfigOverrides(env),
  });
}
