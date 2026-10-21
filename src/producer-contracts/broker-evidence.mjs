const producer = 'oauth_broker.server.readyz';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read wire evidence; callers choose readiness versus token serviceability.
 * Explicit values and legacy booleans stay separate to preserve caller policy.
 * @returns {{ready: unknown, canServe: unknown, legacyReady: unknown, diagnostics: string[]}}
 */
export function readBrokerProvider(payload, provider) {
  const path = `provider_states.${provider}`;
  const state = payload?.provider_states?.[provider];
  const legacyReady = payload?.providers?.[provider];
  const diagnostics = [];
  if (!object(payload)) diagnostics.push(`${producer}: $ missing/invalid object`);
  if (!object(state)) diagnostics.push(`${producer}: ${path} missing/invalid object${(Array.isArray(payload?.disabled_providers) && payload.disabled_providers.includes(provider)) ? '; disabled_providers includes provider' : ''}`);
  else {
    for (const key of ['ready', 'can_serve']) {
      if (typeof state[key] !== 'boolean') diagnostics.push(`${producer}: ${path}.${key} missing/invalid boolean`);
      else if (!state[key]) diagnostics.push(`${producer}: ${path}.${key}=false`);
    }
    if (state.state != null && !['ready', 'degraded', 'not_ready'].includes(state.state)) {
      diagnostics.push(`${producer}: ${path}.state unrecognized ${JSON.stringify(state.state)}`);
    }
  }
  return { ready: state?.ready, canServe: state?.can_serve, legacyReady, diagnostics };
}
