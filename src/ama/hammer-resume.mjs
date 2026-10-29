import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { amaAuditFilePath, readAmaAuditEntry, appendAmaAuditAttempt } from './audit.mjs';

// A pending-CI receipt conveys dispatch intent, never review or merge authority.
// Keep it outstanding until a confirmed dispatch or an explicit supersession.
export function readHammerResumes({ hqRoot, repo, prNumber }) {
  if (!hqRoot || !repo || !prNumber) return [];
  const prefix = `${String(repo).replace(/\//g, '-')}-pr-${Number(prNumber)}-`;
  let names;
  try { names = readdirSync(dirname(amaAuditFilePath(hqRoot, repo, prNumber, 'head'))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pending = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const headSha = name.slice(prefix.length, -5);
    const doc = readAmaAuditEntry(hqRoot, repo, prNumber, headSha);
    if (doc?.repo !== repo || Number(doc.prNumber) !== Number(prNumber) || doc.headSha !== headSha
      || doc.status === 'succeeded') continue;
    const attempts = doc.attempts || [];
    const stop = attempts.findLast(attempt => attempt.resumeOwed === true
      && attempt.reason === 'required-checks-pending' && attempt.outcome === 'deferred'
      && attempt.resumeHead === headSha);
    if (!stop || !Number.isInteger(stop.attemptNumber) || stop.attemptNumber < 1 || attempts.some(attempt => attempt.resumeAttempt === stop.attemptNumber
      && attempt.attemptPhase === 'hammer-resume')) continue;
    // A later final-helper result supersedes an older debt, even if its own
    // outcome is a new refusal. Never resurrect a real finding/check failure.
    if (attempts.some(attempt => attempt.attemptNumber > stop.attemptNumber
      && attempt.attemptPhase === 'hammer-gh-pr-merge')) continue;
    pending.push({ headSha, attemptNumber: stop.attemptNumber });
  }
  return pending;
}

export function settleHammerResume({ hqRoot, repo, prNumber, resume, reason, now, launchRequestId = null }) {
  return appendAmaAuditAttempt({ hqRoot, repo, prNumber, headSha: resume.headSha, now,
    attempt: { outcome: reason === 'dispatched' ? 'in_progress' : 'superseded',
      attemptPhase: 'hammer-resume', reason: `resume-${reason}`, resumeOwed: false,
      resumeHead: resume.headSha, resumeAttempt: resume.attemptNumber, launchRequestId,
      deliveryKey: `hammer-resume:${resume.attemptNumber}` } });
}

export function reconcileHammerResumes({ hqRoot, repo, prNumber, headSha, prState, checks, now, readOnly = false }) {
  if (!headSha || !['OPEN', 'CLOSED', 'MERGED'].includes(String(prState).toUpperCase())) return null;
  let matching = null;
  for (const resume of readHammerResumes({ hqRoot, repo, prNumber })) {
    const reason = String(prState).toUpperCase() !== 'OPEN' ? 'pr-terminal'
      : resume.headSha !== headSha ? 'head-moved'
        : checks && !['SUCCESS', 'PENDING'].includes(checks) ? 'checks-red' : null;
    if (reason) {
      if (!readOnly) settleHammerResume({ hqRoot, repo, prNumber, resume, reason, now });
    } else matching = resume;
  }
  return matching;
}
