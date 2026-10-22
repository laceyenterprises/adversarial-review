import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { meteredExecFile } from './metered-gh.mjs';
import { immutableSnapshotValue } from './closure-evaluation-cache.mjs';
import { readPostedReviewResource } from './posted-review-read-cache.mjs';

const execFileAsync = promisify(execFile);

// Read-only seam for posted-review scheduling. Guard actions remain in the
// normal candidate evaluation, after the handler's review/scope checks.
export async function fetchMergeAgentCandidateSnapshot(repo, prNumber, {
  execFileImpl = execFileAsync, signal = null, env = process.env, currentHeadSha = null,
} = {}) {
  signal?.throwIfAborted();
  return readPostedReviewResource('candidate-pr', repo, prNumber,
    { execFileImpl, signal, env, currentHeadSha }, async () => {
      const { stdout } = await meteredExecFile(execFileImpl,
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          repo,
          '--json',
          'mergeable,mergeStateStatus,headRefName,baseRefName,baseRefOid,headRefOid,isDraft,title,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
        ],
        { env, maxBuffer: 5 * 1024 * 1024, ...(signal ? { signal } : {}) }
      );
      signal?.throwIfAborted();
      const value = immutableSnapshotValue(JSON.parse(String(stdout || '{}')));
      return value;
    }, { headOf: value => value?.headRefOid });
}

// The candidate's existing four-read bound, also used for observational inputs.
// All started work settles, including when a sibling read fails.
export async function settleCandidateSnapshotReads(reads) {
  let cursor = 0;
  const results = new Array(reads.length);
  await Promise.all(Array.from({ length: Math.min(4, reads.length) }, async () => {
    while (cursor < reads.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await reads[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

const SNAPSHOT_SOURCES = Object.freeze([
  'pr', 'candidate', 'checks', 'reviews', 'remediation', 'launches', 'leases',
  'controls', 'policy', 'progress', 'history',
]);

/**
 * One logical observation per subject/head/generation in one caller-owned pass.
 * Sources are existing bounded readers: { read, sourceRef, validate? }. They may
 * return { state: 'complete'|'unknown'|'error', value, provenance?, error? } to
 * preserve partial-read provenance. Missing sources remain explicitly unknown.
 * This is collection only; no eligibility, clocks, leases or alerts are changed.
 */
export function createMergeAgentSnapshotPass({ now = Date.now, passId = randomUUID() } = {}) {
  const subjects = new Map();
  let generation = 0;
  let open = true;
  const invalidate = subjectKey => { subjects.delete(subjectKey); };
  const collect = ({ subjectKey, head = null, sources = {}, anchors = {}, signal = null }) => {
    signal?.throwIfAborted();
    const previous = subjects.get(subjectKey);
    if (open && previous && previous.head === head && previous.signal === signal) return previous.promise;
    const entry = { head, generation: ++generation, signal };
    const observedAt = new Date(now()).toISOString();
    // Durable anchors come from existing owners, never from this poll's clock.
    const timing = immutableSnapshotValue(anchors);
    entry.promise = (async () => {
      const results = await settleCandidateSnapshotReads(SNAPSHOT_SOURCES.map(name => async () => {
        const source = sources[name];
        const provenance = { sourceRef: source?.sourceRef ?? null, requestedHead: head, observedAt };
        if (!source) return { state: 'unknown', value: null, provenance };
        try {
          signal?.throwIfAborted();
          const raw = immutableSnapshotValue(await source.read({ subjectKey, head, signal }));
          const observation = raw && Object.hasOwn(raw, 'value') && ['complete', 'unknown', 'error'].includes(raw.state)
            ? raw : { state: raw == null ? 'unknown' : 'complete', value: raw };
          if (observation.state === 'complete' && (observation.value == null
            || typeof observation.value !== 'object'
            || source.validate?.(observation.value) === false)) throw new TypeError('malformed snapshot evidence');
          return immutableSnapshotValue({ ...observation,
            provenance: { ...provenance, ...observation.provenance } });
        } catch (error) {
          // Keep read failure explicit without copying argv, credentials or
          // provider diagnostics into a snapshot that may later be reported.
          return { state: 'error', value: null, provenance,
            error: { name: error?.name || 'Error', code: error?.code ?? null } };
        }
      }));
      signal?.throwIfAborted();
      const observations = Object.fromEntries(SNAPSHOT_SOURCES.map((name, i) => [name, results[i].value]));
      const pr = observations.pr.value;
      const observedHead = pr?.headRefOid ?? pr?.headSha ?? null;
      if (observedHead && observedHead !== head && subjects.get(subjectKey) === entry) invalidate(subjectKey);
      const snapshot = immutableSnapshotValue({ subjectKey, head: observedHead || head, requestedHead: head, passId, generation: entry.generation,
        observedAt, anchors: timing, observations });
      entry.value = snapshot;
      return snapshot;
    })();
    if (open) subjects.set(subjectKey, entry);
    return entry.promise;
  };
  return Object.freeze({ collect, invalidate,
    isCurrent: snapshot => open && snapshot != null && subjects.get(snapshot.subjectKey)?.value === snapshot,
    close: () => { open = false; subjects.clear(); },
  });
}
