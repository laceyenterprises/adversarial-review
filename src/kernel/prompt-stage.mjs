import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {import('./contracts.js').PromptStage} PromptStage
 */

/**
 * @typedef {object} ReviewerStageContext
 * @property {number} [reviewAttemptNumber]
 * @property {number} [completedRemediationRounds]
 * @property {number} [maxRemediationRounds]
 */

/**
 * @typedef {object} RemediatorStageContext
 * @property {number} [remediationRound]
 * @property {number} [maxRemediationRounds]
 */

const STAGES = new Set(['first', 'middle', 'last']);
const PROMPT_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

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

function assertPromptPathSegment(name, value) {
  if (!PROMPT_PATH_SEGMENT.test(value)) {
    throw new Error(`${name} must match ${PROMPT_PATH_SEGMENT}`);
  }
  return value;
}

/**
 * @param {ReviewerStageContext} [context]
 * @returns {PromptStage}
 */
function pickReviewerStage({
  reviewAttemptNumber,
  completedRemediationRounds,
  maxRemediationRounds,
} = {}) {
  const attempt = toPositiveNumber(reviewAttemptNumber);
  const completed = toNonNegativeNumber(completedRemediationRounds);
  const cap = toPositiveNumber(maxRemediationRounds);

  if (attempt === null && completed === null && cap === null) {
    throw new Error('pickReviewerStage requires review attempt context');
  }
  if (attempt === 1 || completed === 0 || completed === null) return 'first';
  if (completed !== null && cap !== null && completed >= cap) return 'last';
  return 'middle';
}

/**
 * @param {RemediatorStageContext} [context]
 * @returns {PromptStage}
 */
function pickRemediatorStage({
  remediationRound,
  maxRemediationRounds,
} = {}) {
  const round = toPositiveNumber(remediationRound);
  const cap = toPositiveNumber(maxRemediationRounds);

  if (round === null) return 'first';
  if (round !== null && cap !== null && round >= cap) return 'last';
  if (round === 1) return 'first';
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
    join(
      rootDir,
      'prompts',
      assertPromptPathSegment('promptSet', promptSet),
      `${assertPromptPathSegment('actor', actor)}.${selectedStage}.md`,
    ),
    'utf8',
  ).trim();
}

export {
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
};
