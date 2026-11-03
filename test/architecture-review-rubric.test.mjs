import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectReviewerRubric, buildPromptForReviewerModel, buildReviewerPromptPrefix, buildReviewerPrompt } from '../src/reviewer-prompt.mjs';
import { dispatchReviewerModel, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { groundBlockingFindingsAtHead } from '../src/review-head-grounding.mjs';
import { validateReviewerReply } from '../src/kernel/review-reply.mjs';

const arr = 'docs/architecture/reviews/ARR-example.retry-20261102';
const patch = (path, oldPath = path, body = '+Synthetic requirement\n') =>
  `diff --git a/${oldPath} b/${path}\n--- a/${oldPath}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n${body}`;
const arrDiff = patch(`${arr}.md`) + patch(`${arr}.json`);
const mixedDiff = arrDiff + patch('src/example.mjs');
const rootDir = new URL('..', import.meta.url).pathname;
const clean = '## Summary\nEvidence traced.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Suggested fixes\n- None.\n\n## Verdict\nComment only';

test('ARR-only additions, edits, deletions, quoted paths and internal renames select architecture', () => {
  for (const diff of [arrDiff, patch(`${arr}.json`),
    patch(`${arr}.md`).replace(`--- a/${arr}.md`, 'new file mode 100644\n--- /dev/null'),
    patch(`${arr}.md`).replace(`+++ b/${arr}.md`, 'deleted file mode 100644\n+++ /dev/null'),
    `diff --git "a/${arr}.md" "b/${arr}.md"\n`,
    patch(`${arr}-updated.md`, `${arr}.md`)]) {
    assert.equal(selectReviewerRubric(diff), 'architecture-review');
  }
});

test('mixed, empty, malformed, out-of-area and cross-boundary renames retain code', () => {
  for (const diff of ['', '+prose', mixedDiff, `${arrDiff}diff --git unreadable\n`,
    patch(`${arr}.md`, 'src/example.mjs'), patch('src/example.mjs', `${arr}.md`),
    patch('docs/architecture/reviews/README.md'), patch(`${arr}.md.bak`),
    patch('docs/architecture/reviews/ARR-../example.md'),
    patch('other/docs/architecture/reviews/ARR-example.md')]) {
    assert.equal(selectReviewerRubric(diff), 'code-pr');
  }
});

test('every stage and runtime uses architecture rubric with identical output contract', () => {
  for (const stage of ['first', 'middle', 'last']) {
    const source = readFileSync(new URL(`../prompts/architecture-review/reviewer.${stage}.md`, import.meta.url), 'utf8').trim();
    const original = readFileSync(new URL(`../prompts/code-pr/reviewer.${stage}.md`, import.meta.url), 'utf8');
    assert.equal(source.slice(source.indexOf('Output requirements:')), original.slice(original.indexOf('Output requirements:'), original.indexOf('Spec coverage check:')).trim());
    for (const [model, runtime] of [['claude', 'cli'], ['codex', 'cli'], ['gemini', 'cli'], ['gemini', 'antigravity']]) {
      const prompt = buildPromptForReviewerModel(model, arrDiff, '', { promptStage: stage, runtime });
      for (const label of ['Dropped scar:', 'Built-but-dark design:', 'Stranded in-flight work:', 'Unsupported invariant:', 'Unevidenced target:', 'ARCH recommends; the operator decides.']) assert.ok(prompt.includes(label), label);
      assert.ok(!prompt.includes('adversarial code review'));
      assert.ok(prompt.includes('Evidence discipline:'));
      if (runtime === 'antigravity') assert.ok(prompt.includes('Antigravity runtime instructions:'));
      const code = buildPromptForReviewerModel(model, mixedDiff, '', { promptStage: stage, runtime });
      assert.ok(code.includes('adversarial code review'));
      assert.ok(!code.includes('Architecture rubric (blocking classes)'));
    }
    const prefix = loadStagePrompt({ rootDir, promptSet: 'code-pr', actor: 'reviewer', stage });
    assert.equal(buildReviewerPromptPrefix({ stage }), prefix);
    assert.equal(buildPromptForReviewerModel('codex', mixedDiff, '', { promptStage: stage }), buildReviewerPrompt({ promptPrefix: prefix, diff: mixedDiff }));
  }
});

test('model dispatch passes the same whole-PR rubric to every harness', async () => {
  for (const model of ['claude', 'codex', 'gemini']) {
    for (const [diff, expected] of [[arrDiff, 'architecture-review'], [mixedDiff, 'code-pr']]) {
      const run = async (_diff, _context, options) => {
        assert.equal(options.reviewKind, expected);
        return { reviewText: clean };
      };
      await dispatchReviewerModel(model, diff, '', { reviewWithClaudeImpl: run, reviewWithCodexImpl: run, reviewWithGeminiImpl: run });
    }
  }
});

test('chunk planning and dispatch retain whole-PR rubric even for ARR-only chunks of mixed PRs', async () => {
  for (const reviewerModel of ['claude', 'codex', 'gemini']) {
    for (const mixed of [false, true]) {
      const diff = patch(`${arr}.md`, `${arr}.md`, '+Synthetic evidence\n'.repeat(3000))
        + (mixed ? patch('src/example.mjs') : patch(`${arr}.json`));
      let calls = 0;
      let arrOnlyChunk = false;
      const run = async (chunk, context, options) => {
        calls += 1;
        arrOnlyChunk ||= selectReviewerRubric(chunk) === 'architecture-review';
        assert.equal(options.reviewKind, mixed ? 'code-pr' : 'architecture-review');
        const prompt = buildPromptForReviewerModel(reviewerModel, chunk, context, { ...options, runtime: reviewerModel === 'gemini' ? 'antigravity' : 'cli' });
        assert.ok(Buffer.byteLength(prompt) <= 30000);
        assert.equal(prompt.includes('Architecture rubric (blocking classes)'), !mixed);
        return { reviewText: clean, rawReviewText: clean, needsSanitize: false };
      };
      await reviewAgyOversizedInChunks(diff, '', { reviewerModel, maxBytes: 30000, maxChunks: 20, dispatchReviewerModelImpl: (_model, ...args) => run(...args), reviewWithGeminiImpl: run });
      assert.ok(calls > 1);
      assert.ok(arrOnlyChunk);
    }
  }
});

test('architecture findings and clean replies use unchanged verdict and reply validators', () => {
  const blocked = readFileSync(new URL('./fixtures/architecture-review/dropped-scar.md', import.meta.url), 'utf8');
  for (const [body, verdict] of [[blocked, 'Request changes'], [clean, 'Comment only']]) {
    assert.equal(extractReviewVerdict(body), verdict);
    assert.equal(validateReviewerReply(body).ok, true);
  }
});

test('evidenced architecture blocker survives existing exact-head grounding', async () => {
  const blocked = readFileSync(new URL('./fixtures/architecture-review/dropped-scar.md', import.meta.url), 'utf8');
  const result = await groundBlockingFindingsAtHead(blocked, {
    repo: 'synthetic/project', headSha: 'a'.repeat(40), requireEvidence: true,
    fetchFileAtRefImpl: async () => Array(11).fill('Synthetic context').concat('all scars mapped').join('\n'),
  });
  assert.equal(result.grounding.kept, 1);
  assert.equal(result.grounding.demoted.length, 0);
  assert.equal(extractReviewVerdict(result.reviewText), 'Request changes');
});
