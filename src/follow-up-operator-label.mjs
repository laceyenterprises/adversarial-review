import { execFileSync } from 'node:child_process';
import { meteredExecFileSync } from './metered-gh.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';

export function requiredFollowUpOperatorLabel(job) {
  if (job?.status !== 'stopped') return null;
  const code = job.remediationPlan?.stop?.code || '';
  const prefix = 'operator-label-required:';
  return code.startsWith(prefix) ? code.slice(prefix.length).trim() || null : null;
}

// Queue writers are synchronous. Like branch resolution, this live read is
// bounded and injectable; no cached PR labels or caller-supplied waiver suffice.
export function readFollowUpOperatorLabel({ repo, prNumber, label }, {
  execFileSyncImpl = execFileSync,
} = {}) {
  if (process.env.NODE_TEST_CONTEXT && execFileSyncImpl === execFileSync) {
    throw new Error('offline tests must inject the operator-label reader');
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo || '') || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error('Invalid PR identity for operator-label read');
  }
  const read = args => JSON.parse(meteredExecFileSync(execFileSyncImpl, 'gh', ['api', ...args], {
    encoding: 'utf8', timeout: loadAwareTimeoutMs(8000), maxBuffer: 2 * 1024 * 1024,
  }));
  const pages = read([`repos/${repo}/issues/${Number(prNumber)}/events?per_page=100`, '--paginate', '--slurp']);
  const event = pages.flat().filter(event => event.event === 'labeled'
    && event.label?.name === label).at(-1);
  // Read presence after history: a removed label must never release this stop.
  const pr = read([`repos/${repo}/pulls/${Number(prNumber)}`]);
  if (!pr.labels?.some(item => item.name === label) || !event?.id || !event.actor?.login || !event.created_at) return null;
  return { repo, prNumber: Number(prNumber), label, eventId: String(event.id),
    actor: event.actor.login, appliedAt: event.created_at, headSha: pr.head?.sha || null,
    observedAt: new Date().toISOString() };
}

// Shared by stopped-job rearming and review-only waiver observation. Presence
// comes from the live reader; cached labels cannot satisfy this predicate.
export function operatorLabelEvidenceSatisfies({ repo, prNumber, label, headSha = null, after = null }, evidence) {
  const applied = Date.parse(evidence?.appliedAt);
  const boundary = after === null ? null : Date.parse(after);
  return Boolean(label && evidence?.label === label && evidence.repo === repo
    && Number(evidence.prNumber) === Number(prNumber) && evidence.eventId
    && evidence.actor && Number.isFinite(applied) && evidence.observedAt
    && (!headSha || evidence.headSha === headSha)
    && (after === null || (Number.isFinite(boundary) && applied > boundary)));
}

export function operatorLabelSatisfiesStop(job, evidence) {
  return operatorLabelEvidenceSatisfies({ repo: job.repo, prNumber: job.prNumber,
    label: requiredFollowUpOperatorLabel(job) }, evidence);
}
