import { loadConfigCached } from './config-loader.mjs';
import { DEFAULT_ROLE_TOP_PATH, MODULE_CONFIG_PATH } from './role-config.mjs';

export const DEFAULT_APP_CONTRACT_APP_ID = 'adversarial-review';
export const DEFAULT_APP_CONTRACT_MODE = 'agent-os';
export const DEFAULT_APP_CONTRACT_SUBSCRIPTIONS = Object.freeze([
  'health.worker.*',
  'token.*',
  'system.*',
]);
export const DEFAULT_APP_CONTRACT_VERSION = '1.0';

function isAuthoritativeSource(source) {
  return source === 'top'
    || source === 'cli'
    || (typeof source === 'string' && (source.startsWith('local:') || source.startsWith('env:')));
}

function defaultRegistration(appId) {
  return {
    app_id: appId,
    mode: DEFAULT_APP_CONTRACT_MODE,
    subscribes: [...DEFAULT_APP_CONTRACT_SUBSCRIPTIONS],
    contract_version: DEFAULT_APP_CONTRACT_VERSION,
    registered: false,
    source: 'default',
  };
}

export function resolveAppContractRegistration({
  appId = DEFAULT_APP_CONTRACT_APP_ID,
  config = null,
  loadConfigImpl = loadConfigCached,
  topPath = DEFAULT_ROLE_TOP_PATH,
  modulePaths = [MODULE_CONFIG_PATH],
  env = process.env,
} = {}) {
  const fallback = defaultRegistration(appId);
  const cfg = config ?? loadConfigImpl({ topPath, modulePaths, env });
  const app = cfg?.get?.(`apps.${appId}`, null);
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    return fallback;
  }

  const sourceKeys = [
    `apps.${appId}.mode`,
    `apps.${appId}.subscribes`,
    `apps.${appId}.contract_version`,
  ];
  const authoritative = sourceKeys.some((key) => isAuthoritativeSource(cfg?.sources?.[key]));
  if (!authoritative) {
    return fallback;
  }

  return {
    app_id: appId,
    mode: String(app.mode || fallback.mode),
    subscribes: Array.isArray(app.subscribes) ? [...app.subscribes] : [...fallback.subscribes],
    contract_version: String(app.contract_version || fallback.contract_version),
    registered: true,
    source: 'apps-registry',
  };
}
