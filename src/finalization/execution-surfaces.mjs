// Merge Authority v2 executor surfaces (ARC-17; docs/SPEC-merge-authority-v2.md
// §4). The executor performs mutating actions through injected SEAMS, never by
// reaching directly for an adapter:
//
//   - merge  → the ARC-20 adjudicate surface when present, with github-adapter
//              `pull-request-merge` as the LOCAL-MODE FALLBACK (§4).
//   - close  → the same adjudicate surface, github-adapter `pull-request-merge`
//              having no close verb → github-adapter is merge-only; a close falls
//              back to whatever local `close` the caller injects.
//   - identity/attestation → the ARC-22 surface, read-through and FAIL-CLOSED:
//              a present surface that denies blocks the merge; its absence is
//              local mode, where the adapter enforces its own token identity.
//
// ARC-20 and ARC-22 live in the agent-os superproject (declared XRW additional
// repo) and are injected. This module owns only the resolution + the local
// github-adapter fallback so the executor stays domain-agnostic and testable.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { writeAdapterPullRequestMerge } from '../github-adapter-client.mjs';

const execFileAsync = promisify(execFile);

/** Parse a `code-pr` subject external id (`owner/repo#123`) into repo + pr. */
export function parseCodePrSubject(subjectExternalId) {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(String(subjectExternalId ?? '').trim());
  if (!m) return null;
  return { repo: m[1], prNumber: Number(m[2]) };
}

/**
 * The github-adapter local-mode merge fallback (§4). Merges the PR at the
 * decided revision by passing `matchHeadCommit: revisionRef` — GitHub then
 * refuses a merge whose head moved, so a stale-revision merge is structurally
 * impossible to issue even if a re-fold guard is somehow bypassed.
 *
 * @param {{ mergeMethod?: string, execFileImpl?: Function, env?: NodeJS.ProcessEnv, rootDir?: string }} [config]
 */
export function createGithubAdapterMergeSurface({
  mergeMethod: defaultMergeMethod = 'squash',
  execFileImpl = execFileAsync,
  env = process.env,
  rootDir,
} = {}) {
  return {
    name: 'github-adapter (local fallback)',
    async merge({ subjectExternalId, revisionRef, mergeMethod }) {
      const parsed = parseCodePrSubject(subjectExternalId);
      if (!parsed) {
        return { ok: false, reason: 'unsupported-subject', detail: `not a code-pr subject: ${subjectExternalId}` };
      }
      if (!revisionRef) {
        return { ok: false, reason: 'no-revision', detail: 'refusing merge without a decided revision' };
      }
      let result;
      try {
        result = await writeAdapterPullRequestMerge(parsed.repo, parsed.prNumber, {
          matchHeadCommit: revisionRef,
          mergeMethod: mergeMethod || defaultMergeMethod,
          deleteBranch: true,
        }, { execFileImpl, env, rootDir });
      } catch (err) {
        return { ok: false, reason: 'adapter-error', detail: err?.message || String(err) };
      }
      // A null return means the adapter binary was not resolvable — local mode is
      // not actually available; fail closed rather than reporting a phantom merge.
      if (!result || result.ran !== true) {
        return { ok: false, reason: 'adapter-unavailable', detail: 'github adapter binary not resolvable' };
      }
      const payload = result.payload ?? {};
      const merged = payload.merged === true || payload.state === 'MERGED' || payload.ok === true;
      if (!merged) {
        return { ok: false, reason: 'merge-refused', detail: JSON.stringify(payload).slice(0, 500), payload };
      }
      return { ok: true, payload };
    },
  };
}

/**
 * Resolve the executor's merge surface: prefer the injected ARC-20 adjudicate
 * surface; otherwise fall back to a github-adapter local surface. Returns null
 * only when neither is available (the executor then fails closed to escalate).
 *
 * @param {{ adjudicateSurface?: object | null, localFallback?: object | null,
 *   githubAdapter?: object }} args
 */
export function resolveMergeSurface({ adjudicateSurface = null, localFallback = null, githubAdapter } = {}) {
  if (adjudicateSurface && typeof adjudicateSurface.merge === 'function') return adjudicateSurface;
  if (localFallback && typeof localFallback.merge === 'function') return localFallback;
  if (githubAdapter && typeof githubAdapter.merge === 'function') return githubAdapter;
  return null;
}

/**
 * Read an identity/attestation verdict through the ARC-22 surface, FAIL-CLOSED.
 * A present surface is authoritative: its `{ ok:false }` (or a throw) blocks the
 * merge. Its ABSENCE is local mode — the adapter enforces its own token identity
 * — so a missing surface returns `ok:true` with a `localMode` marker rather than
 * inventing a denial.
 *
 * @param {object | null | undefined} identitySurface ARC-22 surface (or null)
 * @param {{ subjectKey: object, revisionRef: string, decision: object }} ctx
 */
export async function checkIdentityAttestation(identitySurface, ctx) {
  if (!identitySurface || typeof identitySurface.check !== 'function') {
    return { ok: true, localMode: true };
  }
  try {
    const verdict = await identitySurface.check(ctx);
    if (verdict && verdict.ok === true) return { ok: true, ...verdict };
    return {
      ok: false,
      reason: verdict?.reason || 'identity/attestation check denied',
    };
  } catch (err) {
    return { ok: false, reason: `identity/attestation surface error (fail-closed): ${err?.message || err}` };
  }
}
