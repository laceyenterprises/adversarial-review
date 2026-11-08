// Synthetic producer-shaped evidence: probe succeeds on credits, plan is full.
export function exhaustedCodexPlanRow(authPath = 'oauth') {
  return {
    provider: 'openai', authPath, state: 'ok', resetAtUtc: null,
    providerRateLimits: [{
      limitId: 'codex', windowMinutes: 10080, usedPercent: 100, fresh: true,
      observedAt: new Date().toISOString(), ageSeconds: 0,
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
      credits: { has_credits: true },
    }],
  };
}
