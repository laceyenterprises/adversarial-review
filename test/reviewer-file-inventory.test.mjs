import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReviewerFileInventory } from '../src/reviewer-file-inventory.mjs';
import { buildPromptForReviewerModel, buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';
import { reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { parseBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';

const incident = JSON.parse(readFileSync(new URL('./fixtures/reviewer-file-inventory/lacey-web-37.json', import.meta.url)));
const { headSha } = incident;
const paths = incident.presentEntries.map(entry => entry.path);
// This is a selected-path fixture, not a complete copy of the incident tree.
const tree = { truncated: false, tree: paths.map(path => ({ path, type: 'blob' })) };

test('exact-head inventory survives stale scope prose and a partial final diff', async () => {
  const context = await loadReviewerFileInventory({
    repo: 'fixture/app', headSha,
    execGhWithRetryImpl: async ({ args }) => {
      assert.equal(args.at(-1), `repos/fixture/app/git/trees/${headSha}?recursive=1`);
      return { stdout: JSON.stringify(tree) };
    },
  });
  for (const path of paths) assert.ok(context.includes(JSON.stringify(path)));
  assert.match(context, /complete; present paths/);
  assert.match(context, /compare literal paths against this commit tree/);
  const prompt = buildPromptForReviewerModel('gemini',
    'diff --git a/src/cms/admin/studio/widget-review.tsx b/src/cms/admin/studio/widget-review.tsx\n@@ -1 +1 @@\n+import "../../../widgets/kit/source-check.mjs";',
    'Scope expansions: src/widgets/kit/check.mjs; src/migrations/20261117_150000_studio_widgets.json\n' + context,
    { promptStage: 'last', runtime: 'antigravity' });
  assert.match(prompt, /Never infer global file absence/);
  assert.match(prompt, /validator.*exact head/);
  assert.match(prompt, /default-checkout snapshot may differ from the reviewed commit/);
  assert.match(prompt, new RegExp(headSha));
});

test('truncated, capped, failed and missing-head inventories never authorize absence', async () => {
  for (const options of [
    { execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({ ...tree, truncated: true }) }) },
    { execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({
      truncated: false, tree: [{ path: 'vendor/app', type: 'commit' }],
    }) }) },
    { maxBytes: 1, execGhWithRetryImpl: async () => ({ stdout: JSON.stringify(tree) }) },
    { execGhWithRetryImpl: async () => { throw new Error('offline'); } },
    { execGhWithRetryImpl: async () => ({ stdout: '{"tree":null}' }) },
    { headSha: null, execGhWithRetryImpl: async () => { assert.fail('must not read mutable HEAD'); } },
  ]) {
    const context = await loadReviewerFileInventory({ repo: 'fixture/app', headSha, log: { warn() {} }, ...options });
    assert.match(context, /unavailable|partial/);
    assert.match(context, /Omission does not prove absence/);
  }
});

test('inventory propagates budget deferral and rejects symbolic refs', async () => {
  const error = Object.assign(new Error('deferred'), { budgetDeferred: true });
  await assert.rejects(loadReviewerFileInventory({
    repo: 'fixture/app', headSha, execGhWithRetryImpl: async () => { throw error; },
  }), error);
  const context = await loadReviewerFileInventory({
    repo: 'fixture/app', headSha: 'main',
    execGhWithRetryImpl: async () => { assert.fail('symbolic ref is not exact-head evidence'); },
  });
  assert.match(context, /unavailable/);
});

test('eight final chunks share exact-head evidence and retain a genuine actionable finding', async () => {
  const diff = Array.from({ length: 8 }, (_, index) => [
    `diff --git a/src/part${index}.mjs b/src/part${index}.mjs`,
    'new file mode 100644', '--- /dev/null', `+++ b/src/part${index}.mjs`,
    '@@ -0,0 +1,8 @@',
    ...Array.from({ length: 8 }, () => `+export const value = "${'x'.repeat(420)}";`),
    '',
  ].join('\n')).join('');
  const inventory = await loadReviewerFileInventory({
    repo: incident.repo, headSha, diff,
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify(tree) }),
  });
  const context = 'Scope expansions: src/widgets/kit/check.mjs\n' + inventory;
  const overhead = Buffer.byteLength(buildPromptForReviewerModel('gemini', '', context,
    { promptStage: 'last', runtime: 'antigravity' }));
  let calls = 0;
  const result = await reviewAgyOversizedInChunks(diff, context, {
    promptStage: 'last', maxBytes: overhead + 6000,
    env: { ADVERSARIAL_REVIEWER_TIMEOUT_MS: '1000', ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1000' },
    reviewWithGeminiImpl: async (chunk, chunkContext, options) => {
      calls++;
      assert.equal(options.promptStage, 'last');
      const prompt = buildPromptForReviewerModel('gemini', chunk, chunkContext,
        { promptStage: 'last', runtime: 'antigravity' });
      assert.ok(Buffer.byteLength(prompt) <= overhead + 6000);
      for (const path of paths) assert.ok(prompt.includes(JSON.stringify(path)));
      assert.match(prompt, /Never infer global file absence/);
      return { reviewText: [
        '## Blocking issues',
        calls === 1 ? [
          '- **Server approval accepts failing checks**',
          '  - **File:** `src/part0.mjs`',
          '  - **Lines:** `1-1`',
          '  - **Problem:** Direct approval accepts checks=false and marks the widget approved.',
          '  - **Why it matters:** The API bypasses the UI gate.',
          '  - **Recommended fix:** Validate passing checks before changing state.',
        ].join('\n') : '- None.',
        '## Non-blocking issues', '- None.', '## Suggested fixes', '- None.',
        '## Verdict', calls === 1 ? 'Request changes' : 'Comment only',
      ].join('\n') };
    },
  });
  assert.equal(calls, 8);
  assert.equal(parseBlockingFindingsSection(result.reviewText).length, 1);
  assert.equal(extractReviewVerdict(result.reviewText), 'Request changes');
});

test('budgeting prioritizes changed head paths without making omitted paths negative evidence', async () => {
  const path = paths[2];
  const context = await loadReviewerFileInventory({
    repo: incident.repo, headSha, maxBytes: Buffer.byteLength(JSON.stringify(path)) + 1,
    diff: `diff --git a/old.mjs b/${path}\nsimilarity index 100%\nrename from old.mjs\nrename to ${path}\n`,
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({
      truncated: false, tree: [{ path: 'aaa/unrelated.mjs', type: 'blob' }, ...tree.tree],
    }) }),
  });
  assert.ok(context.includes(JSON.stringify(path)));
  assert.match(context, /partial/);
  assert.doesNotMatch(context, /"aaa\/unrelated.mjs"/);
});

test('inventory stops serializing paths when fewer than three bytes remain', async t => {
  const stdout = JSON.stringify({
    truncated: false,
    tree: ['a', 'bb', 'ccc'].map(path => ({ path, type: 'blob' })),
  });
  const stringify = JSON.stringify;
  const serialized = [];
  t.mock.method(JSON, 'stringify', value => {
    if (typeof value === 'string') serialized.push(value);
    return stringify(value);
  });
  for (const remaining of [0, 1, 2]) {
    serialized.length = 0;
    const context = await loadReviewerFileInventory({
      repo: incident.repo, headSha, maxBytes: 4 + remaining,
      execGhWithRetryImpl: async () => ({ stdout }),
    });
    assert.deepEqual(serialized, ['a']);
    assert.match(context, /partial; present paths/);
    assert.match(context, /Omission does not prove absence/);
    assert.ok(context.endsWith('"a"\n'));
  }
});

test('inventory still fits shorter paths after skipping a path that exceeds the remaining budget', async () => {
  const context = await loadReviewerFileInventory({
    repo: incident.repo, headSha, maxBytes: 5,
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({
      truncated: false,
      tree: ['aaaa', 'bb'].map(path => ({ path, type: 'blob' })),
    }) }),
  });
  assert.match(context, /partial; present paths/);
  assert.ok(context.endsWith('"bb"\n'));
  assert.doesNotMatch(context, /"aaaa"/);
});

test('full, slim and public context assembly retain the same immutable inventory', async () => {
  for (const mode of ['full', 'slim', 'public']) {
    const context = await buildReviewerExtraContext({
      repo: 'fixture/app', prNumber: 37,
      prContext: { headRefOid: headSha, body: 'Old scope paths are historical.' },
      fileInventoryContext: `\nExact inventory ${headSha}\n`,
      reviewModeDecision: mode === 'slim'
        ? { slim: true, lowRiskClasses: ['docs'], stats: { files: 1, added: 1, removed: 0 } } : null,
      getConfigImpl: () => mode === 'public' ? ['fixture/app'] : [],
      readTenureReviewRangeImpl: () => null,
      readFindingDisputeReservationsImpl: () => [],
      fetchLinkedSpecContentsImpl: async () => '',
      buildHardeningReviewContextImpl: async () => '',
      log: { error() {}, warn() {} },
    });
    assert.match(context, new RegExp(`Exact inventory ${headSha}`));
  }
});

test('linked documents follow the requested review head when live PR metadata advances', async () => {
  const prContext = { headRefOid: 'a'.repeat(40), body: 'docs/contract.md' };
  let linkedReads = 0;
  await buildReviewerExtraContext({
    repo: 'fixture/app', prNumber: 37, prContext, reviewedHeadSha: headSha,
    getConfigImpl: () => [],
    readTenureReviewRangeImpl: options => { assert.equal(options.headSha, headSha); return null; },
    readFindingDisputeReservationsImpl: options => { assert.equal(options.headSha, headSha); return []; },
    fetchLinkedSpecContentsImpl: async (_repo, _pr, options) => {
      linkedReads++;
      assert.equal(options.prContext.headRefOid, headSha);
      return '';
    },
    buildHardeningReviewContextImpl: async () => '',
    log: { error() {}, warn() {} },
  });
  assert.equal(linkedReads, 1);
  assert.equal(prContext.headRefOid, 'a'.repeat(40), 'do not mutate live metadata');
});
