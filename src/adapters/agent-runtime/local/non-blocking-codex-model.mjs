import { loadRoleConfig } from '../../../role-config.mjs';
import { resolveNonBlockingCodexModel } from './remediation.mjs';

export function resolveConfiguredNonBlockingCodexModel(env) {
  const config = loadRoleConfig({ env, contextKey: 'roles.adversarial.remediation.non_blocking' });
  return resolveNonBlockingCodexModel({
    model: config.get('roles.adversarial.remediation.non_blocking.model', 'gpt-6.1-sol'),
    reasoningEffort: config.get('roles.adversarial.remediation.non_blocking.reasoning_effort', 'high'),
    env,
    hqRoot: env.HQ_ROOT,
  });
}
