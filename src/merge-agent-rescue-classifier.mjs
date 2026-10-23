import { decideClosureOwner } from './ama/closure-owner.mjs';
import { closureOwnerShadowEvidence, shadowNextActionLater } from './pr-next-action-consumer.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { classifyCheckRollup } from './checks-summary.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const GATE_CONTEXT = 'agent-os/adversarial-gate';

const HARD_STOP_LABELS = new Set([
  'merge-agent-recovery-in-flight',
  'paused-for-redesign',
  'reviewer-cycle-cap-reached',
]);
const REBASE_HARD_STOP_LABELS = new Set(
  [...HARD_STOP_LABELS].filter((label) => label !== 'merge-agent-stuck'),
);
const UNADDRESSABLE_CATEGORIES = new Set(['auth', 'schema-migration', 'external-system', 'policy']);

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function extractSection(reviewBody, heading) {
  const text = String(reviewBody ?? '').replace(/\r\n/g, '\n');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'i');
  const lines = text.split('\n');
  let inFence = false;
  let offset = 0;
  let start = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmed)) inFence = !inFence;
    if (!inFence && pattern.test(line)) {
      start = offset + line.length;
      break;
    }
    offset += line.length + 1;
  }
  if (start == null) return null;

  inFence = false;
  offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    const trimmed = line.trimStart();
    if (lineStart > start && !inFence && /^##\s+/.test(line)) {
      return text.slice(start, lineStart);
    }
    if (/^(?:```|~~~)/.test(trimmed)) inFence = !inFence;
    offset += line.length + 1;
  }
  return text.slice(start);
}

function verdictKindToDisplay(kind) {
  if (kind === 'approved') return 'Approved';
  if (kind === 'comment-only') return 'Comment only';
  if (kind === 'request-changes') return 'Request changes';
  return null;
}

function statedVerdictDisplay(reviewBody) {
  const section = extractSection(reviewBody, 'Verdict');
  if (section == null) return null;
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^approved(?:\s*$|\s*[:\-–—].*)/i.test(line)) return 'Approved';
    if (/^comment only(?:\s*$|\s*[:\-–—].*)/i.test(line)) return 'Comment only';
    if (/^request changes(?:\s*$|\s*[:\-–—].*)/i.test(line)) return 'Request changes';
  }
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

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (label && typeof label === 'object' && 'name' in label) {
        return String(label.name ?? '').trim().toLowerCase();
      }
      return String(label ?? '').trim().toLowerCase();
    })
    .filter(Boolean);
}

function hasHardStopLabel(labels) {
  return normalizeLabels(labels).some((label) => HARD_STOP_LABELS.has(label));
}

function hasRebaseHardStopLabel(labels) {
  return normalizeLabels(labels).some((label) => REBASE_HARD_STOP_LABELS.has(label));
}

function isGateRow(row) {
  const contexts = new Set([GATE_CONTEXT]);
  try {
    contexts.add(String(resolveGateStatusContext(process.env)).trim().toLowerCase());
  } catch {
    // Keep the default context active if the env override is malformed.
  }
  const label = String(row?.context || row?.name || '').trim().toLowerCase();
  return contexts.has(label);
}

function checkRowsForHead(statusCheckRollup, headSha) {
  if (!Array.isArray(statusCheckRollup)) return [];
  return statusCheckRollup.filter((row) => {
    const rowOid = normalizeOptionalString(row?.commit?.oid);
    return (!rowOid || !headSha || rowOid === headSha) && !isGateRow(row);
  });
}

function checksPass(input) {
  if (!Array.isArray(input?.statusCheckRollup)) return false;
  const rows = checkRowsForHead(input?.statusCheckRollup, input?.headSha);
  return rows.length === 0 || classifyCheckRollup(rows) === 'SUCCESS';
}

function hasValidOperatorApproval(input) {
  return Boolean(
    input?.operatorApprovalLabelEventId
    && input?.operatorApprovalActor
    && input?.operatorApprovalLabeledAt
    && input?.operatorApprovalHeadSha
    && input?.headSha
    && String(input.operatorApprovalHeadSha) === String(input.headSha)
  );
}

function isMergeable(input) {
  return String(input?.mergeable ?? '').trim().toUpperCase() === 'MERGEABLE';
}

// Adapter for the authoritative MSM ownership answer. It grants no merge
// authority and preserves the pipeline's bounded wait/page evidence.
export function classifyClosureOwnership(input) {
  const closureOwner = decideClosureOwner(input);
  // NXA-02 observational shadow only; rescue keeps the legacy answer.
  void shadowNextActionLater({ source: 'rescue-classifier', legacy: closureOwner, rootDir: input?.rootDir || null,
    evidence: () => closureOwnerShadowEvidence(input, { observedAt: new Date().toISOString() }) });
  return rescueOwnershipDecision(closureOwner);
}

function rescueOwnershipDecision(closureOwner) {
  const decision = {
    'daemon-merge': 'merge-eligible', hammer: 'hammer-eligible',
    review: 'rereview-eligible', remediation: 'remediation-eligible',
    close: 'close-empty', 'follow-up-drain': 'wait-closer',
    'conflict-rebase': 'rebase-eligible', wait: 'wait-closer', page: 'page-required',
  }[closureOwner?.owner];
  return decision ? { decision, reason: closureOwner.reason, closureOwner } : null;
}

function classify(input = {}) {
  let verdict = verdictKindToDisplay(normalizeEffectiveReviewVerdict(input.reviewBody));
  const blocking = parseIssueSection(input.reviewBody, 'Blocking issues', 'blocking');
  const nonBlocking = parseIssueSection(input.reviewBody, 'Non-blocking issues', 'non-blocking');
  const parsedFindings = [...blocking.findings, ...nonBlocking.findings].map(({ kind: _kind, title: _title, ...finding }) => finding);
  const blockingFindings = blocking.count;
  const nonBlockingFindings = nonBlocking.count;
  if (
    statedVerdictDisplay(input.reviewBody) === 'Request changes'
    && blockingFindings === 0
    && nonBlockingFindings > 0
  ) {
    verdict = 'Request changes';
  }
  const owned = input.closureOwner ? rescueOwnershipDecision(input.closureOwner)
    : input.closureOwnership ? classifyClosureOwnership(input.closureOwnership) : null;
  if (owned) return { ...owned, blockingFindings, nonBlockingFindings, parsedFindings };
  if (input.primaryChange && classifyClosureOwnership({ primaryChange: input.primaryChange, currentHead: input.headSha }).decision === 'page-required') {
    return { decision: 'page-required', reason: 'primary-change-needs-operator', blockingFindings, nonBlockingFindings, parsedFindings };
  }
  const hardStop = hasHardStopLabel(input.labels);
  const rebaseHardStop = hasRebaseHardStopLabel(input.labels);
  const checksArePassing = checksPass(input);
  const mergeable = isMergeable(input);
  const conflicting = String(input?.mergeable ?? '').trim().toUpperCase() === 'CONFLICTING';

  if (hasValidOperatorApproval(input) && mergeable && checksArePassing && !hardStop) {
    return {
      decision: 'merge-eligible',
      reason: 'operator-approved',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  // This head is owned by terminal hammer validation, not another review.
  // The caller derives this bit from the durable final-round push record.
  if (input.commentOnlyFinalRoundPush === true) {
    return { decision: 'hammer-eligible', reason: 'comment-only-final-round-completed',
      blockingFindings, nonBlockingFindings, parsedFindings };
  }

  if (input.reviewHeadSha != null && input.headSha != null && String(input.reviewHeadSha) !== String(input.headSha)) {
    return {
      decision: 'escalate-stale-review',
      reason: 'review-head-stale',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (!verdict || blocking.missing || nonBlocking.missing) {
    return {
      decision: 'inconclusive',
      reason: 'malformed-review',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (
    (verdict === 'Approved' || verdict === 'Comment only')
    && blockingFindings === 0
    && nonBlockingFindings === 0
    && mergeable
    && checksArePassing
    && !hardStop
  ) {
    return {
      decision: 'merge-eligible',
      reason: 'clean-review',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (
    (verdict === 'Approved' || verdict === 'Comment only')
    && blockingFindings === 0
    && nonBlockingFindings === 0
    && conflicting
    && checksArePassing
    && !rebaseHardStop
  ) {
    return {
      decision: 'rebase-eligible',
      reason: 'clean-review-requires-rebase',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (verdict === 'Request changes' || (['Approved', 'Comment only'].includes(verdict)
    && blockingFindings + nonBlockingFindings > 0 && !hardStop)) {
    const blockerCategories = blocking.findings
      .map((finding) => finding.category)
      .filter(Boolean);
    if (blockerCategories.some((category) => UNADDRESSABLE_CATEGORIES.has(category))) {
      return {
        decision: 'escalate-blockers',
        reason: 'unaddressable-blocker',
        blockingFindings,
        nonBlockingFindings,
        parsedFindings,
      };
    }
    if (blockingFindings > 0 || (blockingFindings === 0 && nonBlockingFindings > 0)) {
      return {
        decision: 'remediation-eligible',
        reason: 'addressable-findings',
        blockingFindings,
        nonBlockingFindings,
        parsedFindings,
      };
    }
  }

  return {
    decision: 'inconclusive',
    reason: 'no-matching-decision-rule',
    blockingFindings,
    nonBlockingFindings,
    parsedFindings,
  };
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

export {
  HARD_STOP_LABELS,
  REBASE_HARD_STOP_LABELS,
  UNADDRESSABLE_CATEGORIES,
  checkRowsForHead,
  checksPass,
  parseReviewBody,
};

export default classify;
