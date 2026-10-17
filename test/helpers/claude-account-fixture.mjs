export function claudeAccountFixture({ corp = 'ok', primary = 'ok', corpNearCap = false,
  primaryNearCap = false, corpReady = true, primaryReady = true } = {}) {
  const policy = nearCap => ({ active: false, paused: false, nearCap,
    weeklyMeasurement: { status: 'measured', percentRemaining: nearCap ? 5 : 80 } });
  return {
    providerStatuses: [
      { provider: 'anthropic', authPath: 'oauth', state: primary },
      { provider: 'anthropic', authPath: 'oauth-corp', state: corp },
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
    ],
    reserveFloors: { 'anthropic-oauth': policy(primaryNearCap), 'anthropic-oauth-corp': policy(corpNearCap) },
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
  return fixture;
}
