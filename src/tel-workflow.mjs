import { workflowSpan } from '../../../modules/agent-observability/lib/otel-emit.mjs';

const APPLICATION_NAME = 'agent-os-adversarial-review';

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function prUrlFor({ repo, prNumber, prUrl }) {
  return cleanString(prUrl) || (repo && prNumber ? `https://github.com/${repo}/pull/${prNumber}` : 'unknown');
}

function attrsFor({ prUrl, reviewerClass = null, riskClass = null, pipelineStage, gate, extra = {} }) {
  const url = cleanString(prUrl) || 'unknown';
  const attrs = {
    'agent_os.subsystem': 'dag-runtime',
    application_name: APPLICATION_NAME,
    dag_run_id: url,
    dag_step_id: url,
    ticket_ref: url,
    pipeline_stage: pipelineStage,
    gate,
    risk_class: cleanString(riskClass) || 'unknown',
    pr_url: url,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== undefined && value !== '')),
  };
  if (reviewerClass) attrs.reviewer_class = reviewerClass;
  return attrs;
}

function linkFor({ lrq = null, dispatchId = null }) {
  const cleanLrq = cleanString(lrq);
  const cleanDispatchId = cleanString(dispatchId) || cleanLrq;
  const attributes = {
    lrq: cleanLrq || 'unknown',
    dispatch_id: cleanDispatchId || 'unknown',
  };
  return {
    spanContext: {
      traceId: '0'.repeat(31) + '1',
      spanId: '0'.repeat(15) + '1',
      traceFlags: 1,
    },
    attributes,
  };
}

export function emitAdversarialWorkflowSpan(name, attrs, { lrq = null, dispatchId = null } = {}) {
  return workflowSpan(name, attrs, { links: [linkFor({ lrq, dispatchId })] });
}

export function emitAdversarialWorkflowSpanBestEffort(name, attrs, links = {}) {
  try {
    return emitAdversarialWorkflowSpan(name, attrs, links);
  } catch (error) {
    console.warn(`[tel-workflow] ${name} emit skipped: ${error?.message || error}`);
    return null;
  }
}

export function emitReviewStarted({ repo, prNumber, prUrl = null, reviewerClass, riskClass }) {
  return emitAdversarialWorkflowSpanBestEffort(
    'ar.review.started',
    attrsFor({
      prUrl: prUrlFor({ repo, prNumber, prUrl }),
      reviewerClass,
      riskClass,
      pipelineStage: 'review',
      gate: 'review_started',
    }),
  );
}

export function emitReviewVerdict({ repo, prNumber, prUrl = null, reviewerClass, riskClass, verdict }) {
  const normalized = normalizeArVerdict(verdict);
  if (!normalized) return null;
  return emitAdversarialWorkflowSpanBestEffort(
    'ar.review.verdict',
    attrsFor({
      prUrl: prUrlFor({ repo, prNumber, prUrl }),
      reviewerClass,
      riskClass,
      pipelineStage: 'review',
      gate: 'review_verdict',
      extra: { verdict: normalized },
    }),
  );
}

export function emitRemediationStarted({ repo, prNumber, prUrl = null, riskClass, roundNumber, lrq, dispatchId = null }) {
  return emitAdversarialWorkflowSpanBestEffort(
    'ar.remediation.started',
    attrsFor({
      prUrl: prUrlFor({ repo, prNumber, prUrl }),
      riskClass,
      pipelineStage: 'remediation',
      gate: 'remediation_started',
      extra: { round_number: Number(roundNumber) || 0 },
    }),
    { lrq, dispatchId },
  );
}

export function emitClosureMerged({ repo, prNumber, prUrl = null, riskClass, closerClass, lrq, dispatchId = null }) {
  return emitAdversarialWorkflowSpanBestEffort(
    'ar.closure.merged',
    attrsFor({
      prUrl: prUrlFor({ repo, prNumber, prUrl }),
      riskClass,
      pipelineStage: 'closure',
      gate: 'closure_merged',
      extra: { closer_class: cleanString(closerClass) || 'unknown' },
    }),
    { lrq, dispatchId },
  );
}

export function normalizeArVerdict(verdict) {
  const text = cleanString(verdict)?.toLowerCase().replace(/[-\s]+/g, '_');
  if (!text) return null;
  if (text.startsWith('approve') || text === 'approved') return 'approved';
  if (text.startsWith('comment_only') || text.startsWith('comment')) return 'comment_only';
  if (text.startsWith('request_changes') || text.startsWith('request')) return 'request_changes';
  return null;
}
