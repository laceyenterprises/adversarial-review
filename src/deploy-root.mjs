import { loadConfigCached } from './config-loader.mjs';

/**
 * Resolve the deployment checkout root without a host-specific default.
 *
 * Order: AGENT_OS_DEPLOY_CHECKOUT, then the CFG `roots.deploy` value. Returns
 * null when neither yields a non-empty value or the config cannot be loaded, so
 * callers choose their own fail-closed or skip behavior.
 */
export function resolveDeployRoot(env = process.env, { loadConfigImpl = loadConfigCached } = {}) {
  const fromEnv = String(env?.AGENT_OS_DEPLOY_CHECKOUT || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const configured = loadConfigImpl({ env }).get('roots.deploy');
    const text = configured === null || configured === undefined ? '' : String(configured).trim();
    return text || null;
  } catch {
    return null;
  }
}
