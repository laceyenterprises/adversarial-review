import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
} from '../src/kernel/prompt-stage.mjs';
import { buildReviewerPromptPrefix } from '../src/reviewer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function legacyReviewerPrompt({ final = false } = {}) {
  const base = readFileSync(join(ROOT, 'prompts', 'reviewer-prompt.md'), 'utf8').trim();
  if (!final) return base;
  const addendum = readFileSync(join(ROOT, 'prompts', 'reviewer-prompt-final-round-addendum.md'), 'utf8').trim();
  return `${base}\n\n---\n\n${addendum}`;
}

function legacyRemediatorPrompt() {
  return readFileSync(join(ROOT, 'prompts', 'follow-up-remediation.md'), 'utf8').trim();
}

function renderReviewerViaStage(args) {
  const stage = pickReviewerStage(args);
  return {
    stage,
    prompt: loadStagePrompt({
      rootDir: ROOT,
      promptSet: 'code-pr',
      actor: 'reviewer',
      stage,
    }),
  };
}

function renderRemediatorViaStage(args) {
  const stage = pickRemediatorStage(args);
  return {
    stage,
    prompt: loadStagePrompt({
      rootDir: ROOT,
      promptSet: 'code-pr',
      actor: 'remediator',
      stage,
    }),
  };
}

test('reviewer initial review uses first for every normal remediation budget', () => {
  for (const maxRemediationRounds of [1, 2, 3]) {
    const rendered = renderReviewerViaStage({
      reviewAttemptNumber: 1,
      completedRemediationRounds: 0,
      maxRemediationRounds,
    });

    assert.equal(rendered.stage, 'first');
    assert.equal(rendered.prompt, legacyReviewerPrompt());
  }
});

test('reviewer middle rereview uses the focused middle prompt', () => {
  const rendered = renderReviewerViaStage({
    reviewAttemptNumber: 2,
    completedRemediationRounds: 1,
    maxRemediationRounds: 3,
  });

  assert.equal(rendered.stage, 'middle');
  assert.notEqual(rendered.prompt, legacyReviewerPrompt());
  assert.match(rendered.prompt, /This is a re-review after a remediation round/);
});

test('reviewer final review preserves the legacy base-plus-addendum bytes', () => {
  for (const fixture of [
    { reviewAttemptNumber: 2, completedRemediationRounds: 1, maxRemediationRounds: 1 },
    { reviewAttemptNumber: 4, completedRemediationRounds: 3, maxRemediationRounds: 3 },
    { reviewAttemptNumber: 5, completedRemediationRounds: 4, maxRemediationRounds: 3 },
  ]) {
    const rendered = renderReviewerViaStage(fixture);

    assert.equal(rendered.stage, 'last');
    assert.equal(rendered.prompt, legacyReviewerPrompt({ final: true }));
    assert.equal(buildReviewerPromptPrefix({ stage: rendered.stage }), rendered.prompt);
  }
});

test('medium-class reviewer budget does not collapse first and last', () => {
  assert.equal(
    pickReviewerStage({
      reviewAttemptNumber: 1,
      completedRemediationRounds: 0,
      maxRemediationRounds: 1,
    }),
    'first',
  );
  assert.equal(
    pickReviewerStage({
      reviewAttemptNumber: 2,
      completedRemediationRounds: 1,
      maxRemediationRounds: 1,
    }),
    'last',
  );
});

test('remediator stages select first, middle, and last by remediation round', () => {
  assert.equal(pickRemediatorStage({ remediationRound: 1, maxRemediationRounds: 3 }), 'first');
  assert.equal(pickRemediatorStage({ remediationRound: 2, maxRemediationRounds: 3 }), 'middle');
  assert.equal(pickRemediatorStage({ remediationRound: 3, maxRemediationRounds: 3 }), 'last');

  const first = renderRemediatorViaStage({ remediationRound: 1, maxRemediationRounds: 3 });
  const middle = renderRemediatorViaStage({ remediationRound: 2, maxRemediationRounds: 3 });
  const last = renderRemediatorViaStage({ remediationRound: 3, maxRemediationRounds: 3 });

  assert.equal(first.prompt, legacyRemediatorPrompt());
  assert.notEqual(middle.prompt, legacyRemediatorPrompt());
  assert.match(middle.prompt, /This is a follow-up remediation round/);
  assert.notEqual(last.prompt, legacyRemediatorPrompt());
  assert.match(last.prompt, /This is the last remediation round available/);
});
