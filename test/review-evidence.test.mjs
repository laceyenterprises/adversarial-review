import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { loadArgusReviewPromptTemplate } from '../src/argus-security-review.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('REVIEWEVIDENCE-01: every reviewer family and stage requires exact-head failing behaviour evidence', () => {
  const prompts = [loadArgusReviewPromptTemplate()];
  for (const stage of ['first', 'middle', 'last']) {
    for (const promptSet of ['code-pr', 'code-pr-security', 'research-finding']) {
      prompts.push(loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage }));
    }
    for (const [model, runtime] of [['codex', null], ['claude', null], ['gemini', 'antigravity']]) {
      prompts.push(buildPromptForReviewerModel(model, '', '', { promptStage: stage, runtime }));
    }
  }
  for (const prompt of prompts) {
    assert.match(prompt, /blocking only when.*`path:line`/);
    assert.match(prompt, /Input or state:[\s\S]*Wrong outcome:/);
    assert.match(prompt, /PR head/);
    assert.match(prompt, /record it as non-blocking/);
  }
});
