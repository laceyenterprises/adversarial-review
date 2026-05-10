import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STAGES = new Set(['first', 'middle', 'last']);

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function assertStage(stage) {
  if (!STAGES.has(stage)) {
    throw new Error(`unknown prompt stage: ${stage}`);
  }
  return stage;
}

function pickReviewerStage({
  reviewAttemptNumber,
  completedRemediationRounds,
  maxRemediationRounds,
} = {}) {
  const attempt = toPositiveNumber(reviewAttemptNumber);
  const completed = toNonNegativeNumber(completedRemediationRounds);
  const cap = toPositiveNumber(maxRemediationRounds);

  if (attempt === 1 && completed === 0) return 'first';
  if (completed !== null && cap !== null && completed >= cap) return 'last';
  return 'middle';
}

function pickRemediatorStage({
  remediationRound,
  maxRemediationRounds,
} = {}) {
  const round = toPositiveNumber(remediationRound);
  const cap = toPositiveNumber(maxRemediationRounds);

  if (round === 1) return 'first';
  if (round !== null && cap !== null && round >= cap) return 'last';
  return 'middle';
}

function loadStagePrompt({
  rootDir,
  promptSet,
  actor,
  stage,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!promptSet) throw new Error('promptSet is required');
  if (!actor) throw new Error('actor is required');

  const selectedStage = assertStage(stage);
  return readFileSync(
    join(rootDir, 'prompts', promptSet, `${actor}.${selectedStage}.md`),
    'utf8',
  ).trim();
}

export {
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
};
