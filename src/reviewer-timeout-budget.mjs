import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isExplicitOperatorRetriggerReason } from './retrigger-review-reason.mjs';

export const REVIEWER_TIMEOUT_SAME_HEAD_LIMIT = 2;
export const REVIEWER_TIMEOUT_REPEATED_REASON = 'reviewer-timeout-repeated-same-head';

// Content identity survives restarts and bare clones, without shelling out to
// git. Capture it once per watcher process, so an in-flight attempt keeps the
// build it actually ran even when a deployment replaces files on disk.
const REVIEWER_SOURCE_URL = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));

export function reviewerBuildDigest(moduleUrl = REVIEWER_SOURCE_URL) {
  const hash = createHash('sha256');
  const addFile = path => {
    hash.update(path).update('\0');
    try { hash.update(readFileSync(new URL(path, moduleUrl))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A checkout can remove a file after enumeration. Include its absence
      // in this process's build identity instead of failing watcher startup.
      hash.update(':missing');
    }
  };
  const add = (relative, include = () => true) => {
    const url = new URL(relative, moduleUrl);
    let entries;
    try { entries = readdirSync(url, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Partial installations can import cascade utilities without prompts.
      // Absence is part of their build identity, not an import-time crash.
      hash.update(relative).update(':missing');
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) add(`${path}/`, include);
      else if (entry.isFile() && include(entry.name)) addFile(path);
    }
  };
  let sourceEntries;
  try { sourceEntries = readdirSync(new URL('.', moduleUrl), { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hash.update('.').update(':missing');
    sourceEntries = [];
  }
  sourceEntries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of sourceEntries) {
    if (entry.isFile() && (/^reviewer.*\.mjs$/.test(entry.name) || entry.name === 'domain-pipeline.mjs')) {
      addFile(entry.name);
    }
  }
  add('adapters/reviewer-runtime/');
  add('../prompts/', name => /^reviewer(?:\.|$)/.test(name));
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
  // Only timeout evidence can invalidate a re-arm. A later provider failure
  // advances lastFailureAt without spending the operator's timeout probe.
  // Older files can recover that evidence only when their latest failure was
  // itself a timeout; missing evidence must still permit an explicit re-arm.
  const lastTimeoutAt = sameHead ? previous?.lastTimeoutAt
    || (state?.lastFailureClass === 'reviewer-timeout' ? state.lastFailureAt : null) || null : null;
  const lastTimeoutMs = Date.parse(lastTimeoutAt || '');
  const rearmed = sameHead && rearmAt && rearmAt !== previous.rearmAt
    && Number.isFinite(Date.parse(rearmAt))
    && (!Number.isFinite(lastTimeoutMs) || Date.parse(rearmAt) > lastTimeoutMs);
  const reset = !sameHead || buildChanged || rearmed;
  const count = reset ? 0 : Number(previous?.count || 0);
  const limit = buildChanged || rearmed ? 1 : sameHead
    ? Math.min(Number(previous?.limit || resolveReviewerTimeoutSameHeadLimit(env)), resolveReviewerTimeoutSameHeadLimit(env))
    : resolveReviewerTimeoutSameHeadLimit(env);
  return {
    headSha: headSha || null, reviewerBuildId, count, limit,
    total: sameHead ? Number(previous?.total ?? previous?.count ?? 0) : 0,
    lastTimeoutAt,
    rearmAt: rearmAt || (sameHead ? previous?.rearmAt : null) || null,
    parked: Boolean(headSha && count >= limit),
    changed: Boolean(sameHead && (buildChanged || rearmed)),
  };
}
