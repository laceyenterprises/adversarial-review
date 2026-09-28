#!/usr/bin/env node
// One bounded GitHub snapshot; no Agent OS installation or local daemon required.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repo, number, flag, statePath] = process.argv.slice(2);
if (!/^[^/\s]+\/[^/\s]+$/.test(repo || '') || !/^[1-9]\d*$/.test(number || '') || (flag && (flag !== '--state-file' || !statePath))) {
  process.stderr.write('usage: hammer-context.mjs owner/repo pr [--state-file local-state.json]\n');
  process.exit(64);
}
function get(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${(result.stderr || result.error?.message || '').slice(-500)}`);
  return JSON.parse(result.stdout);
}
function compact(value, max = 1200) { return String(value || '').slice(0, max); }
try {
  const pr = get(['api', `repos/${repo}/pulls/${number}`]);
  const reviews = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = get(['api', `repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error('review API did not return an array');
    reviews.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw new Error('review pagination exceeded ten pages');
  }
  const checks = get(['pr', 'view', number, '--repo', repo, '--json', 'statusCheckRollup']);
  let protection;
  try { protection = get(['api', `repos/${repo}/branches/${encodeURIComponent(pr.base?.ref || 'main')}/protection`]); }
  catch { protection = { required_status_checks: null, unavailable: true }; }
  const head = pr.head?.sha || null;
  const currentReviews = Array.isArray(reviews) ? reviews.filter((r) => r.commit_id === head) : [];
  const verdict = currentReviews.filter((r) => r.state !== 'COMMENTED').at(-1);
  const localRoot = resolve(process.env.HAM_ROOT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (!statePath) {
    const jobsDir = join(localRoot, 'data', 'follow-up-jobs', 'in-progress');
    if (existsSync(jobsDir)) {
      for (const name of readdirSync(jobsDir).filter((entry) => entry.endsWith('.json'))) {
        try {
          const job = JSON.parse(readFileSync(join(jobsDir, name), 'utf8'));
          if (String(job.repo).toLowerCase() === repo.toLowerCase() && Number(job.prNumber) === Number(number)) {
            state.activeRemediation = { jobId: job.jobId, status: job.status, workerClass: job.workerClass || null };
            break;
          }
        } catch { /* An unreadable job does not replace live PR evidence. */ }
      }
    }
    const slug = (value) => value.replace(/[^A-Za-z0-9._-]/g, '-');
    const leaseFile = join(localRoot, 'data', 'merge-leases', `${slug(repo.replace(/\//g, '__'))}__${slug(pr.base?.ref || 'main')}.json`);
    if (existsSync(leaseFile)) {
      try {
        const lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
        state.activeLease = { leaseId: lease.leaseId, holderPr: lease.holderPr, holderHead: lease.holderHead, deadlineAt: lease.deadlineAt };
      } catch { /* Unreadable local lease is reported as unavailable below. */ }
    }
  }
  const output = {
    pr: { repo, number: Number(number), state: pr.state, merged: Boolean(pr.merged_at), draft: Boolean(pr.draft), mergeable: pr.mergeable, mergeableState: pr.mergeable_state, base: pr.base?.ref },
    head,
    review: verdict ? { state: verdict.state, author: verdict.user?.login, submittedAt: verdict.submitted_at, findings: compact(verdict.body, 1800) } : null,
    requiredChecks: protection.required_status_checks?.contexts || protection.required_status_checks?.checks?.map((c) => c.context) || [],
    checks: (checks.statusCheckRollup || []).slice(0, 40).map((c) => ({ name: c.name || c.context, conclusion: c.conclusion || c.state || c.status })),
    diffStat: { files: pr.changed_files ?? null, additions: pr.additions ?? null, deletions: pr.deletions ?? null },
    conflictsVersusBase: pr.mergeable == null ? null : pr.mergeable === false || pr.mergeable_state === 'dirty',
    activeRemediation: state.activeRemediation || null,
    activeLease: state.activeLease || null,
    localStateAvailable: Boolean(statePath || existsSync(join(localRoot, 'data'))),
  };
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized) > 8192) throw new Error('snapshot exceeds 8192 bytes');
  process.stdout.write(`${serialized}\n`);
} catch (error) {
  process.stderr.write(`${compact(error.message, 800)}\n`);
  process.exitCode = 1;
}
