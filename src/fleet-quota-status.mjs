// Shared HHR (harness rate-limit resilience) fleet-quota provider-state reader.
//
// Single source of truth for parsing `hq fleet quota status --json` and mapping
// a harness/provider onto its authoritative quota availability. The HHR/HRR
// quota-probe daemon writes each provider's grounded/ok state (per
// cwp_quota_probe: `ok` | `exhausted` | `degraded` | `unknown`) and
// `hq fleet quota status --json` surfaces it as `providerStatuses`.
//
// Two in-module consumers share this classifier so cap detection stays
// consistent (extend, don't fork):
//   - follow-up-remediation.mjs — quota-hold revalidation for the
//     reviewer/remediator worker classes.
//   - ama/harness-fallback.mjs — closer/hammer harness fallback: a codex-capped
//     hammer must fall back to an available harness instead of a doomed spawn.

// Provider whose OAuth quota gates a given quota harness family. Mirrors the
// SUPPORTED_PROVIDER_AUTH_TUPLES the quota probe daemon tracks (anthropic /
// openai). Kept in sync with the closer worker-class map in
// ama/harness-fallback.mjs.
export const QUOTA_HARNESS_PROVIDER = Object.freeze({
  codex: 'openai',
  claude: 'anthropic',
  'claude-code': 'anthropic',
});

export function providerForQuotaHarness(harness) {
  return QUOTA_HARNESS_PROVIDER[String(harness || '').trim().toLowerCase()] || null;
}

// Provider states that mean the harness is AUTHORITATIVELY grounded and cannot
// spawn — a fallback is warranted. `degraded` / `unknown` / any missing status
// are deliberately NOT grounded: they are ambiguous, and HHR's contract is to
// never classify a cap from a non-authoritative signal ("do not guess"). Only a
// definite exhausted/suspended provider state grounds the harness.
export const GROUNDED_PROVIDER_STATES = new Set(['exhausted', 'suspended', 'grounded']);

export function isGroundedProviderState(state) {
  return GROUNDED_PROVIDER_STATES.has(String(state || '').trim().toLowerCase());
}

function extractJsonObject(text, label) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error(`${label} produced empty output`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`${label} did not return JSON`);
  }
}

export function parseHqFleetQuotaStatus(stdout) {
  const payload = extractJsonObject(stdout, 'hq fleet quota status');
  const providerStatuses = Array.isArray(payload?.providerStatuses) ? payload.providerStatuses : [];
  return providerStatuses.map((entry) => ({
    provider: String(entry?.provider || '').trim().toLowerCase(),
    authPath: String(entry?.authPath || entry?.auth_path || '').trim().toLowerCase(),
    state: String(entry?.state || '').trim().toLowerCase(),
    source: entry?.source || 'hq-fleet-quota-status',
    lastGoodAt: entry?.lastGoodAt || entry?.last_good_at || null,
    lastProbeAt: entry?.lastProbeAt || entry?.last_probe_at || null,
  }));
}

// Availability of a specific PROVIDER (openai/anthropic/…). Prefers the OAuth
// auth-path status (the path a native-harness spawn actually uses) and falls
// back to any status for that provider. Returns { available, state, source,
// checkedAt } where `available` is strictly `state === 'ok'`.
export function providerAvailabilityFromFleetStatus(stdout, { provider } = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) {
    return { available: false, state: 'unknown-provider', source: 'hq-fleet-quota-status' };
  }
  const statuses = parseHqFleetQuotaStatus(stdout);
  const status = statuses.find((entry) => entry.provider === normalizedProvider && entry.authPath === 'oauth')
    || statuses.find((entry) => entry.provider === normalizedProvider);
  if (!status) {
    return { available: false, state: 'missing-provider-status', source: 'hq-fleet-quota-status' };
  }
  return {
    available: status.state === 'ok',
    state: status.state || 'unknown',
    source: 'hq-fleet-quota-status',
    checkedAt: status.lastProbeAt || null,
  };
}

// Availability keyed by the quota HARNESS family (codex/claude/claude-code).
// Retained for the reviewer/remediator quota-hold revalidator that already
// speaks in harness terms.
export function quotaAvailableFromFleetStatus(stdout, { harness } = {}) {
  const provider = providerForQuotaHarness(harness);
  if (!provider) {
    return { available: false, state: 'unknown-harness', source: 'hq-fleet-quota-status' };
  }
  return providerAvailabilityFromFleetStatus(stdout, { provider });
}
