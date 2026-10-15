import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { isExplicitOperatorRetriggerReason } from './retrigger-review-reason.mjs';

export const REVIEWER_TIMEOUT_SAME_HEAD_LIMIT = 2;
export const REVIEWER_TIMEOUT_REPEATED_REASON = 'reviewer-timeout-repeated-same-head';

// Content identity survives restarts and bare clones, without shelling out to
// git. Capture it once per watcher process, so an in-flight attempt keeps the
// build it actually ran even when a deployment replaces files on disk.
function reviewerBuildDigest() {
  const hash = createHash('sha256');
  const add = (relative) => {
    const url = new URL(relative, import.meta.url);
    const entries = readdirSync(url, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) add(`${path}/`);
      else if (entry.isFile()) hash.update(path).update('\0').update(readFileSync(new URL(path, import.meta.url)));
    }
  };
  for (const name of readdirSync(new URL('.', import.meta.url)).sort()) {
    if (/^reviewer.*\.mjs$/.test(name) || name === 'domain-pipeline.mjs') {
      hash.update(name).update('\0').update(readFileSync(new URL(name, import.meta.url)));
    }
  }
  add('adapters/reviewer-runtime/');
  add('../prompts/');
  return hash.digest('hex');
}

export const REVIEWER_BUILD_ID = process.env.ADVERSARIAL_REVIEWER_BUILD_ID?.trim() || reviewerBuildDigest();

export function resolveReviewerTimeoutSameHeadLimit(env = process.env) {
  const value = Number(env.ADVERSARIAL_REVIEWER_TIMEOUT_SAME_HEAD_LIMIT);
  return Number.isSafeInteger(value) && value > 0 ? value : REVIEWER_TIMEOUT_SAME_HEAD_LIMIT;
}

export function reviewerTimeoutBudget(state, {
  headSha, reviewerBuildId = REVIEWER_BUILD_ID, row = null, env = process.env,
} = {}) {
  const rearmAt = isExplicitOperatorRetriggerReason(row?.rereview_reason)
    ? row.rereview_requested_at || null : null;
  // Legacy cascade files did not bind counts to a head/build. Use the row's
  // failed-head evidence to bound an already looping head on the first deploy.
  const previous = state?.reviewerTimeout || (row?.reviewer_head_sha && {
    headSha: row.reviewer_head_sha,
    reviewerBuildId,
    count: Number(state?.transientFailureBreakdown?.['reviewer-timeout'] || 0),
    total: Number(state?.transientFailureBreakdown?.['reviewer-timeout'] || 0),
    limit: resolveReviewerTimeoutSameHeadLimit(env),
    rearmAt: null,
  });
  const sameHead = Boolean(headSha && previous?.headSha === headSha);
  const buildChanged = sameHead && previous.reviewerBuildId !== reviewerBuildId;
  const rearmed = sameHead && rearmAt && rearmAt !== previous.rearmAt
    && Date.parse(rearmAt) > Date.parse(state?.lastFailureAt || '');
  const reset = !sameHead || buildChanged || rearmed;
  const count = reset ? 0 : Number(previous?.count || 0);
  const limit = buildChanged || rearmed ? 1 : sameHead
    ? Math.min(Number(previous?.limit || resolveReviewerTimeoutSameHeadLimit(env)), resolveReviewerTimeoutSameHeadLimit(env))
    : resolveReviewerTimeoutSameHeadLimit(env);
  return {
    headSha: headSha || null, reviewerBuildId, count, limit,
    total: sameHead ? Number(previous?.total ?? previous?.count ?? 0) : 0,
    rearmAt: rearmAt || (sameHead ? previous?.rearmAt : null) || null,
    parked: Boolean(headSha && count >= limit),
    changed: Boolean(sameHead && (buildChanged || rearmed)),
  };
}
