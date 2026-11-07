import { closerLeaseDeadline, deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { summarizeExternalChecks } from './remediation-ci-regression.mjs';
import { hammerProvenanceEdge } from './ama/hammer-head-validation.mjs';
import { labelsContainDuplicateFamilyHold } from './duplicate-family-gate.mjs';

// Diagnostic coverage is deliberately stricter than semantic review currency:
// a carried review remains visibly attached to its original SHA.
export function reviewCoverage(review, head, comparison, comments = [], provenanceEdge = hammerProvenanceEdge) {
  if (!review) return { kind: 'no-review', commits: [] };
  if (review.headSha === head) return { kind: 'exact-head', commits: [] };
  if (!comparison) return { kind: 'unknown', commits: [] };
  if (['behind', 'diverged'].includes(comparison.status)) return { kind: 'rebased-since-review', commits: [] };
  if (!['ahead', 'identical'].includes(comparison.status) || !Array.isArray(comparison.commits)) {
    return { kind: 'unknown', commits: [] };
  }
  const attested = comments && new Set();
  if (attested) {
    const order = [review.headSha, ...comparison.commits.map(commit => commit.sha)];
    for (const edge of comments.map(provenanceEdge).filter(Boolean)) {
      const base = order.indexOf(edge.base), end = order.indexOf(edge.head);
      if (base >= 0 && end > base) {
        for (const commit of order.slice(base + 1, end + 1)) attested.add(commit);
      }
    }
  }
  return { kind: 'post-review', commits: comparison.commits.map(commit => ({
    sha: commit.sha,
    author: commit.author?.login || commit.commit?.author?.name || 'unknown',
    closerAttested: attested ? attested.has(commit.sha) : null,
  })) };
}

export function reviewFacts(review) {
  const findings = parseReviewFindings(review?.body);
  return {
    verdict: normalizeEffectiveReviewVerdict(review?.body),
    headSha: review?.headSha || null,
    postedAt: review?.postedAt || null,
    blockingFindingState: findings.blocking.state,
    blockingFindingCount: findings.blocking.count,
    nonBlockingFindingState: findings.nonBlocking.state,
    nonBlockingFindingCount: findings.nonBlocking.count,
  };
}

const age = (at, now) => Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : null;

// This is a vocabulary projection, not a second routing policy. Preserve the
// shared action for cases outside the requested shorthand (holds, waits,
// findings, mixed conflicts, and incomplete reads).
export function reportAction(decision, { conflicts, duplicate, eligible, now }) {
  if (decision.reason === 'lease-expired') return 'closer-overdue';
  if (decision.reason === 'live-owner' && decision.actor === 'hammer') {
    const due = Date.parse(decision.deadline?.at);
    return Number.isFinite(due) && due <= now ? 'closer-overdue' : 'wait-closer';
  }
  if (decision.reason === 'live-owner') return decision.action;
  if (decision.row === 'R04-ownership') return 'wait-closer';
  if (decision.action === 'operator-hold' || decision.action === 'done') return decision.action;
  if (duplicate && decision.reason === 'safety-refusal') return 'superseded?';
  if (decision.action === 'review') return 'rereview-exact-head';
  if (decision.row === 'R09-ci-red') return 'ci-fix';
  if (decision.row === 'R10-conflict' && conflicts.state === 'complete' && conflicts.generatedOnly) return 'rebase-generated-only';
  if (eligible && decision.action === 'daemon-merge' && decision.queue?.intent === 'daemon') return 'merge-ready';
  return decision.action;
}

export function buildPrBlocker({ repo, pr, review = null, comparison = null, comments = [],
  conflicts = { state: 'unavailable', files: [], generatedOnly: false },
  observations = {}, policy = {}, cfg = { requiredCheckContexts: [] }, now = Date.now(), errors = [],
  reviewKnown = true, currencyKnown = true }) {
  const facts = reviewFacts(review);
  const coverage = reviewKnown ? reviewCoverage(review, pr.headRefOid, comparison, comments)
    : { kind: 'unknown', commits: [] };
  const checks = summarizeExternalChecks(pr.statusCheckRollup, { cfg });
  const duplicate = labelsContainDuplicateFamilyHold(pr.labels);
  const snapshot = deriveNextActionSnapshot({
    subjectKey: `${repo}#${pr.number}`, head: pr.headRefOid, observedAt: new Date(now).toISOString(),
    anchors: { reviewPostedAt: facts.postedAt, prUpdatedAt: pr.updatedAt },
    observations: {
      ...observations, pr, reviews: reviewKnown && currencyKnown ? facts : null,
      checks: { conclusion: checks.conclusion, rollup: pr.statusCheckRollup,
        requiredContexts: cfg.requiredCheckContexts },
      policy,
      // The existing duplicate hold is a safety refusal, not a new detection
      // heuristic or an instruction to close another PR.
      ...(duplicate ? { controls: { ...observations.controls,
        safetyRefusal: { deterministic: true, reason: 'duplicate-family-unresolved', headSha: pr.headRefOid } } } : {}),
    },
  });
  const decision = nextAction(snapshot);
  const lease = observations.leases?.value?.closer || observations.leases?.closer;
  const eligible = reviewKnown && currencyKnown && pr.state === 'OPEN' && pr.mergeStateStatus === 'CLEAN'
    && coverage.kind === 'exact-head' && facts.blockingFindingState === 'known'
    && facts.blockingFindingCount === 0 && ['approved', 'comment-only'].includes(facts.verdict)
    && checks.conclusion === 'SUCCESS';
  const launch = observations.launches?.value?.closer || observations.launches?.closer;
  const job = observations.remediation?.value?.job || observations.remediation?.job;
  const ownerDeadline = decision.actor === 'remediator' ? job?.deadlineAt || job?.heartbeatDeadlineAt || null
    : (decision.actor === 'hammer' && decision.reason === 'live-owner'
      ? launch?.deadlineAt || launch?.heartbeatDeadlineAt : null)
      || (['pending', 'dispatched'].includes(lease?.status) ? closerLeaseDeadline(lease) : null);
  const due = Date.parse(ownerDeadline);
  return {
    repo, number: pr.number, title: String(pr.title || ''), headSha: pr.headRefOid || null,
    mergeState: pr.mergeStateStatus || 'UNKNOWN', mergeable: pr.mergeable || 'UNKNOWN',
    ageMs: age(pr.createdAt, now),
    review: { ...facts, blockingEmpty: facts.blockingFindingState === 'known' ? facts.blockingFindingCount === 0 : null },
    coverage, ci: { conclusion: checks.conclusion, failing: checks.failedChecks.map(check => check.name),
      pending: checks.pendingChecks.length },
    closer: { kind: decision.actor, status: lease?.status || null, headSha: lease?.headSha || null,
      ageMs: age(lease?.acquiredAt, now), deadline: ownerDeadline,
      deadlineStatus: Number.isFinite(due) ? due <= now ? 'overdue' : 'within-deadline' : 'unknown' },
    conflicts, eligible,
    nextAction: reportAction(decision, { conflicts, eligible,
      duplicate: duplicate && ['post-review', 'rebased-since-review'].includes(coverage.kind), now }),
    decision, errors,
  };
}

export const makePrBlockersReport = (rows, observedAt, errors = []) => ({
  schemaVersion: 1, observedAt, rows, errors,
});

const cell = value => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function formatPrBlockers(report) {
  const lines = [['PR', 'MERGE', 'AGE', 'VERDICT / BLOCKING EMPTY', 'COVERAGE', 'CI FAIL / PENDING',
    'OWNER / AGE / DEADLINE', 'ELIGIBLE', 'NEXT ACTION / REASON', 'NEXT ACTOR DEADLINE', 'CONFLICTS', 'TITLE']];
  for (const row of report.rows) {
    const authors = [...new Set(row.coverage.commits.map(commit =>
      `${commit.author}(${commit.closerAttested === null ? 'attestation-unknown' : commit.closerAttested ? 'closer-attested' : 'unattested'})`))];
    lines.push([`${row.repo}#${row.number}`, row.mergeState,
      row.ageMs === null ? '?' : `${(row.ageMs / 3600000).toFixed(1)}h`,
      `${row.review.verdict || '?'} / ${row.review.blockingEmpty ?? '?'}`,
      `${row.coverage.kind}${authors.length ? `:${authors.join(',')}` : ''}`,
      `${row.ci.failing.join(',') || '-'} / ${row.ci.pending} (${row.ci.conclusion || 'unknown'})`,
      `${row.closer.kind} / ${row.closer.ageMs === null ? '?' : `${(row.closer.ageMs / 60000).toFixed(0)}m`} / ${row.closer.deadlineStatus}`,
      row.eligible ? 'eligible' : '-',
      `${row.nextAction} / ${row.decision.reason}`,
      row.decision.deadline?.at || '-',
      row.conflicts.state === 'complete' ? row.conflicts.files.map(file => `${file.path}${file.generated ? '(generated)' : ''}`).join(',') || '-'
        : row.conflicts.state, row.title]);
  }
  const widths = lines[0].map((_, i) => Math.max(...lines.map(line => cell(line[i]).length)));
  return lines.map(line => line.map((value, i) => cell(value).padEnd(widths[i])).join(' | ').trimEnd()).join('\n')
    + [...report.errors, ...report.rows.flatMap(row => row.errors.map(error => `${row.repo}#${row.number}: ${error}`))]
      .map(error => `\n! ${cell(error)}`).join('') + '\n';
}
