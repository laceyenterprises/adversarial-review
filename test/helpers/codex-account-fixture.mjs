import { exportedReserveFloors } from './reserve-floor-fixture.mjs';

export function codexAccountFixture({ corp = 'ok', primary = 'ok', corpReady = true } = {}) {
  const floors = exportedReserveFloors();
  return {
    providerStatuses: [
      { provider: 'openai', authPath: 'oauth', state: primary },
      { provider: 'openai', authPath: 'oauth-corp', state: corp },
      { provider: 'google', authPath: 'oauth', state: 'ok' },
    ],
    reserveFloors: {
      'openai-oauth': floors['openai-oauth'],
      'openai-oauth-corp': floors['openai-oauth-corp'],
    },
    brokerAuth: { provider_states: {
      codex: { ready: true, can_serve: true },
      'codex-corp': { ready: corpReady, can_serve: corpReady },
    } },
  };
}

// Legacy routing scenarios explicitly cap corporate and admit primary, so
// provider-family behavior remains independent of the new account preference.
export function fleetStatusWithCodexAccountEvidence(payload) {
  const fixture = codexAccountFixture({ corp: 'exhausted' });
  return { ...payload,
    providerStatuses: [...(payload.providerStatuses || []),
      ...(payload.providerStatuses?.some(row => row.provider === 'openai' && row.authPath === 'oauth-corp')
        ? [] : [fixture.providerStatuses[1]])],
    reserveFloors: { ...fixture.reserveFloors, ...payload.reserveFloors },
    brokerAuth: { ...payload.brokerAuth, provider_states: { ...fixture.brokerAuth.provider_states,
      ...payload.brokerAuth?.provider_states } },
  };
}
