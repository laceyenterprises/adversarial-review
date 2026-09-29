// ARGUSDRAIN-01 item 3 — which model reviews an Argus job, while codex is out.
//
// The `argus-reviewer` worker class allows only OpenAI models, and codex is
// exhausted until 2026-10-04. Rather than widen that class (a registry change
// that needs a session-ledger migration), the drain reviews through the
// adversarial reviewer's own harness and routes the way its pool does:
//
//   - Gemini first when `reviewer.gemini.mode` is `always-on` (this
//     deployment's default cross-model reviewer), last when `fallback`, never
//     when `off`.
//   - The builder never reviews its own work: a `[claude-code]` PR is not
//     reviewed by Claude, a `[codex]` PR not by codex (`isCrossModelReviewWaived`,
//     the adversarial lane's own rule). A bot PR has no builder model.
//   - A provider the HHR quota probe reports as hard-grounded
//     (`exhausted`/`suspended`) is skipped, and a soft-grounded one (AFH-02)
//     goes last, from the same `hq fleet quota status --json` read the AMA
//     closer's harness fallback uses. An unreadable status is not a grounding:
//     the model stays in the list, and a failed spawn falls through to the next.
//
// ADVERSARIAL_ARGUS_REVIEWER_MODELS sets the base order (default claude,
// gemini, codex).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isCrossModelReviewWaived } from './adapters/subject/github-pr/routing.mjs';
import {
  isGroundedProviderState,
  parseHqFleetQuotaStatus,
  providerAvailabilityFromStatuses,
  providerForQuotaHarness,
  providerSoftGroundingFromStatuses,
} from './fleet-quota-status.mjs';
import { resolveGeminiReviewerModeWithSource } from './role-config.mjs';

const execFileAsync = promisify(execFile);
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;

export const ARGUS_REVIEWER_MODELS_ENV = 'ADVERSARIAL_ARGUS_REVIEWER_MODELS';
export const DEFAULT_ARGUS_REVIEWER_MODELS = Object.freeze(['claude', 'gemini', 'codex']);
const KNOWN_MODELS = new Set(DEFAULT_ARGUS_REVIEWER_MODELS);

/** Operator-ordered model preference; unknown names are dropped. */
export function resolveConfiguredArgusReviewerModels(env = process.env) {
  const raw = String(env?.[ARGUS_REVIEWER_MODELS_ENV] ?? '').trim();
  if (!raw) return [...DEFAULT_ARGUS_REVIEWER_MODELS];
  const models = raw.split(',').map((value) => value.trim().toLowerCase()).filter((value) => KNOWN_MODELS.has(value));
  return models.length > 0 ? [...new Set(models)] : [...DEFAULT_ARGUS_REVIEWER_MODELS];
}

/** The worker-class tag at the head of a PR title, e.g. `[claude-code]`. */
export function builderClassFromTitle(title) {
  const match = String(title || '').match(/^\s*\[([a-z0-9-]+)\]/iu);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Order and filter the candidate models. Pure: every input is passed in.
 *
 * @returns {{models: string[], excluded: Array<{model: string, reason: string}>}}
 */
export function orderArgusReviewerModels({
  configured,
  geminiMode = 'off',
  builderClass = null,
  statuses = null,
}) {
  const excluded = [];
  let candidates = [...configured];
  const mode = String(geminiMode || 'off').trim().toLowerCase();
  if (mode === 'off') {
    if (candidates.includes('gemini')) excluded.push({ model: 'gemini', reason: 'reviewer.gemini.mode=off' });
    candidates = candidates.filter((model) => model !== 'gemini');
  } else if (candidates.includes('gemini')) {
    candidates = candidates.filter((model) => model !== 'gemini');
    if (mode === 'always-on') candidates.unshift('gemini');
    else candidates.push('gemini');
  }

  candidates = candidates.filter((model) => {
    if (builderClass && isCrossModelReviewWaived(builderClass, model)) {
      excluded.push({ model, reason: `builder-${builderClass}-never-reviews-its-own-work` });
      return false;
    }
    return true;
  });

  if (!Array.isArray(statuses)) return { models: candidates, excluded };
  const healthy = [];
  const softGrounded = [];
  for (const model of candidates) {
    const provider = providerForQuotaHarness(model);
    const hard = providerAvailabilityFromStatuses(statuses, { provider });
    if (isGroundedProviderState(hard.state)) {
      excluded.push({ model, reason: `provider-${provider}-${hard.state}` });
      continue;
    }
    if (providerSoftGroundingFromStatuses(statuses, { provider }).grounded) softGrounded.push(model);
    else healthy.push(model);
  }
  return { models: [...healthy, ...softGrounded], excluded };
}

export async function readFleetQuotaStatuses({
  env = process.env,
  execFileImpl = execFileAsync,
  hqPath = env?.HQ_BIN || 'hq',
} = {}) {
  const result = await execFileImpl(hqPath, ['fleet', 'quota', 'status', '--json'], {
    env,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: FLEET_QUOTA_STATUS_TIMEOUT_MS,
  });
  return parseHqFleetQuotaStatus(typeof result === 'string' ? result : result?.stdout);
}

/** Production resolver for `deps.resolveReviewerModels`. */
export function createArgusReviewerModelResolver({
  env = process.env,
  readStatuses = () => readFleetQuotaStatuses({ env }),
  resolveGeminiMode = () => resolveGeminiReviewerModeWithSource({ env }).mode,
  logger = console,
} = {}) {
  return async ({ job, pr }) => {
    let statuses = null;
    try {
      statuses = await readStatuses();
    } catch (err) {
      logger?.warn?.(`[argus-routing] fleet quota status unreadable; not filtering on it: ${err?.message || err}`);
    }
    let geminiMode = 'off';
    try {
      geminiMode = resolveGeminiMode();
    } catch (err) {
      logger?.warn?.(`[argus-routing] reviewer.gemini.mode unreadable; treating Gemini as off: ${err?.message || err}`);
    }
    const { models, excluded } = orderArgusReviewerModels({
      configured: resolveConfiguredArgusReviewerModels(env),
      geminiMode,
      builderClass: builderClassFromTitle(pr?.title),
      statuses,
    });
    logger?.log?.(
      `[argus-routing] ${job.repo}#${job.prNumber}: reviewers=${models.join(',') || 'none'}`
        + (excluded.length ? ` excluded=${excluded.map((entry) => `${entry.model}(${entry.reason})`).join(',')}` : ''),
    );
    return models;
  };
}
