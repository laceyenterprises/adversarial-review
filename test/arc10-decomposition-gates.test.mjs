import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ARC-10 acceptance gates. These enforce that the reviewer monolith stays
// decomposed: the bespoke per-harness spawn families live in reviewer-harness.mjs,
// prompt assembly in reviewer-prompt.mjs, model detection/token parsing in the
// shared reviewer-model-detection.mjs leaf — and never creep back into
// reviewer.mjs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');

const REMOVED_SPAWN_FAMILIES = ['spawnClaude', 'spawnCodexReview', 'spawnGeminiReview', 'spawnAgyReview'];

// Was 4961 lines before ARC-10; a hard ceiling that ratchets down, never up.
// Model execution belongs in reviewer-harness.mjs; prompt assembly in
// reviewer-prompt.mjs. Raising this ceiling means the monolith is regrowing —
// move the code out instead.
const REVIEWER_LINE_CEILING = 2550;

test('ARC-10 gate: reviewer.mjs references none of the removed spawn family names', () => {
  const src = read('reviewer.mjs');
  for (const name of REMOVED_SPAWN_FAMILIES) {
    assert.ok(
      !new RegExp(`\\b${name}\\b`).test(src),
      `reviewer.mjs must not reference ${name} after ARC-10 (it lives in reviewer-harness.mjs).`,
    );
  }
});

test(`ARC-10 gate: reviewer.mjs line count stays <= ${REVIEWER_LINE_CEILING}`, () => {
  const lines = read('reviewer.mjs').split('\n').length;
  assert.ok(
    lines <= REVIEWER_LINE_CEILING,
    `reviewer.mjs has ${lines} lines, exceeding the ${REVIEWER_LINE_CEILING}-line ratchet. `
      + 'Move model-execution code to reviewer-harness.mjs / reviewer-prompt.mjs rather than raising this ceiling.',
  );
});

test('ARC-10 gate: the spawn families are defined exactly once, in reviewer-harness.mjs', () => {
  const harness = read('reviewer-harness.mjs');
  for (const name of REMOVED_SPAWN_FAMILIES) {
    assert.ok(
      new RegExp(`^async function ${name}\\b`, 'm').test(harness),
      `${name} must be defined in reviewer-harness.mjs.`,
    );
  }
});

test('ARC-10 gate: codex model detection + token parsing are deduped into the shared leaf', () => {
  const cliDirect = read('adapters/reviewer-runtime/cli-direct/index.mjs');
  assert.ok(
    cliDirect.includes("from '../../../reviewer-model-detection.mjs'"),
    'cli-direct must import detection/token-parse from the shared reviewer-model-detection.mjs leaf.',
  );
  assert.ok(
    !/^function (isCodexModel|isGeminiModel|parseCodexJsonTokenUsage|parseCodexJsonTokenUsageFromFailureStdout)\b/m.test(cliDirect),
    'cli-direct must not redefine the detection/token-parse helpers (they are deduped into the leaf).',
  );
});

test('ARC-10 fixture parity: dispatchReviewerModel yields the canonical review shape per model', async () => {
  const { dispatchReviewerModel } = await import('../src/reviewer-harness.mjs');

  const claude = await dispatchReviewerModel('claude', 'DIFF', 'CTX', {
    reviewWithClaudeImpl: async () => ({ reviewText: '## Verdict\nApprove', tokenUsage: { total: 5 } }),
  });
  assert.equal(claude.needsSanitize, false);
  assert.equal(claude.rawReviewText, '## Verdict\nApprove');
  assert.deepEqual(claude.tokenUsage, { total: 5 });

  const codex = await dispatchReviewerModel('codex', 'DIFF', 'CTX', {
    reviewWithCodexImpl: async () => ({ reviewText: 'raw codex output', tokenUsage: null }),
  });
  assert.equal(codex.needsSanitize, true);
  assert.equal(codex.reviewText, null);
  assert.equal(codex.rawReviewText, 'raw codex output');

  const gemini = await dispatchReviewerModel('gemini', 'DIFF', 'CTX', {
    reviewWithGeminiImpl: async () => ({ reviewText: '## Verdict\nComment only', tokenUsage: { total: 2 } }),
  });
  assert.equal(gemini.needsSanitize, false);
  assert.equal(gemini.rawReviewText, '## Verdict\nComment only');
  assert.deepEqual(gemini.tokenUsage, { total: 2 });
});
