// Reviewer-pass token cost derivation over a committed model-pricing table.
//
// PROVENANCE / DRIFT-SYNC:
//   The rate data in src/vendor/model-pricing.json is a VENDORED COPY of the
//   canonical Agent OS pricing table at
//     modules/token-budget/model-pricing.json
//   (curated + PR-reviewed under hard-cost-caps SPEC §5). adversarial-review is
//   a standalone submodule that cannot import from the parent `modules/` tree at
//   runtime on OSS / portable installs, so the table is vendored here for
//   self-contained packaging. Keeping the two files byte-identical makes drift
//   detection a plain diff; an automated drift-sync check is a follow-up.
//
// This module is a MINIMAL, self-contained port of the loader + pricing math in
//   modules/agent-observability/runtime/scripts/model-pricing.mjs
// (PricingTable / validatePricing / loadPricingTable). Behavior is intentionally
// identical: rates are USD per 1M tokens, reasoning is billed at the output rate
// and tool-context at the input rate, and a bad/missing pricing file degrades to
// null (never throws) so the reviewer-pass rollup falls back to count-only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// src/ -> src/vendor/model-pricing.json
const VENDORED_PRICING_FILE = path.join(THIS_DIR, 'vendor', 'model-pricing.json');

const RATE_KEYS = ['input', 'output', 'cache_read', 'cache_write'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRate(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} must be an object`);
  const rate = {};
  for (const key of RATE_KEYS) {
    const raw = value[key];
    if (!isFiniteNumber(raw) || raw < 0) {
      throw new Error(`${label}.${key} must be a non-negative number`);
    }
    rate[key] = raw;
  }
  rate.estimated = value.estimated === true;
  return rate;
}

class PricingTable {
  constructor({ fallback, models }) {
    this.fallback = fallback;
    this.models = models;
    // Longest known-id prefix first, so dated-snapshot suffixes resolve to
    // their base model deterministically.
    this._prefixKeys = Object.keys(models).sort((a, b) => b.length - a.length);
  }

  rateFor(model) {
    if (typeof model === 'string' && model) {
      const exact = this.models[model];
      if (exact) return exact;
      for (const key of this._prefixKeys) {
        if (model.startsWith(`${key}-`)) return this.models[key];
      }
    }
    return this.fallback;
  }

  // deltas: {input, output, cache_read, cache_write, reasoning, tool}
  // reasoning is billed at the output rate, tool at the input rate.
  costUsd(model, deltas = {}) {
    const rate = this.rateFor(model);
    const n = (v) => (isFiniteNumber(v) && v > 0 ? v : 0);
    const micros =
      n(deltas.input) * rate.input +
      n(deltas.output) * rate.output +
      n(deltas.cache_read) * rate.cache_read +
      n(deltas.cache_write) * rate.cache_write +
      n(deltas.reasoning) * rate.output +
      n(deltas.tool) * rate.input;
    return micros / 1_000_000;
  }
}

function validatePricing(data) {
  if (!data || typeof data !== 'object') throw new Error('pricing table must be an object');
  if (data.schemaVersion !== 1) throw new Error(`unsupported schemaVersion: ${data.schemaVersion}`);
  if (data.unit !== 'usd_per_1m_tokens') throw new Error(`unexpected unit: ${data.unit}`);
  const fallback = normalizeRate(data.fallback, 'fallback');
  if (!fallback.estimated) throw new Error('fallback.estimated must be true');
  if (!data.models || typeof data.models !== 'object' || !Object.keys(data.models).length) {
    throw new Error("pricing table 'models' must be a non-empty object");
  }
  const models = {};
  for (const [id, rate] of Object.entries(data.models)) {
    if (!id) throw new Error('model ids must be non-empty');
    models[id] = normalizeRate(rate, `models[${id}]`);
  }
  return new PricingTable({ fallback, models });
}

// Load the pricing table for reviewer-pass cost derivation. Resolution order:
//   1. explicit `file` argument (tests / callers with a pinned path)
//   2. env.ADVERSARIAL_REVIEW_MODEL_PRICING_FILE (AR-specific override)
//   3. env.AGENT_OS_MODEL_PRICING_FILE (shared Agent OS override)
//   4. the vendored src/vendor/model-pricing.json
// Returns null (never throws) when the file is missing or invalid, so a bad
// pricing file degrades the rollup to count-only rather than crashing a write.
function loadReviewerPricingTable({ file = null, env = process.env } = {}) {
  const resolved = file
    || env?.ADVERSARIAL_REVIEW_MODEL_PRICING_FILE
    || env?.AGENT_OS_MODEL_PRICING_FILE
    || VENDORED_PRICING_FILE;
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return validatePricing(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Map adversarial-review's normalized usage shape
//   {input, output, cacheRead, cacheWrite, reasoning, toolContext}
// onto the pricing table's delta shape and return a non-negative USD cost, or
// null when there is no pricing table or no positive billable tokens.
function deriveReviewerTokenCostUSD({ usage, model, pricingTable } = {}) {
  if (!pricingTable || !usage || typeof usage !== 'object') return null;
  const deltas = {
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    reasoning: usage.reasoning,
    tool: usage.toolContext,
  };
  const positive = (v) => (isFiniteNumber(v) && v > 0 ? v : 0);
  const billableTokens =
    positive(deltas.input) +
    positive(deltas.output) +
    positive(deltas.cache_read) +
    positive(deltas.cache_write) +
    positive(deltas.reasoning) +
    positive(deltas.tool);
  if (billableTokens <= 0) return null;
  const cost = pricingTable.costUsd(model, deltas);
  return isFiniteNumber(cost) && cost >= 0 ? cost : null;
}

export {
  PricingTable,
  validatePricing,
  loadReviewerPricingTable,
  deriveReviewerTokenCostUSD,
  VENDORED_PRICING_FILE,
};
