import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { summarizeChecksConclusion } from './checks-summary.mjs';
import { normalizeRequiredContexts } from './branch-protection.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';

const execFileAsync = promisify(execFile);

// Behavior-preserving private copy of the trivial label-normalization
// primitive (per the ARC-19 leaf-extraction precedent already used in
// fast-merge-processing.mjs, adversarial-gate-status.mjs, and
// merge-agent-dispatch-decision.mjs). The follow-up-merge-agent monolith
// keeps its own copy for its many other call sites.
function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function extractOperatorNotes(prBody) {
  const text = String(prBody ?? '').trim();
  if (!text) return null;
  return [
    'BEGIN UNTRUSTED PR BODY NOTES',
    text.slice(0, 2_000),
    'END UNTRUSTED PR BODY NOTES',
  ].join('\n');
}

async function fetchMergeAgentCandidate(repo, prNumber, {
  execFileImpl = execFileAsync,
  operatorApprovalEvent = undefined,
  mergeAgentRequestEvent = undefined,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,mergeStateStatus,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const labels = parsed.labels || [];
  const normalizedLabels = normalizeLabelNames(labels);
  const hasOperatorApproved = normalizedLabels.includes(OPERATOR_APPROVED_LABEL);
  const hasMergeAgentRequested = normalizedLabels.includes(MERGE_AGENT_REQUESTED_LABEL);
  const [resolvedOperatorApprovalEvent, resolvedMergeAgentRequestEvent] = await Promise.all([
    hasOperatorApproved && operatorApprovalEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, OPERATOR_APPROVED_LABEL, { execFileImpl })
      : operatorApprovalEvent ?? null,
    hasMergeAgentRequested && mergeAgentRequestEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, MERGE_AGENT_REQUESTED_LABEL, { execFileImpl })
      : mergeAgentRequestEvent ?? null,
  ]);
  let branchProtection = { requiredContexts: [] };
  if (parsed.baseRefName) {
    try {
      const { stdout: protectionStdout } = await execFileImpl(
        'gh',
        [
          'api',
          `repos/${repo}/branches/${encodeURIComponent(parsed.baseRefName)}/protection`,
        ],
        { maxBuffer: 5 * 1024 * 1024 }
      );
      branchProtection = {
        requiredContexts: normalizeRequiredContexts(JSON.parse(String(protectionStdout || '{}'))),
      };
    } catch {
      branchProtection = { requiredContexts: [] };
    }
  }
  return {
    repo,
    prNumber,
    branch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    headSha: parsed.headRefOid || null,
    mergeable: parsed.mergeable || 'UNKNOWN',
    mergeStateStatus: parsed.mergeStateStatus || null,
    checksConclusion: summarizeChecksConclusion(parsed.statusCheckRollup),
    statusCheckRollup: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [],
    branchProtection,
    labels,
    operatorNotes: extractOperatorNotes(parsed.body),
    prState: parsed.mergedAt ? 'merged' : String(parsed.state || 'unknown').trim().toLowerCase(),
    merged: Boolean(parsed.mergedAt),
    prAuthor: parsed.author?.login || null,
    closedAt: parsed.closedAt || null,
    mergedAt: parsed.mergedAt || null,
    prUpdatedAt: parsed.updatedAt || null,
    operatorApprovalEvent: resolvedOperatorApprovalEvent,
    mergeAgentRequestEvent: resolvedMergeAgentRequestEvent,
  };
}

export {
  extractOperatorNotes,
  fetchMergeAgentCandidate,
};
