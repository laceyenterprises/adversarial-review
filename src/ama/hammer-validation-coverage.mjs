import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHammerValidationEvidence } from '../hammer-pr-read.mjs';

const mirrorDir = 'scripts/ci-mirror';
const manifestName = /^checks(?:\.[\w-]+)?\.json$/;
const manifestLimit = 1024 * 1024;

async function manifestBytes(get, repo, path, ref) {
  const remote = await get(`repos/${repo}/contents/${path}?ref=${ref}`);
  if (remote.type !== 'file' || remote.path !== path || remote.encoding !== 'base64'
    || typeof remote.content !== 'string') throw new Error('Invalid manifest response');
  const encoded = remote.content.replace(/\r?\n/g, '');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) throw new Error('Invalid manifest encoding');
  return decoded;
}

export function coverageDeclarations(bytes) {
  const manifest = JSON.parse(bytes);
  let entries;
  const invalidEntries = new Set();
  const current = Object.hasOwn(manifest, 'checks');
  if (current) {
    if (Object.hasOwn(manifest, 'path-glob') || !manifest.checks
      || typeof manifest.checks !== 'object' || Array.isArray(manifest.checks)) throw new Error('Invalid mirror registry');
    entries = Object.entries(manifest.checks).flatMap(([id, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      if (Array.isArray(entry.runs) && !entry.runs.includes('pre-push')) return [];
      const paths = entry.paths === undefined ? (entry.suite?.paths ?? []) : entry.paths;
      const row = { name: id, ...entry };
      if (!Array.isArray(entry.runs) || !entry.runs.every(lane => typeof lane === 'string')
        || !Array.isArray(paths) || !paths.every(path => typeof path === 'string')
        || (entry.path_order && (!Array.isArray(entry.path_order) || entry.path_order.length !== paths.length))) {
        invalidEntries.add(row);
      }
      return [row];
    });
  } else {
    const globs = manifest['path-glob'];
    if (!globs || typeof globs !== 'object' || Array.isArray(globs)) throw new Error('Invalid mirror manifest');
    entries = Object.values(globs).flatMap(rows => {
      if (!Array.isArray(rows)) throw new Error('Invalid mirror manifest entries');
      return rows;
    });
  }
  const localPaths = Object.keys(manifest['ratchet-placement']?.['local-only'] || {});
  const checks = new Map();
  for (const entry of entries) {
    const { name, command, local_advisory_arg: localAdvisory } = entry;
    if (typeof name !== 'string' || typeof command !== 'string') {
      if (current) continue;
      throw new Error('Invalid mirror check');
    }
    const key = JSON.stringify([name, command]);
    const local = ['local_only', 'local-only'].some(marker => Object.hasOwn(entry, marker) && entry[marker] !== false)
      || localAdvisory != null || localPaths.some(path => path && command.includes(path))
      || (current && (entry.advisory === true || entry['ratchet-placement']?.scope === 'local-only'));
    const jobs = current ? (!invalidEntries.has(entry) && entry.runs.includes('ci') && entry.ci
      ? [{ job: entry.ci.job, step: entry.ci.name }] : undefined) : entry.ci_jobs;
    let mapping;
    if (invalidEntries.has(entry)) mapping = { reason: 'invalid-ci-mapping' };
    else if (local) mapping = { reason: 'local-only' };
    else if (jobs === undefined) mapping = { reason: 'no-ci-mapping' };
    else if (Array.isArray(jobs) && jobs.length && jobs.every(job => current
      ? [job.job, job.step].every(value => typeof value === 'string' && value && value.trim() === value)
      : typeof job === 'string' && job && job.trim() === job)) {
      mapping = { jobs: current ? jobs : [...new Set(jobs)].sort() };
    } else mapping = { reason: 'invalid-ci-mapping' };
    const previous = checks.get(key);
    checks.set(key, !previous || JSON.stringify(previous) === JSON.stringify(mapping) ? mapping
      : { reason: previous.reason === 'local-only' || local ? 'local-only' : 'ambiguous-ci-mapping' });
  }
  return checks;
}

function jobEvidence(repo, head, mapping, rows, details = new Map()) {
  const job = typeof mapping === 'string' ? mapping : mapping.job;
  const matches = rows.filter(row => row?.name === job);
  if (!matches.length) return { reason: 'ci-job-missing' };
  if (matches.length !== 1) return { reason: 'ci-job-ambiguous' };
  const [row] = matches;
  if (row.head_sha !== head) return { reason: 'ci-job-head-mismatch' };
  if (row.status !== 'completed') return { reason: 'ci-job-incomplete' };
  if (row.conclusion !== 'success') return { reason: `ci-job-${['skipped', 'neutral', 'failure', 'cancelled', 'timed_out'].includes(row.conclusion)
    ? row.conclusion : 'not-successful'}` };
  const url = typeof row.details_url === 'string' ? row.details_url : '';
  const link = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)(?:\?pr=[1-9]\d*)?$/i.exec(url);
  if (row.app?.slug !== 'github-actions' || link?.[1].toLowerCase() !== repo.toLowerCase()) return { reason: 'ci-job-identity-unverified' };
  if (typeof mapping !== 'string') {
    const detail = details.get(link[3]);
    if (!detail) return { reason: 'ci-step-read-failed' };
    if (detail.reason === 'ci-budget-deferred') return { reason: detail.reason };
    if (String(detail.id) !== link[3] || String(detail.run_id) !== link[2]
      || detail.head_sha !== head || detail.name !== job || detail.status !== 'completed'
      || detail.conclusion !== 'success') return { reason: 'ci-step-job-mismatch' };
    const steps = Array.isArray(detail.steps) ? detail.steps.filter(step => step.name === mapping.step) : [];
    if (steps.length !== 1) return { reason: steps.length ? 'ci-step-ambiguous' : 'ci-step-missing' };
    if (steps[0].status !== 'completed' || steps[0].conclusion !== 'success') return { reason: 'ci-step-not-successful' };
  }
  return { name: job, runId: link[2],
    ...(typeof mapping !== 'string' ? { jobId: link[3], step: mapping.step } : {}) };
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
      const checks = coverageDeclarations(bytes);
      hasMapping ||= [...checks.values()].some(check => check.jobs);
      manifests.set(path, { bytes, checks });
    }
  } catch { return fallback('manifest-read-failed'); }

  let rows = [];
  const jobDetails = new Map();
  let checkReadFailure;
  if (hasMapping) {
    const timeoutMs = 20_000;
    try {
      const evidence = await fetchHammerValidationEvidence(repo, prNumber, head, async (get, pages, base) => {
        if (!/^[a-f\d]{40}$/.test(base || '')) throw new Error('Invalid base SHA');
        let verifiedMapping = false;
        for (const [path, manifest] of manifests) {
          if (![...manifest.checks.values()].some(check => check.jobs)) continue;
          try {
            const decoded = await manifestBytes(get, repo, path, head);
            if (!manifest.bytes.equals(decoded)) {
              manifest.reason = 'manifest-head-mismatch';
            } else if (!decoded.equals(await manifestBytes(get, repo, path, base))) {
              manifest.reason = 'manifest-base-mismatch';
            } else verifiedMapping = true;
          } catch (error) {
            manifest.reason = error?.budgetDeferred ? 'ci-budget-deferred' : 'manifest-read-failed';
          }
        }
        if (verifiedMapping) {
          const checks = [];
          for await (const page of pages()) checks.push(...page);
          // Current registries map individual workflow steps, which may be
          // skipped inside an otherwise green job. A job alone is insufficient.
          const names = new Set([...manifests.values()].filter(manifest => !manifest.reason).flatMap(manifest =>
            [...manifest.checks.values()].flatMap(mapping => (mapping.jobs || [])
              .filter(job => typeof job !== 'string').map(job => job.job))));
          const ids = new Set();
          for (const row of checks) {
            if (!names.has(row?.name) || jobEvidence(repo, head, row.name, checks).reason) continue;
            const match = /\/job\/([1-9]\d*)(?:\?pr=[1-9]\d*)?$/.exec(row.details_url);
            if (match) ids.add(match[1]);
          }
          // Existing read deadline and quota reserve govern these extra reads.
          for (const id of ids) {
            try { jobDetails.set(id, await get(`repos/${repo}/actions/jobs/${id}`)); }
            catch (error) {
              if (error?.budgetDeferred) {
                for (const unread of ids) {
                  if (!jobDetails.has(unread)) jobDetails.set(unread, { reason: 'ci-budget-deferred' });
                }
                break;
              }
              // This step remains local when its evidence is unavailable.
              jobDetails.set(id, null);
            }
          }
          return checks;
        }
        return [];
      }, { env, signal: AbortSignal.timeout(timeoutMs), credentialDeadlineMs: Date.now() + timeoutMs });
      if (evidence === null) checkReadFailure = 'live-head-mismatch';
      else rows = evidence;
    } catch (error) { checkReadFailure = error?.budgetDeferred ? 'ci-budget-deferred' : 'ci-check-read-failed'; }
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
        const jobs = mapping.jobs.map(job => jobEvidence(repo, head, job, rows, jobDetails));
        const refused = jobs.find(job => job.reason);
        return { name, command, ...(refused ? { reason: refused.reason } : { jobs }) };
      }),
    }])),
  };
}
