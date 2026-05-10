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

function readPrompt(...parts) {
  return readFileSync(join(ROOT, 'prompts', ...parts), 'utf8').trim();
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
    assert.equal(rendered.prompt, readPrompt('code-pr', 'reviewer.first.md'));
  }
});

test('reviewer middle rereview uses the focused middle prompt', () => {
  const rendered = renderReviewerViaStage({
    reviewAttemptNumber: 2,
    completedRemediationRounds: 1,
    maxRemediationRounds: 3,
  });

  assert.equal(rendered.stage, 'middle');
  assert.notEqual(rendered.prompt, readPrompt('code-pr', 'reviewer.first.md'));
  assert.match(rendered.prompt, /This is a re-review after a remediation round/);
});

test('reviewer partial or invalid context defaults to first unless mid-cycle is proven', () => {
  assert.equal(pickReviewerStage({ maxRemediationRounds: 2 }), 'first');
  assert.equal(pickReviewerStage({ reviewAttemptNumber: 3, maxRemediationRounds: 2 }), 'first');
  assert.equal(pickReviewerStage({ reviewAttemptNumber: 2, completedRemediationRounds: 1 }), 'middle');
  assert.equal(pickReviewerStage({ completedRemediationRounds: 1, maxRemediationRounds: 3 }), 'middle');
});

test('reviewer final review uses the staged final prompt', () => {
  for (const fixture of [
    { reviewAttemptNumber: 2, completedRemediationRounds: 1, maxRemediationRounds: 1 },
    { reviewAttemptNumber: 4, completedRemediationRounds: 3, maxRemediationRounds: 3 },
    { reviewAttemptNumber: 5, completedRemediationRounds: 4, maxRemediationRounds: 3 },
  ]) {
    const rendered = renderReviewerViaStage(fixture);

    assert.equal(rendered.stage, 'last');
    assert.equal(rendered.prompt, readPrompt('code-pr', 'reviewer.last.md'));
    assert.equal(buildReviewerPromptPrefix({ stage: rendered.stage }), rendered.prompt);
  }
});

test('pickReviewerStage throws when called without usable review context', () => {
  assert.throws(() => pickReviewerStage(), /requires review attempt context/);
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
  assert.equal(pickRemediatorStage({ remediationRound: 1, maxRemediationRounds: 1 }), 'last');
  assert.equal(pickRemediatorStage({ remediationRound: 2, maxRemediationRounds: 2 }), 'last');

  const first = renderRemediatorViaStage({ remediationRound: 1, maxRemediationRounds: 3 });
  const middle = renderRemediatorViaStage({ remediationRound: 2, maxRemediationRounds: 3 });
  const last = renderRemediatorViaStage({ remediationRound: 3, maxRemediationRounds: 3 });
  const singleRound = renderRemediatorViaStage({ remediationRound: 1, maxRemediationRounds: 1 });

  assert.equal(first.prompt, readPrompt('code-pr', 'remediator.first.md'));
  assert.notEqual(middle.prompt, readPrompt('code-pr', 'remediator.first.md'));
  assert.match(middle.prompt, /This is a follow-up remediation round/);
  assert.notEqual(last.prompt, readPrompt('code-pr', 'remediator.first.md'));
  assert.match(last.prompt, /This is the last remediation round available/);
  assert.equal(singleRound.prompt, readPrompt('code-pr', 'remediator.last.md'));
});

test('remediator invalid or partial context falls back to first instead of silently selecting middle', () => {
  assert.equal(pickRemediatorStage({}), 'first');
  assert.equal(pickRemediatorStage({ remediationRound: 0, maxRemediationRounds: 3 }), 'first');
  assert.equal(pickRemediatorStage({ maxRemediationRounds: 3 }), 'first');
});

test('loadStagePrompt rejects unsafe prompt path segments', () => {
  assert.throws(
    () => loadStagePrompt({ rootDir: ROOT, promptSet: '../escape', actor: 'reviewer', stage: 'first' }),
    /promptSet must match/,
  );
  assert.throws(
    () => loadStagePrompt({ rootDir: ROOT, promptSet: 'code-pr', actor: '../escape', stage: 'first' }),
    /actor must match/,
  );
});
