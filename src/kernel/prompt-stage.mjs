import { existsSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Classified failure raised when a domain's `promptSet` cannot be resolved.
 *
 * Carries a stable `class` tag (`prompt-set-resolution`) plus a `reason`
 * discriminant so callers and audit surfaces can distinguish a missing config
 * from a missing declaration from an unknown (non-existent) prompt set. Prompt
 * selection MUST fail loud with this error — it must never silently fall back
 * to `code-pr`.
 */
class PromptSetResolutionError extends Error {
  constructor(message, { domainId = null, promptSet = null, reason = null } = {}) {
    super(message);
    this.name = 'PromptSetResolutionError';
    this.class = 'prompt-set-resolution';
    this.domainId = domainId;
    this.promptSet = promptSet;
    this.reason = reason;
  }
}

/**
 * Resolve the prompt set a domain declares, validating that it exists on disk.
 *
 * This is the single source of truth for the reviewer/remediator prompt set:
 * the value comes from `domains/<id>.json` (`promptSet`), never a hardcoded
 * constant. Any failure — missing config, missing/blank declaration, unsafe
 * segment, or a declared set with no `prompts/<set>/` directory — throws a
 * classified {@link PromptSetResolutionError}. There is deliberately no
 * fallback path.
 *
 * @param {object} params
 * @param {string} params.rootDir - repository root containing `prompts/`
 * @param {object} params.domainConfig - parsed domain config document
 * @param {string} [params.domainId] - domain id, for error context
 * @returns {string} the validated prompt set id
 */
function resolvePromptSet({ rootDir, domainConfig, domainId } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  const id = domainId ?? domainConfig?.id ?? null;

  if (!domainConfig || typeof domainConfig !== 'object') {
    throw new PromptSetResolutionError(
      `prompt-set resolution failed: no domain config for domain=${id ?? '<unknown>'}`,
      { domainId: id, reason: 'missing-domain-config' },
    );
  }

  const promptSet = domainConfig.promptSet;
  if (typeof promptSet !== 'string' || promptSet.trim() === '') {
    throw new PromptSetResolutionError(
      `prompt-set resolution failed: domain=${id ?? '<unknown>'} declares no promptSet`,
      { domainId: id, reason: 'missing-prompt-set' },
    );
  }

  if (!PROMPT_PATH_SEGMENT.test(promptSet)) {
    throw new PromptSetResolutionError(
      `prompt-set resolution failed: promptSet ${JSON.stringify(promptSet)} for domain=${id ?? '<unknown>'} must match ${PROMPT_PATH_SEGMENT}`,
      { domainId: id, promptSet, reason: 'invalid-prompt-set' },
    );
  }

  const promptSetDir = join(rootDir, 'prompts', promptSet);
  if (!existsSync(promptSetDir) || !statSync(promptSetDir).isDirectory()) {
    throw new PromptSetResolutionError(
      `prompt-set resolution failed: domain=${id ?? '<unknown>'} declares unknown promptSet ${JSON.stringify(promptSet)} (no prompts/${promptSet}/ directory)`,
      { domainId: id, promptSet, reason: 'unknown-prompt-set' },
    );
  }

  return promptSet;
}

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
  PromptSetResolutionError,
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
  resolvePromptSet,
};
