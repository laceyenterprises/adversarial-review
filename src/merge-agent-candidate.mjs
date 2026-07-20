import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { summarizeChecksConclusion } from './checks-summary.mjs';
import { normalizeRequiredContexts } from './branch-protection.mjs';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';

const execFileAsync = promisify(execFile);
const OPERATOR_NOTES_BEGIN_DELIMITER = 'BEGIN UNTRUSTED PR BODY NOTES';
const OPERATOR_NOTES_END_DELIMITER = 'END UNTRUSTED PR BODY NOTES';
const OPERATOR_NOTES_ESCAPED_END_DELIMITER = 'END_UNTRUSTED_PR_BODY_NOTES';

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
  const text = String(prBody ?? '')
    .replaceAll(OPERATOR_NOTES_END_DELIMITER, OPERATOR_NOTES_ESCAPED_END_DELIMITER)
    .trim();
  if (!text) return null;
  return [
    OPERATOR_NOTES_BEGIN_DELIMITER,
    text.slice(0, 2_000),
    OPERATOR_NOTES_END_DELIMITER,
  ].join('\n');
}

function isBranchProtectionNotConfiguredError(err) {
  const detail = [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .join('\n');
  return /\bHTTP\s+404\b/i.test(detail)
    || /\b404\s+Not\s+Found\b/i.test(detail)
    || /Branch not protected/i.test(detail)
    || /Branch Protection Rules? not found/i.test(detail);
}

async function execGhJson({
  args,
  execFileImpl,
  ghRetryOptions,
}) {
  return execGhWithRetry({
    execFileImpl,
    args,
    retries: 2,
    backoffMs: 250,
    ...ghRetryOptions,
  });
}

async function fetchMergeAgentCandidate(repo, prNumber, {
  execFileImpl = execFileAsync,
  ghRetryOptions = undefined,
  operatorApprovalEvent = undefined,
  mergeAgentRequestEvent = undefined,
} = {}) {
  const { stdout } = await execGhJson({
    execFileImpl,
    ghRetryOptions,
    args: [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,mergeStateStatus,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
    ],
  });
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
      const { stdout: protectionStdout } = await execGhJson({
        execFileImpl,
        ghRetryOptions,
        args: [
          'api',
          `repos/${repo}/branches/${encodeURIComponent(parsed.baseRefName)}/protection`,
        ],
      });
      branchProtection = {
        requiredContexts: normalizeRequiredContexts(JSON.parse(String(protectionStdout || '{}'))),
      };
    } catch (err) {
      if (isTransientGhError(err)) throw err;
      if (!isBranchProtectionNotConfiguredError(err)) throw err;
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
