import { exportedReserveFloors } from './reserve-floor-fixture.mjs';
import { fleetStatusWithCodexAccountEvidence } from './codex-account-fixture.mjs';
export function claudeAccountFixture({ corp = 'ok', primary = 'ok', corpNearCap = false,
  primaryNearCap = false, corpReady = true, primaryReady = true } = {}) {
  const floors = exportedReserveFloors();
  // Near-cap scenarios are explicit consumer policy mutations of the capture.
  for (const [key, nearCap] of [['anthropic-oauth', primaryNearCap], ['anthropic-oauth-corp', corpNearCap]]) {
    if (nearCap) {
      floors[key].nearCap = true;
      floors[key].weeklyMeasurement.percentRemaining = 5;
    }
  }
  return {
    providerStatuses: [
      { provider: 'anthropic', authPath: 'oauth', state: primary },
      { provider: 'anthropic', authPath: 'oauth-corp', state: corp },
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
    ],
    reserveFloors: { 'anthropic-oauth': floors['anthropic-oauth'], 'anthropic-oauth-corp': floors['anthropic-oauth-corp'] },
    brokerAuth: { provider_states: {
      'claude-code': { ready: primaryReady, can_serve: primaryReady },
      'claude-code-corp': { ready: corpReady, can_serve: corpReady },
    } },
  };
}

// Legacy routing tests supply provider rows. Give those scenarios explicit
// primary-account admission evidence while keeping the corporate lane capped.
export function fleetStatusWithClaudeAccountEvidence(rows) {
  const fixture = claudeAccountFixture({ corp: 'exhausted' });
  fixture.providerStatuses = [
    ...rows,
    { provider: 'anthropic', authPath: 'oauth-corp', state: 'exhausted' },
  ];
  return fleetStatusWithCodexAccountEvidence(fixture);
}
