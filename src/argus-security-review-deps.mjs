// ARGUSDRAIN-01 — the production I/O behind `reviewArgusJob`.
//
// Kept apart from the review logic so the drain and review tests inject fakes
// and never reach GitHub, a model CLI, or the reviewer credential pools. Only
// the review child process (`argus-security-review-child.mjs`) builds these.

import { reviewWithClaude, reviewWithCodex, reviewWithGemini } from './reviewer-harness.mjs';
import { fetchPRDiff } from './reviewer-diff-fetch.mjs';
import { execGhWithRetry } from './gh-cli.mjs';

export const ARGUS_REVIEWER_TOKEN_ENV = 'GH_ARGUS_REVIEWER_TOKEN';
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

/**
 * The identity a finding is posted as. `GH_ARGUS_REVIEWER_TOKEN` is the Argus
 * reviewer identity; until it is provisioned the comment posts under the
 * reviewing model's reviewer-bot token, and the comment header names Argus so
 * the role is unambiguous (the same convention remediation comments use).
 * Posted as an issue comment, never a PR review, so no review-verdict parser
 * mistakes it for an adversarial review.
 */
export function resolveArgusCommentIdentity({ model, env = process.env }) {
  const argusToken = String(env?.[ARGUS_REVIEWER_TOKEN_ENV] || '').trim();
  if (argusToken) return { token: argusToken, tokenEnv: ARGUS_REVIEWER_TOKEN_ENV };
  const modelEnv = model ? `GH_${String(model).toUpperCase()}_REVIEWER_TOKEN` : null;
  const modelToken = modelEnv ? String(env?.[modelEnv] || '').trim() : '';
  if (modelToken) return { token: modelToken, tokenEnv: modelEnv };
  return null;
}

function parseCommentUrl(stdout) {
  const match = String(stdout || '').match(/https:\/\/github\.com\/\S+#issuecomment-\d+/u);
  return match ? match[0] : null;
}

export function createDefaultArgusReviewDeps({
  env = process.env,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
  resolveReviewerModels = null,
  gatherEvidence = null,
  assessVerification = null,
} = {}) {
  return {
    async fetchPullRequest({ repo, prNumber }) {
      const { stdout } = await execGhWithRetryImpl({
        args: [
          'pr', 'view', String(prNumber), '--repo', repo,
          '--json', 'state,headRefOid,baseRefOid,baseRefName,title,author,isDraft,files,statusCheckRollup',
        ],
        env,
        timeoutMs: 60_000,
        log: logger,
      });
      const parsed = JSON.parse(String(stdout || '{}'));
      return {
        state: String(parsed?.state || '').trim().toUpperCase(),
        headSha: String(parsed?.headRefOid || '').trim().toLowerCase(),
        baseSha: String(parsed?.baseRefOid || '').trim().toLowerCase() || null,
        baseRefName: parsed?.baseRefName || null,
        title: parsed?.title || '',
        author: parsed?.author?.login || null,
        isDraft: parsed?.isDraft === true,
        changedFiles: Array.isArray(parsed?.files) ? parsed.files.map((file) => file?.path).filter(Boolean) : null,
        statusCheckRollup: Array.isArray(parsed?.statusCheckRollup) ? parsed.statusCheckRollup : null,
      };
    },

    async fetchDiff({ repo, prNumber, headSha }) {
      const bytes = await fetchPRDiff(repo, prNumber, headSha, { log: logger });
      return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '');
    },

    resolveReviewerModels: resolveReviewerModels
      || (async () => resolveConfiguredArgusReviewerModels(env)),

    async runReviewerModel({ model, prompt, cwd, diff }) {
      const options = { promptOverride: prompt, reviewerSubprocessCwd: cwd };
      let output;
      if (model === 'claude') output = await reviewWithClaude(diff || '', '', options);
      else if (model === 'gemini') output = await reviewWithGemini(diff || '', '', options);
      else if (model === 'codex') output = await reviewWithCodex(diff || '', '', options);
      else throw new Error(`unknown Argus reviewer model ${JSON.stringify(model)}`);
      const text = typeof output === 'string' ? output : output?.reviewText;
      return { text, execution: output?.execution || { harness: model } };
    },

    async postComment({ repo, prNumber, body, model }) {
      const identity = resolveArgusCommentIdentity({ model, env });
      if (!identity) return { ok: false, reason: 'no-identity-token' };
      const { stdout } = await execGhWithRetryImpl({
        args: ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
        env: { ...env, GITHUB_TOKEN: identity.token, GH_TOKEN: identity.token },
        timeoutMs: 60_000,
        log: logger,
      });
      return { ok: true, url: parseCommentUrl(stdout), identity: identity.tokenEnv };
    },

    gatherEvidence,
    assessVerification,
  };
}
