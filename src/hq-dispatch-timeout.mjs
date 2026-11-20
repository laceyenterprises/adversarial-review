import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { loadRoleConfig } from './role-config.mjs';

export const HQ_DISPATCH_TIMEOUT_MS = 90_000;

export function resolveHqDispatchTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'follow_up.hq_dispatch_subprocess_timeout_ms',
  }).get('follow_up.hq_dispatch_subprocess_timeout_ms', HQ_DISPATCH_TIMEOUT_MS);
  const parsed = Number(cfgValue);
  return loadAwareTimeoutMs(Number.isInteger(parsed) && parsed > 0 ? parsed : HQ_DISPATCH_TIMEOUT_MS);
}
