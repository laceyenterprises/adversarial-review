// Money-code: cost-USD derivation for reviewer-pass token rollups. These tests
// pin the pricing math against the vendored rate table (src/vendor/model-pricing.json)
// with hand-computed expected values, verify authoritative ledger cost is never
// overwritten by a derived one, and verify a missing pricing file degrades to
// count-only (no throw).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadReviewerPricingTable,
  deriveReviewerTokenCost,
  deriveReviewerTokenCostUSD,
} from '../src/reviewer-token-pricing.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
} from '../src/reviewer-pass-tokens.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'reviewer-token-pricing-'));
}

// Force the vendored table regardless of ambient AGENT_OS_MODEL_PRICING_FILE.
function vendoredTable() {
  const table = loadReviewerPricingTable({ env: {} });
  assert.ok(table, 'vendored pricing table must load');
  return table;
}

test('pricing math: known model bills reasoning at output rate and tool at input rate', () => {
  const table = vendoredTable();
  // gpt-5.2 rates (usd per 1M): input 1.25, output 10, cache_read 0.625, cache_write 1.25.
  // usage: input 1000, output 200, cacheRead 400, cacheWrite 40, reasoning 50, toolContext 20.
  // reasoning billed at output (10), tool billed at input (1.25):
  //   (1000*1.25 + 200*10 + 400*0.625 + 40*1.25 + 50*10 + 20*1.25) / 1e6
  //   = (1250 + 2000 + 250 + 50 + 500 + 25) / 1e6 = 4075 / 1e6 = 0.004075
  const cost = deriveReviewerTokenCostUSD({
    usage: { input: 1000, output: 200, cacheRead: 400, cacheWrite: 40, reasoning: 50, toolContext: 20 },
    model: 'gpt-5.2',
    pricingTable: table,
  });
  assert.equal(cost, 0.004075);
});

test('pricing math: dated-snapshot suffix resolves to base model by prefix match', () => {
  const table = vendoredTable();
  // claude-opus-4-8 rates: input 5, output 25. A dated suffix resolves to the base.
  //   (100*5 + 10*25) / 1e6 = (500 + 250) / 1e6 = 750 / 1e6 = 0.00075
  const details = deriveReviewerTokenCost({
    usage: { input: 100, output: 10 },
    model: 'claude-opus-4-8-20260101',
    pricingTable: table,
  });
  const cost = deriveReviewerTokenCostUSD({
    usage: { input: 100, output: 10 },
    model: 'claude-opus-4-8-20260101',
    pricingTable: table,
  });
  assert.deepEqual(details, { costUSD: 0.00075, estimated: false });
  assert.equal(cost, 0.00075);
});

test('pricing math: unknown model falls back to the conservative-high fallback rate', () => {
  const table = vendoredTable();
  // fallback rates: input 5, output 25.  (10*5 + 4*25) / 1e6 = 150 / 1e6 = 0.00015
  const details = deriveReviewerTokenCost({
    usage: { input: 10, output: 4 },
    model: 'totally-unknown-model',
    pricingTable: table,
  });
  const cost = deriveReviewerTokenCostUSD({
    usage: { input: 10, output: 4 },
    model: 'totally-unknown-model',
    pricingTable: table,
  });
  assert.deepEqual(details, { costUSD: 0.00015, estimated: true });
  assert.equal(cost, 0.00015);
});

test('pricing math: no positive tokens yields null (not a zero-dollar row)', () => {
  const table = vendoredTable();
  assert.equal(
    deriveReviewerTokenCostUSD({ usage: { input: 0, output: 0 }, model: 'gpt-5.2', pricingTable: table }),
    null,
  );
});

test('pricing math: no pricing table yields null', () => {
  assert.equal(
    deriveReviewerTokenCostUSD({ usage: { input: 10, output: 4 }, model: 'gpt-5.2', pricingTable: null }),
    null,
  );
});

test('loader returns null (never throws) for a missing pricing file', () => {
  const table = loadReviewerPricingTable({
    env: { ADVERSARIAL_REVIEW_MODEL_PRICING_FILE: '/no/such/pricing/file-does-not-exist.json' },
  });
  assert.equal(table, null);
});

test('loader honors the AR-specific env override ahead of the vendored file', () => {
  // Pointing the AR override at a nonexistent path must NOT silently fall
  // through to the vendored table — it degrades to null.
  const table = loadReviewerPricingTable({
    env: {
      ADVERSARIAL_REVIEW_MODEL_PRICING_FILE: '/no/such/ar-override.json',
      AGENT_OS_MODEL_PRICING_FILE: '/no/such/shared-override.json',
    },
  });
  assert.equal(table, null);
});

test('completeReviewerPass derives cost when counts are present but no ledger cost', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 100,
    attemptNumber: 1,
    reviewerClass: 'codex',
    reviewerModel: 'gpt-5.2',
    passKind: 'first-pass',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const row = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 100,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    // gpt-5.2: (1000*1.25 + 200*10) / 1e6 = (1250 + 2000) / 1e6 = 0.00325
    tokenUsage: { input: 1000, output: 200, total: 1200, source: 'codex-transcript' },
    pricingTable: vendoredTable(),
  });

  assert.equal(row.token_cost_usd, 0.00325);
  assert.equal(row.token_source, 'codex-transcript');
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.tokenCostSource, 'derived-pricing');
  assert.equal(metadata.tokenCostEstimated, true);
});

test('completeReviewerPass marks fallback-derived cost as estimated', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 104,
    attemptNumber: 1,
    reviewerClass: 'codex',
    reviewerModel: 'totally-unknown-model',
    passKind: 'first-pass',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const row = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 104,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    // fallback rates: (10*5 + 4*25) / 1e6 = 0.00015
    tokenUsage: { input: 10, output: 4, total: 14, source: 'codex-transcript' },
    pricingTable: vendoredTable(),
  });

  assert.equal(row.token_cost_usd, 0.00015);
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.tokenCostSource, 'derived-pricing');
  assert.equal(metadata.tokenCostEstimated, true);
});

test('completeReviewerPass records ledger cost and never overwrites it with a derived one', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 101,
    attemptNumber: 1,
    reviewerClass: 'codex',
    reviewerModel: 'gpt-5.2',
    passKind: 'first-pass',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const ledgerRow = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 101,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: { input: 1000, output: 200, costUSD: 0.42, source: 'session-ledger' },
    pricingTable: vendoredTable(),
  });
  assert.equal(ledgerRow.token_cost_usd, 0.42);
  const ledgerMetadata = JSON.parse(ledgerRow.metadata_json);
  assert.equal(ledgerMetadata.tokenCostSource, 'ledger-authoritative');
  assert.equal(ledgerMetadata.tokenCostEstimated, false);

  // A later re-complete carrying counts but no cost must NOT clobber 0.42.
  const reRow = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 101,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: { input: 1000, output: 200, source: 'codex-transcript' },
    pricingTable: vendoredTable(),
  });
  assert.equal(reRow.token_cost_usd, 0.42, 'authoritative ledger cost must be preserved');
});

test('completeReviewerPass recalculates previously derived cost on re-complete', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 102,
    attemptNumber: 1,
    reviewerClass: 'codex',
    reviewerModel: 'gpt-5.2',
    passKind: 'first-pass',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const firstRow = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 102,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    // gpt-5.2: (100*1.25 + 20*10) / 1e6 = 0.000325
    tokenUsage: { input: 100, output: 20, total: 120, source: 'codex-transcript' },
    pricingTable: vendoredTable(),
  });
  assert.equal(firstRow.token_cost_usd, 0.000325);
  assert.equal(JSON.parse(firstRow.metadata_json).tokenCostSource, 'derived-pricing');

  const reRow = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 102,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    // gpt-5.2: (2000*1.25 + 400*10) / 1e6 = 0.0065
    tokenUsage: { input: 2000, output: 400, total: 2400, source: 'codex-transcript' },
    pricingTable: vendoredTable(),
  });
  assert.equal(reRow.token_input, 2000);
  assert.equal(reRow.token_output, 400);
  assert.equal(reRow.token_cost_usd, 0.0065, 'derived cost must track updated counts');
  const reMetadata = JSON.parse(reRow.metadata_json);
  assert.equal(reMetadata.tokenCostSource, 'derived-pricing');
  assert.equal(reMetadata.tokenCostEstimated, true);
});

test('completeReviewerPass degrades to count-only when the pricing table is unavailable', () => {
  const rootDir = tempRoot();
  const missingTable = loadReviewerPricingTable({
    env: { ADVERSARIAL_REVIEW_MODEL_PRICING_FILE: '/no/such/pricing/file.json' },
  });
  assert.equal(missingTable, null);
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 103,
    attemptNumber: 1,
    reviewerClass: 'codex',
    reviewerModel: 'gpt-5.2',
    passKind: 'first-pass',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const row = completeReviewerPass(rootDir, {
    repo: 'lacey/repo',
    prNumber: 103,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: { input: 1000, output: 200, total: 1200, source: 'codex-transcript' },
    pricingTable: missingTable,
  });

  assert.equal(row.token_input, 1000);
  assert.equal(row.token_output, 200);
  assert.equal(row.token_cost_usd, null, 'no table -> cost stays null, counts still written');
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'tokenCostSource'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'tokenCostEstimated'), false);
});
