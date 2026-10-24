import { closureOwnerFromDecision } from './ama/closure-owner.mjs';
import { deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function verdictKindToDisplay(kind) {
  if (kind === 'approved') return 'Approved';
  if (kind === 'comment-only') return 'Comment only';
  if (kind === 'request-changes') return 'Request changes';
  return null;
}

function parseIssueSection(reviewBody, heading, kind) {
  const parsed = parseReviewFindings(reviewBody)[kind === 'blocking' ? 'blocking' : 'nonBlocking'];
  return {
    missing: parsed.state === 'unknown',
    count: parsed.count,
    findings: parsed.findings.map((finding) => ({
      kind,
      title: normalizeOptionalString(finding.title),
      category: normalizeOptionalString(finding.category)?.toLowerCase() ?? null,
      file: normalizeOptionalString(finding.file),
      lines: normalizeOptionalString(finding.lines),
      problem: normalizeOptionalString(finding.problem),
      whyItMatters: normalizeOptionalString(finding.whyItMatters),
      recommendedFix: normalizeOptionalString(finding.recommendedFix),
    })),
  };
}

// Rescue reports the shared workflow. Read failures, deferrals and recovery
// never turn into launch permission, and diagnostic reason text is opaque.
export function classifyClosureOwnership(decision, headSha = null) {
  const closureOwner = closureOwnerFromDecision(decision);
  const waiting = decision.actor === 'closure-recovery'
    || ['owned', 'reconcile', 'observe'].includes(decision.queue?.intent)
    || decision.queue?.deferredBy || (headSha && decision.head !== headSha);
  const result = decision.action === 'operator-hold' ? 'page-required'
    : decision.action === 'done' ? 'inconclusive'
      : waiting ? 'wait-closer'
        : { 'daemon-merge': 'merge-eligible', hammer: 'hammer-eligible',
          review: 'rereview-eligible', remediate: 'remediation-eligible' }[decision.action] || 'wait-closer';
  return { decision: result, reason: decision.reason, closureOwner };
}

export default function classify(input = {}) {
  const parsed = parseReviewBody(input.reviewBody);
  const decision = input.sharedNextAction?.decision || input.closureOwner?.action && input.closureOwner
    || nextAction(input.snapshot || deriveNextActionSnapshot({
      subjectKey: input.subjectKey, head: input.headSha, observedAt: input.observedAt,
      observations: { pr: { state: input.prState, headSha: input.headSha } },
    }));
  return { ...classifyClosureOwnership(decision, input.headSha),
    blockingFindings: parsed.blocking.count, nonBlockingFindings: parsed.nonBlocking.count,
    parsedFindings: parsed.parsedFindings };
}

function parseReviewBody(reviewBody) {
  const blocking = parseIssueSection(reviewBody, 'Blocking issues', 'blocking');
  const nonBlocking = parseIssueSection(reviewBody, 'Non-blocking issues', 'non-blocking');
  return {
    verdict: verdictKindToDisplay(normalizeEffectiveReviewVerdict(reviewBody)),
    blocking,
    nonBlocking,
    parsedFindings: [...blocking.findings, ...nonBlocking.findings].map(({ kind: _kind, title: _title, ...finding }) => finding),
  };
}

export { parseReviewBody };
