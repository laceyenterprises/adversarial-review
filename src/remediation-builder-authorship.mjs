import { normalizeBuilderClass, isCrossModelReviewWaived } from './adapters/subject/github-pr/routing.mjs';
import { builderClassFromTitle } from './adapters/subject/github-pr/title-tagging.mjs';
import { readDaemonBuildIdentity } from './daemon-worker-identity.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { requeueClaimedFollowUpJobBeforeSpawn } from './remediation-claimed-requeue.mjs';
import { writeFollowUpJob, markFollowUpJobStopped } from './follow-up-jobs.mjs';

// Read the stable opener, without head binding: remediation can move the head.
// Only the recovery path reads these sources; ordinary tagged jobs keep their route.
export async function readRemediationBuilderEvidence({ rootDir, job, execFileImpl, env = process.env,
  readIdentityImpl = readDaemonBuildIdentity }) {
  let pr = {};
  let prRead = 'available';
  try {
    const result = await execGhWithRetry({ execFileImpl, args: ['pr', 'view', String(job.prNumber),
      '--repo', job.repo, '--json', 'title,body'], env, timeoutMs: 8000,
    retries: 2, totalTimeoutMs: 15000 });
    pr = JSON.parse(result.stdout);
  } catch {
    prRead = 'unavailable';
  }
  let identity;
  try {
    identity = await readIdentityImpl({ rootDir, repo: job.repo, prNumber: job.prNumber, env });
  } catch {
    identity = { ok: false, reason: 'unavailable' };
  }
  const rows = identity?.ok ? identity.rows : [];
  return {
    title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : '',
    openerClasses: (rows || []).map(row => row.worker_class || row.workerClass || ''),
    availability: { pr: prRead, pr_opened: identity?.ok ? 'available' : identity?.reason || 'absent' },
  };
}

export function deriveRemediationBuilder(evidence) {
  // Fenced examples cannot establish PR authorship.
  let fence = null;
  const metadata = String(evidence.body || '').split(/\r?\n/).filter(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  }).join('\n');
  const sources = [
    ...(evidence.builderTag ? [{ source: 'job.builderTag', value: evidence.builderTag }] : []),
    { source: 'title-prefix', value: builderClassFromTitle(evidence.title) },
    ...(evidence.openerClasses || []).map(value => ({ source: 'pr_opened.worker_class', value })),
    // Read explicit metadata lines only, never free-form prose or reviewer identity.
    ...[...metadata.matchAll(/^[ \t]*(?:Worker-Class:[ \t]*([a-z0-9-]+)|<!--[ \t]*(?:hq:worker-class=|Worker-Class:[ \t]*)([a-z0-9-]+)[ \t]*-->)[ \t]*$/gim)]
      .map(match => ({ source: 'body.Worker-Class', value: match[1] || match[2] })),
  ].map(entry => ({ ...entry, builderTag: normalizeBuilderClass(entry.value) }));
  const recognized = sources.filter(entry => entry.builderTag);
  const families = new Set(recognized.map(entry => entry.builderTag === 'clio-agent' ? 'codex' : entry.builderTag));
  const missingEvidence = ['title-prefix', 'pr_opened.worker_class', 'body.Worker-Class']
    .filter(source => !recognized.some(entry => entry.source === source));
  return {
    ok: families.size === 1,
    builderTag: families.size === 1 ? recognized[0].builderTag : null,
    reason: families.size > 1 ? 'conflicting-builder-authorship'
      : families.size === 1 ? 'recorded-builder-authorship' : 'missing-builder-authorship',
    sources, missingEvidence, availability: evidence.availability || {},
  };
}

export async function recoverRemediationBuilder({ rootDir, job, jobPath, execFileImpl,
  now = () => new Date().toISOString(), log = console,
  readEvidenceImpl = readRemediationBuilderEvidence }) {
  if (job.domainId && job.domainId !== 'code-pr') {
    return { ok: true, job };
  }
  const normalized = normalizeBuilderClass(job.builderTag);
  if (normalized && normalized === job.builderTag) return { ok: true, job };
  let recorded;
  if (normalized) {
    recorded = { builderTag: job.builderTag };
  } else {
    try {
      recorded = await readEvidenceImpl({ rootDir, job, execFileImpl });
    } catch {
      recorded = { availability: { pr: 'unavailable', pr_opened: 'unavailable' } };
    }
  }
  const evidence = deriveRemediationBuilder(recorded || {});
  if (Object.values(evidence.availability).some(value =>
    value === 'unavailable' || value === 'identity-read-transient')) {
    return { ok: false, retryable: true, reason: 'builder-authorship-read-unavailable' };
  }
  const observedAt = now();
  if (!evidence.ok) {
    const owner = 'adversarial-review operator';
    const nextAction = 'Escalate to the operator to reconcile PR opener evidence, then retrigger remediation.';
    const reason = `Job ${job.jobId} (${job.repo}#${job.prNumber}): ${evidence.reason}; `
      + `missing evidence=${evidence.missingEvidence.join(', ') || 'none'}; `
      + `recorded evidence=${JSON.stringify(evidence.sources)}; availability=${JSON.stringify(evidence.availability)}. `
      + `Owner: ${owner}. Next action: ${nextAction}`;
    return { ok: false, reason, stopCode: evidence.reason,
      escalation: { owner, nextAction, observedAt, evidence } };
  }
  const recovered = { ...job, builderTag: evidence.builderTag,
    builderTagRecovery: { previousTag: job.builderTag ?? null, observedAt, evidence } };
  // Persist before selection/spawn so a daemon restart retains the same authorship.
  writeFollowUpJob(jobPath, recovered);
  log.warn?.(`[follow-up-remediation] job=${job.jobId} builder-tag-derived `
    + `${JSON.stringify(job.builderTag ?? null)} -> ${evidence.builderTag}; evidence=${JSON.stringify(evidence.sources)}`);
  return { ok: true, job: recovered };
}

// Settle recovery before routing; all exits precede worker admission.
export async function prepareRemediationBuilder({ rootDir, job, jobPath, execFileImpl,
  now = () => new Date().toISOString(), log = console, delayedPendingPaths, readEvidenceImpl }) {
  const authorship = await recoverRemediationBuilder({
    rootDir, job, jobPath, execFileImpl, now, log, readEvidenceImpl });
  if (authorship.ok) return authorship;
  if (authorship.retryable) {
    const requeued = requeueClaimedFollowUpJobBeforeSpawn({ rootDir, jobPath, requeuedAt: now() });
    requeued.job.remediationPlan.retryAfter = new Date(Date.parse(now()) + 60_000).toISOString();
    writeFollowUpJob(requeued.jobPath, requeued.job);
    delayedPendingPaths?.add?.(requeued.jobPath);
    return { ok: false, result: { consumed: false, reason: authorship.reason,
      job: requeued.job, jobPath: requeued.jobPath } };
  }
  const stopped = markFollowUpJobStopped({ rootDir, jobPath, stoppedAt: now(),
    sourceStatus: 'in_progress', stopCode: authorship.stopCode, stopReason: authorship.reason,
    stopMetadata: { builderAuthorshipEscalation: authorship.escalation },
    commentDeliveryExemption: 'no-remediation-started',
    remediationWorker: { state: 'never-spawned', reconciledAt: now() } });
  log.error?.(`[follow-up-remediation] ${authorship.reason}`);
  return { ok: false, result: { consumed: false, reason: authorship.reason,
    escalation: authorship.escalation, job: stopped.job, jobPath: stopped.jobPath } };
}

// Recheck after every route-changing seam, including experiment/account proposals.
export function stopRecoveredBuilderRemediator({ rootDir, job, jobPath, workerClass,
  now = () => new Date().toISOString(), log = console }) {
  if (!job.builderTagRecovery || !isCrossModelReviewWaived(job.builderTag, workerClass)) return null;
  const observedAt = now();
  const escalation = { owner: 'adversarial-review operator',
    nextAction: 'Escalate to the operator to select a different family, then retrigger remediation.',
    observedAt, evidence: job.builderTagRecovery.evidence };
  const reason = `Job ${job.jobId} (${job.repo}#${job.prNumber}): `
    + `builder ${job.builderTag} cannot remediate its own PR via ${workerClass}. `
    + `Owner: ${escalation.owner}. Next action: ${escalation.nextAction}`;
  const stopped = markFollowUpJobStopped({ rootDir, jobPath,
    stoppedAt: observedAt, sourceStatus: 'in_progress', stopCode: 'builder-cannot-remediate-own-pr',
    stopReason: reason, stopMetadata: { builderAuthorshipEscalation: escalation },
    commentDeliveryExemption: 'no-remediation-started',
    remediationWorker: { state: 'never-spawned', reconciledAt: observedAt } });
  log.error?.(`[follow-up-remediation] ${reason}`);
  return { consumed: false, reason, escalation, job: stopped.job, jobPath: stopped.jobPath };
}
