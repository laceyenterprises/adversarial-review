import { loadConfigCached } from './config-loader.mjs';
import { join, resolve } from 'node:path';
import { deployCheckoutFromReviewModule, REVIEW_MODULE } from './deploy-checkout-path.mjs';
import { resolveRealPath } from './remediation-reply-paths.mjs';

/**
 * Resolve the deployment checkout root without a host-specific default.
 *
 * Order: AGENT_OS_DEPLOY_CHECKOUT, then the CFG `roots.deploy` value. Returns
 * a canonical absolute path, including for roots with a missing tail, or
 * null when neither yields a non-empty value or the config cannot be loaded, so
 * callers choose their own fail-closed or skip behavior.
 */
export function resolveDeployRoot(env = process.env, { loadConfigImpl = loadConfigCached } = {}) {
  const fromEnv = String(env?.AGENT_OS_DEPLOY_CHECKOUT || '').trim();
  if (fromEnv) return resolveRealPath(resolve(fromEnv));
  let configured;
  try {
    configured = loadConfigImpl({ env }).get('roots.deploy');
  } catch {
    return null;
  }
  const text = String(configured ?? '').trim();
  return text ? resolveRealPath(resolve(text)) : null;
}

/** The vendored module layout is independent evidence for the overlap guard. */
export function resolveDeployCheckout(env = process.env, { sourceRoots = [], loadConfigImpl } = {}) {
  const configured = resolveDeployRoot(env, { loadConfigImpl });
  if (configured) return configured;
  for (const root of sourceRoots) {
    const checkout = deployCheckoutFromReviewModule(root);
    if (checkout) return checkout;
  }
  return null;
}

export function isDeployedReviewModule(rootDir, env) {
  if (!rootDir) return false;
  const checkout = resolveDeployRoot(env);
  return Boolean(checkout && resolveRealPath(resolve(rootDir)) === resolveRealPath(join(checkout, ...REVIEW_MODULE)));
}
