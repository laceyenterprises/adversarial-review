// Clobber guard — content-preservation check for a MOVED merge head.
//
// THE HOLE THIS CLOSES. The daemon clean-merge lane can certify a *moved* head
// (`reviewedHead !== liveHead`) purely on closer-commit *identity* (the live
// head is the closer's own commit) without ever comparing CONTENT. A rebase /
// force-push that silently DROPS a reviewed commit still carries the closer's
// committer identity, so the identity-only certification authorizes it and the
// daemon merges a head that is missing reviewed content. This is the #5455-class
// clobber: a remediation rebase from a stale base drops a reviewed fix commit and
// the content-blind fast path lands it on main.
//
// THE CHECK. When a head has moved, the reviewed content and the live content are
// each a multiset of per-commit `git patch-id`s (rebase-stable content
// fingerprints). Any patch-id that was in the reviewed head but is absent from the
// live head is reviewed content that the rebase dropped. Patch-ids are computed
// from the per-commit diffs GitHub returns (`application/vnd.github.v3.diff`)
// piped through `git patch-id --stable` — a pure stdin filter that needs no local
// checkout, so this runs in the daemon which by design has no workspace.
//
// FALSE-POSITIVE SAFETY. A legitimately-upstream commit (its change already landed
// in the new base) keeps its patch-id on the live side, so it is NOT flagged. The
// caller treats a `clobber`/`unverifiable` result as "do not take the content-blind
// shortcut" and falls through to the capped hammer, which re-runs the exact-head
// battery — the authoritative validator. So a false positive costs one hammer
// re-validation, never a wrong hard-block, and a real clobber can never reach main
// on the content-blind lane.
//
// Content-equivalence uses the existing `compareReviewedPatchIds` multiset diff.

import { spawn } from 'node:child_process';

import { loadRoleConfig } from '../role-config.mjs';
import { compareReviewedPatchIds } from './rebase-authority.mjs';

const CLOBBER_GUARD_GH_TIMEOUT_MS = 15_000;
const VALID_GITHUB_REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/u;

function parseBooleanEnvFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '' || normalized === '0' || normalized === 'false') return false;
  return null;
}

// Kill-switch for the clobber guard. DEFAULT true (fail-safe ON): a moved head on
// the content-blind daemon lane is content-verified, and a dropped-content or
// unverifiable result declines the shortcut. Set the env override or
// `roles.adversarial.merge_authority.clobber_guard_enabled=false` to disable. When
// disabled the daemon behaves exactly as it did before this guard existed.
export function clobberGuardEnabled(env = process.env, options = {}) {
  const envValue = env.ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED;
  const parsedEnv = envValue === undefined || envValue === '' ? null : parseBooleanEnvFlag(envValue);
  if (parsedEnv !== null) return parsedEnv;
  try {
    return loadRoleConfig({
      env,
      topPath: options.topPath,
      modulePaths: options.modulePaths,
      loaderImpl: options.loaderImpl,
      contextKey: 'roles.adversarial.merge_authority.clobber_guard_enabled',
    }).get('roles.adversarial.merge_authority.clobber_guard_enabled', true) === true;
  } catch {
    // Fail SAFE toward enforcement: an unreadable config keeps the guard on.
    return true;
  }
}

// Compute a rebase-stable patch-id from a unified diff via `git patch-id --stable`.
// `git patch-id` is a pure stdin->stdout filter (no repo required) that normalizes
// away hunk line offsets, so the same logical change hashes identically before and
// after a rebase. An empty diff has no content unit and yields null. Injectable
// spawn for tests.
export function computePatchIdFromDiff(diffText, { spawnImpl = spawn, gitBin = 'git' } = {}) {
  return new Promise((resolve, reject) => {
    const text = String(diffText || '');
    if (!text.trim()) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawnImpl(gitBin, ['patch-id', '--stable'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (e) => settle(reject, e));
    child.on('close', (code) => {
      if (code !== 0) {
        settle(reject, new Error(`git patch-id exited ${code}: ${err.trim()}`.trim()));
        return;
      }
      const id = out.trim().split(/\s+/u)[0] || '';
      settle(resolve, id || null);
    });
    // git closes stdin once it has read the patch; ignore the resulting EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  });
}

async function ghJson(execGh, args) {
  const { stdout } = await execGh({ args, timeoutMs: CLOBBER_GUARD_GH_TIMEOUT_MS });
  return JSON.parse(String(stdout || 'null'));
}

// SHAs of commits reachable from `headSha` but not from `baseSha` (three-dot
// compare uses their merge-base), i.e. the content `headSha` adds over `baseSha`.
async function commitShasUniqueToHead({ execGh, repo, baseSha, headSha }) {
  const data = await ghJson(execGh, [
    'api',
    `repos/${repo}/compare/${baseSha}...${headSha}`,
    '--jq',
    '[.commits[].sha]',
  ]);
  return Array.isArray(data) ? data.map((s) => String(s || '')).filter((s) => SHA_RE.test(s)) : [];
}

async function fetchCommitDiff({ execGh, repo, sha }) {
  const { stdout } = await execGh({
    args: ['api', `repos/${repo}/commits/${sha}`, '-H', 'Accept: application/vnd.github.v3.diff'],
    timeoutMs: CLOBBER_GUARD_GH_TIMEOUT_MS,
  });
  return String(stdout || '');
}

async function rangePatchIds({ execGh, repo, baseSha, headSha, spawnImpl }) {
  const shas = await commitShasUniqueToHead({ execGh, repo, baseSha, headSha });
  const patchIds = [];
  for (const sha of shas) {
    // Sequential: the ranges are a handful of commits and we prefer bounded,
    // predictable gh load in the merge path over parallel bursts.
    const diff = await fetchCommitDiff({ execGh, repo, sha });
    const id = await computePatchIdFromDiff(diff, { spawnImpl });
    if (id) patchIds.push(id);
  }
  return { shas, patchIds };
}

// Evaluate whether a MOVED head preserved all reviewed content.
//
// Returns one of:
//   { status: 'skipped',     reason: 'clobber-guard-disabled' }        kill-switch off
//   { status: 'skipped',     reason: 'clobber-guard-not-applicable-*' } malformed/non-SHA inputs
//   { status: 'ok',          reason: 'head-unchanged' }                reviewed === live
//   { status: 'ok',          reason: 'reviewed-content-preserved' }    no dropped patch-ids
//   { status: 'clobber',     reason: 'reviewed-content-dropped-on-rebase', dropped[] }
//   { status: 'unverifiable', reason: 'clobber-guard-verification-error' } gh failed; fail closed
//
// The caller merges only on `ok`/`skipped`; `clobber` and `unverifiable` decline
// the content-blind lane (fall through to the capped hammer). `skipped` covers the
// kill-switch and inputs that cannot correspond to a real GitHub merge head.
export async function evaluateMovedHeadClobberGuard({
  repo,
  reviewedHead,
  liveHead,
  execGh,
  spawnImpl = spawn,
  env = process.env,
  logger = console,
  configOptions = {},
} = {}) {
  const reviewed = String(reviewedHead || '').trim();
  const live = String(liveHead || '').trim();

  if (!clobberGuardEnabled(env, configOptions)) {
    return { status: 'skipped', reason: 'clobber-guard-disabled', reviewedHead: reviewed, liveHead: live };
  }
  if (reviewed && live && reviewed === live) {
    return { status: 'ok', reason: 'head-unchanged', reviewedHead: reviewed, liveHead: live };
  }
  // Structurally-invalid inputs are NOT a clobber signal and must NOT fail closed:
  // a non-SHA head cannot be a real GitHub merge head (GitHub would reject the
  // merge itself), so there is nothing to verify and no way for a clobber to reach
  // main through it. Blocking here would only wedge the lane on malformed or
  // non-production inputs. The meaningful fail-closed case is a RUNTIME
  // verification failure (gh unreachable), handled in the catch below.
  if (!reviewed || !live) {
    return { status: 'skipped', reason: 'clobber-guard-not-applicable-missing-heads', reviewedHead: reviewed, liveHead: live };
  }
  if (!VALID_GITHUB_REPO_SLUG.test(String(repo || '')) || !SHA_RE.test(reviewed) || !SHA_RE.test(live)) {
    return { status: 'skipped', reason: 'clobber-guard-not-applicable-bad-inputs', reviewedHead: reviewed, liveHead: live };
  }
  if (typeof execGh !== 'function') {
    return { status: 'skipped', reason: 'clobber-guard-not-applicable-no-gh', reviewedHead: reviewed, liveHead: live };
  }

  try {
    const reviewedOnly = await rangePatchIds({ execGh, repo, baseSha: live, headSha: reviewed, spawnImpl });
    const liveOnly = await rangePatchIds({ execGh, repo, baseSha: reviewed, headSha: live, spawnImpl });
    const contentEquivalence = compareReviewedPatchIds(reviewedOnly.patchIds, liveOnly.patchIds);
    if (contentEquivalence.dropped.length > 0) {
      return {
        status: 'clobber',
        reason: 'reviewed-content-dropped-on-rebase',
        reviewedHead: reviewed,
        liveHead: live,
        dropped: contentEquivalence.dropped,
        droppedCount: contentEquivalence.dropped.length,
        reviewedOnlyCommits: reviewedOnly.shas,
        liveOnlyCommits: liveOnly.shas,
        contentEquivalence,
      };
    }
    return {
      status: 'ok',
      reason: 'reviewed-content-preserved',
      reviewedHead: reviewed,
      liveHead: live,
      contentEquivalence,
    };
  } catch (err) {
    logger?.warn?.(
      `[clobber-guard] content verification failed for ${repo} ` +
        `${reviewed.slice(0, 12)}->${live.slice(0, 12)}: ${err?.message || err}`,
    );
    return {
      status: 'unverifiable',
      reason: 'clobber-guard-verification-error',
      reviewedHead: reviewed,
      liveHead: live,
      error: String(err?.message || err),
    };
  }
}

// True when the guard result must NOT authorize a content-blind merge (the caller
// declines and falls through to the capped hammer). `ok` and `skipped` proceed.
export function clobberGuardBlocks(result) {
  return result?.status === 'clobber' || result?.status === 'unverifiable';
}
