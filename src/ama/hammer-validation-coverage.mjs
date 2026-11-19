import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHammerValidationEvidence } from '../hammer-pr-read.mjs';

const mirrorDir = 'scripts/ci-mirror';
const manifestName = /^checks(?:\.[\w-]+)?\.json$/;
const manifestLimit = 1024 * 1024;

function declarations(bytes) {
  const manifest = JSON.parse(bytes);
  const globs = manifest['path-glob'];
  if (!globs || typeof globs !== 'object' || Array.isArray(globs)) throw new Error('Invalid mirror manifest');
  const localPaths = Object.keys(manifest['ratchet-placement']?.['local-only'] || {});
  const checks = new Map();
  for (const entries of Object.values(globs)) {
    if (!Array.isArray(entries)) throw new Error('Invalid mirror manifest entries');
    for (const entry of entries) {
      const { name, command, ci_jobs: jobs, local_advisory_arg: localAdvisory } = entry;
      if (typeof name !== 'string' || typeof command !== 'string') throw new Error('Invalid mirror check');
      const key = JSON.stringify([name, command]);
      const local = ['local_only', 'local-only'].some(marker => Object.hasOwn(entry, marker) && entry[marker] !== false)
        || localAdvisory != null || localPaths.some(path => path && command.includes(path));
      let mapping;
      if (local) mapping = { reason: 'local-only' };
      else if (jobs === undefined) mapping = { reason: 'no-ci-mapping' };
      else if (Array.isArray(jobs) && jobs.length
        && jobs.every(job => typeof job === 'string' && job && job.trim() === job)) {
        mapping = { jobs: [...new Set(jobs)].sort() };
      } else mapping = { reason: 'invalid-ci-mapping' };
      const previous = checks.get(key);
      checks.set(key, !previous || JSON.stringify(previous) === JSON.stringify(mapping) ? mapping
        : { reason: previous.reason === 'local-only' || local ? 'local-only' : 'ambiguous-ci-mapping' });
    }
  }
  return checks;
}

function jobEvidence(repo, head, job, rows) {
  const matches = rows.filter(row => row?.name === job);
  if (!matches.length) return { reason: 'ci-job-missing' };
  if (matches.length !== 1) return { reason: 'ci-job-ambiguous' };
  const [row] = matches;
  if (row.head_sha !== head) return { reason: 'ci-job-head-mismatch' };
  if (row.status !== 'completed') return { reason: 'ci-job-incomplete' };
  if (row.conclusion !== 'success') return { reason: `ci-job-${['skipped', 'neutral', 'failure', 'cancelled', 'timed_out'].includes(row.conclusion)
    ? row.conclusion : 'not-successful'}` };
  const url = typeof row.details_url === 'string' ? row.details_url : '';
  const link = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)\/job\/[1-9]\d*(?:\?pr=[1-9]\d*)?$/i.exec(url);
  if (row.app?.slug !== 'github-actions' || link?.[1].toLowerCase() !== repo.toLowerCase()) return { reason: 'ci-job-identity-unverified' };
  return { name: job, runId: link[2] };
}

export async function hammerValidationCoverage({ root, repo, prNumber, head, enabled, env }) {
  const fallback = reason => ({ reason, manifests: {} });
  if (!enabled) return fallback('ci-dedup-disabled');
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repo || '') || !/^[a-f\d]{40}$/.test(head || '')) {
    return fallback('validation-head-unavailable');
  }
  const manifests = new Map();
  let hasMapping = false;
  try {
    for (const filename of readdirSync(join(root, mirrorDir)).filter(name => manifestName.test(name))) {
      const path = `${mirrorDir}/${filename}`;
      const stat = lstatSync(join(root, path));
      if (!stat.isFile() || stat.size > manifestLimit) return fallback('manifest-read-failed');
      const bytes = readFileSync(join(root, path));
      const checks = declarations(bytes);
      hasMapping ||= [...checks.values()].some(check => check.jobs);
      manifests.set(path, { bytes, checks });
    }
  } catch { return fallback('manifest-read-failed'); }

  let rows = [];
  let checkReadFailure;
  if (hasMapping) {
    const timeoutMs = 20_000;
    try {
      const evidence = await fetchHammerValidationEvidence(repo, prNumber, head, async (get, pages) => {
        let verifiedMapping = false;
        for (const [path, manifest] of manifests) {
          if (![...manifest.checks.values()].some(check => check.jobs)) continue;
          try {
            const remote = await get(`repos/${repo}/contents/${path}?ref=${head}`);
            if (remote.type !== 'file' || remote.path !== path || remote.encoding !== 'base64'
              || typeof remote.content !== 'string') throw new Error('Invalid manifest response');
            const encoded = remote.content.replace(/\r?\n/g, '');
            const decoded = Buffer.from(encoded, 'base64');
            if (decoded.toString('base64') !== encoded) throw new Error('Invalid manifest encoding');
            if (!manifest.bytes.equals(decoded)) {
              manifest.reason = 'manifest-head-mismatch';
            } else verifiedMapping = true;
          } catch { manifest.reason = 'manifest-read-failed'; }
        }
        if (verifiedMapping) {
          const checks = [];
          for await (const page of pages()) checks.push(...page);
          return checks;
        }
        return [];
      }, { env, signal: AbortSignal.timeout(timeoutMs), credentialDeadlineMs: Date.now() + timeoutMs });
      if (evidence === null) checkReadFailure = 'live-head-mismatch';
      else rows = evidence;
    } catch { checkReadFailure = 'ci-check-read-failed'; }
  }

  return {
    reason: 'no-ci-mapping',
    manifests: Object.fromEntries([...manifests].map(([path, { bytes, checks, reason }]) => [path, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      checks: [...checks].map(([key, mapping]) => {
        const [name, command] = JSON.parse(key);
        if (!mapping.jobs) return { name, command, reason: mapping.reason };
        const readFailure = reason || checkReadFailure;
        if (readFailure) return { name, command, reason: readFailure };
        const jobs = mapping.jobs.map(job => jobEvidence(repo, head, job, rows));
        const refused = jobs.find(job => job.reason);
        return { name, command, ...(refused ? { reason: refused.reason } : { jobs }) };
      }),
    }])),
  };
}
