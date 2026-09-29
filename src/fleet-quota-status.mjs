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
  gemini: 'google',
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

// AFH-02 soft-grounding (agent-os #4999). Beside — never instead of — the hard
// `state` above, each `providerStatuses[]` row carries an `afhGrounding` verdict
// computed by `cwp_dispatch/afh_soft_grounding.py`: a provider is SOFT-grounded
// when it has sustained (>= DEFAULT_SAME_REASON_THRESHOLD) `provider_quota_
// exhausted` kills since its last good probe, or a suspended-LRQ depth at the
// same threshold. That is the flapping/soft outage the hard 429 classifier
// misses (probe state stays `unknown`), and it clears on its own once the
// provider recovers.
//
// This module only READS that verdict — the signal is derived once, in Python,
// so Node and Python can never drift (SPEC §6). Anything we cannot read as a
// definite boolean verdict is NOT soft-grounded: a null/absent/malformed
// `afhGrounding` fails open to the primary, exactly like an ambiguous hard
// state.
//
// Shape (the first four keys are the consumed contract; the two counts travel
// alongside so an audit can say *why*):
//
//   { grounded, signals, threshold, reason, quotaExhaustedKills, suspendedLrqDepth }
//
// The verdict is `null` when AFH-02 could not read the ledger for that provider
// (its documented fail-open degradation) and absent entirely on an `hq` build
// that predates AFH-02. Both cases normalize to `null` here, which every
// consumer must read as "no soft signal" — never as "grounded".
//
// Missing telemetry must stay missing. `Number()` coerces `null`, `false`, `''`
// and whitespace-only strings to `0`, which would rewrite "unknown" as an
// observed zero count (e.g. 0 quota-exhausted kills) in the soft-verdict audit
// trail and mislead an operator investigating a soft grounding. Accept only a
// real number or a numeric string; everything else normalizes to `null`.
function normalizedCount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProviderKey(provider) {
  return String(provider || '').trim().toLowerCase();
}

// Normalize one row's `afhGrounding`. Returns null (→ fail open) unless the
// payload is an object carrying a real boolean `grounded`; a truthy-string or
// missing verdict is treated as unreadable, never as grounded.
export function normalizeAfhGroundingVerdict(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // A verdict without a boolean `grounded` is not a verdict — fail open rather
  // than coercing a string/number into a routing decision.
  if (typeof raw.grounded !== 'boolean') return null;
  return Object.freeze({
    grounded: raw.grounded,
    signals: normalizedCount(raw.signals),
    threshold: normalizedCount(raw.threshold),
    reason: raw.reason === undefined || raw.reason === null ? null : String(raw.reason),
    quotaExhaustedKills: normalizedCount(raw.quotaExhaustedKills ?? raw.quota_exhausted_kills),
    suspendedLrqDepth: normalizedCount(raw.suspendedLrqDepth ?? raw.suspended_lrq_depth),
  });
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

// REMFALLBACK-01: model-level quota. The openai/oauth row carries `models[]`,
// one entry per probed governed Codex model. When every probed model is
// exhausted the probe projects the provider row as `unknown` with
// `lastErrorSignature: model_only_exhaustion`; the hard classifier above never
// grounds `unknown`, so a model-only cap is invisible without these fields.
export const MODEL_ONLY_EXHAUSTION_SIGNATURE = 'model_only_exhaustion';

function normalizeModelRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && String(entry.model || '').trim())
    .map((entry) => ({
      model: String(entry.model).trim(),
      state: String(entry.state || '').trim().toLowerCase(),
      resetAtUtc: entry.resetAtUtc || entry.reset_at_utc || null,
      lastGoodAt: entry.lastGoodAt || entry.last_good_at || null,
    }));
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
    lastErrorSignature: entry?.lastErrorSignature || entry?.last_error_signature || null,
    resetAtUtc: entry?.resetAtUtc || entry?.reset_at_utc || null,
    models: normalizeModelRows(entry?.models),
    afhGrounding: normalizeAfhGroundingVerdict(entry?.afhGrounding ?? entry?.afh_grounding),
  }));
}

// Rows for one provider, OAuth-first (the auth path a native-harness spawn
// actually uses), then any other auth path for the same provider.
function providerStatusRows(statuses, normalizedProvider) {
  const rows = statuses.filter((entry) => entry.provider === normalizedProvider);
  return [...rows.filter((entry) => entry.authPath === 'oauth'), ...rows.filter((entry) => entry.authPath !== 'oauth')];
}

// Availability of a specific PROVIDER (openai/anthropic/…) from rows ALREADY
// parsed by `parseHqFleetQuotaStatus`. Callers that read several providers out
// of one payload (the closer's fallback-candidate loop) parse once and query
// this repeatedly, instead of re-parsing the identical stdout per lookup.
// Prefers the OAuth auth-path status (the path a native-harness spawn actually
// uses) and falls back to any status for that provider. Returns { available,
// state, source, checkedAt, afhGrounding } where `available` is strictly
// `state === 'ok'` — the soft verdict rides alongside without touching it.
export function providerAvailabilityFromStatuses(statuses, { provider } = {}) {
  const normalizedProvider = normalizeProviderKey(provider);
  if (!normalizedProvider) {
    return { available: false, state: 'unknown-provider', source: 'hq-fleet-quota-status', afhGrounding: null };
  }
  const rows = providerStatusRows(Array.isArray(statuses) ? statuses : [], normalizedProvider);
  const status = rows[0];
  if (!status) {
    return { available: false, state: 'missing-provider-status', source: 'hq-fleet-quota-status', afhGrounding: null };
  }
  return {
    available: status.state === 'ok',
    state: status.state || 'unknown',
    source: 'hq-fleet-quota-status',
    checkedAt: status.lastProbeAt || null,
    // AFH-02 soft verdict rides alongside; `available`/`state` keep their exact
    // pre-AFH hard semantics so existing HHR consumers are unchanged.
    afhGrounding: status.afhGrounding || null,
  };
}

// Single-lookup convenience wrapper: parse the raw `hq fleet quota status
// --json` stdout, then answer from the parsed rows. The unknown-provider guard
// stays AHEAD of the parse so a provider-less call keeps returning that verdict
// rather than throwing on a payload it never needed to read.
export function providerAvailabilityFromFleetStatus(stdout, options = {}) {
  if (!normalizeProviderKey(options?.provider)) {
    return providerAvailabilityFromStatuses([], options);
  }
  return providerAvailabilityFromStatuses(parseHqFleetQuotaStatus(stdout), options);
}

// AFH-02 soft-grounding verdict for a specific PROVIDER, read (never re-derived)
// from the `afhGrounding` projection on `hq fleet quota status --json`.
//
// Returns { grounded, verdict, reason, source }. `grounded` is true ONLY when a
// row for this provider carries a readable verdict whose `grounded` is boolean
// true. Every other shape — provider absent, `afhGrounding: null` (the Python
// side's own fail-open when the kill ledger is unreadable), a non-object, or a
// non-boolean `grounded` — returns false with a reason naming which, so the
// caller keeps its primary instead of guessing.
export function providerSoftGroundingFromStatuses(statuses, { provider } = {}) {
  const normalizedProvider = normalizeProviderKey(provider);
  const source = 'hq-fleet-quota-status';
  if (!normalizedProvider) {
    return { grounded: false, verdict: null, reason: 'unknown-provider', source };
  }
  const rows = providerStatusRows(Array.isArray(statuses) ? statuses : [], normalizedProvider);
  if (rows.length === 0) {
    return { grounded: false, verdict: null, reason: 'missing-provider-status', source };
  }
  // The verdict is per-provider, so any row that carries a readable one speaks
  // for the provider; OAuth-first only decides which to quote in the audit.
  const verdict = rows.map((entry) => entry.afhGrounding).find((entry) => entry !== null) || null;
  if (!verdict) {
    return { grounded: false, verdict: null, reason: 'afh-grounding-unreadable', source };
  }
  return {
    grounded: verdict.grounded === true,
    verdict,
    reason: verdict.grounded === true ? (verdict.reason || 'soft-grounded') : 'not-soft-grounded',
    source,
  };
}

// Single-lookup convenience wrapper over the parsed-rows reader above, with the
// same pre-parse unknown-provider guard.
export function providerSoftGroundingFromFleetStatus(stdout, options = {}) {
  if (!normalizeProviderKey(options?.provider)) {
    return providerSoftGroundingFromStatuses([], options);
  }
  return providerSoftGroundingFromStatuses(parseHqFleetQuotaStatus(stdout), options);
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

// REMFALLBACK-01 cap verdict for one harness and, optionally, the model it would
// run. Capped, in precedence order, when the provider is hard-grounded, when the
// routed model is itself exhausted (its `models[]` row, or the provider's
// `model_only_exhaustion` signature when that model has no row of its own), or
// when AFH-02 soft-grounds the provider. `available` keeps the strict
// "confirmed quota" meaning: not capped, provider `ok`, and the model row `ok`
// when one exists. Anything unreadable is neither capped nor available.
export function harnessCapFromStatuses(statuses, { harness, model = null } = {}) {
  const source = 'hq-fleet-quota-status';
  const provider = providerForQuotaHarness(harness);
  if (!provider) return { capped: false, capSource: null, available: false, state: 'unknown-harness', source };
  const rows = providerStatusRows(Array.isArray(statuses) ? statuses : [], provider);
  const row = rows[0];
  if (!row) return { capped: false, capSource: null, available: false, state: 'missing-provider-status', source };
  const modelName = String(model || '').trim() || null;
  const modelRow = modelName
    ? rows.flatMap((entry) => entry.models || []).find((entry) => entry.model === modelName) || null
    : null;
  const modelExhausted = modelRow
    ? isGroundedProviderState(modelRow.state)
    : row.lastErrorSignature === MODEL_ONLY_EXHAUSTION_SIGNATURE;
  const soft = providerSoftGroundingFromStatuses(statuses, { provider });
  const capSource = isGroundedProviderState(row.state)
    ? 'provider-grounded'
    : modelExhausted
      ? 'model-exhausted'
      : soft.grounded
        ? 'afh-soft-grounded'
        : null;
  return {
    capped: capSource !== null,
    capSource,
    available: capSource === null && row.state === 'ok' && (!modelRow || modelRow.state === 'ok'),
    state: row.state || 'unknown',
    model: modelName,
    modelState: modelRow?.state || null,
    resetAt: modelRow?.resetAtUtc || row.resetAtUtc || null,
    lastGoodAt: modelRow?.lastGoodAt || row.lastGoodAt || null,
    afhGrounding: soft.verdict,
    source,
  };
}

export function harnessCapFromFleetStatus(stdout, options = {}) {
  if (!providerForQuotaHarness(options?.harness)) return harnessCapFromStatuses([], options);
  return harnessCapFromStatuses(parseHqFleetQuotaStatus(stdout), options);
}
