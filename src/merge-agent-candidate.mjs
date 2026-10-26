import { enrichCiInfrastructureEvidence } from './ci-infrastructure.mjs';
import { observePostedReviewHead, withPostedReviewReadCache } from './posted-review-read-cache.mjs';
import { fetchMergeAgentCandidateSnapshot, settleCandidateSnapshotReads } from './merge-agent-candidate-snapshot.mjs';
import { cachedStackedBaseDefaultBranch, guardStackedBase } from './ama/stacked-base.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectCiBootstrap, recoverCancelledChecks } from './ci-recovery.mjs';
import { summarizeExternalChecks } from './remediation-ci-regression.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { summarizeChecksConclusion } from './checks-summary.mjs';
import { fetchCachedAdversarialGateBranchProtection } from './branch-protection.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { OPERATOR_APPROVED_LABEL, MERGE_AGENT_REQUESTED_LABEL } from './adapters/operator/github-pr-label-controls/index.mjs';

const execFileAsync = promisify(execFile);

export function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

export function extractOperatorNotes(prBody) {
  const text = String(prBody ?? '').trim();
  if (!text) return null;
  return [
    'BEGIN UNTRUSTED PR BODY NOTES',
    text.slice(0, 2_000),
    'END UNTRUSTED PR BODY NOTES',
  ].join('\n');
}

export function fetchMergeAgentCandidate(repo, prNumber, options = {}) {
  return withPostedReviewReadCache({ repo, prNumber },
    () => fetchMergeAgentCandidateWithinReadCache(repo, prNumber, options));
}

async function fetchMergeAgentCandidateWithinReadCache(repo, prNumber, {
  execFileImpl = execFileAsync, env = process.env,
  rootDir = null,
  preparedSnapshot = null,
  reviewClean = false, autonomousMergeExecutionEnabled = false,
  logger = console,
  recoverCancelledChecksImpl = recoverCancelledChecks,
  inspectCiBootstrapImpl = inspectCiBootstrap,
  operatorApprovalEvent = undefined,
  mergeAgentRequestEvent = undefined, signal = null,
  branchProtectionCache = null,
  fetchCachedAdversarialGateBranchProtectionImpl = fetchCachedAdversarialGateBranchProtection,
  guardStackedBaseImpl = guardStackedBase,
} = {}) {
  const parsed = preparedSnapshot || await fetchMergeAgentCandidateSnapshot(repo, prNumber, { execFileImpl, signal, env });
  observePostedReviewHead(repo, prNumber, parsed.headRefOid);
  const labels = parsed.labels || [];
  const normalizedLabels = normalizeLabelNames(labels);
  const hasOperatorApproved = normalizedLabels.includes(OPERATOR_APPROVED_LABEL);
  const hasMergeAgentRequested = normalizedLabels.includes(MERGE_AGENT_REQUESTED_LABEL);
  // Four independent tasks, bounded per PR. The stacked-base guard (including
  // its hold receipt) still finishes before a candidate can authorize routing.
  const results = await settleCandidateSnapshotReads([
    () => String(parsed.state || '').toUpperCase() === 'OPEN' && !parsed.mergedAt
      ? guardStackedBaseImpl({ rootDir: rootDir || fileURLToPath(new URL('..', import.meta.url)),
        repo, prNumber, baseBranch: parsed.baseRefName, defaultBranch: parsed.defaultBranch,
        execFileImpl, signal, logger }) : null,
    () => hasOperatorApproved && operatorApprovalEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, OPERATOR_APPROVED_LABEL, { execFileImpl, env })
      : operatorApprovalEvent ?? null,
    () => hasMergeAgentRequested && mergeAgentRequestEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, MERGE_AGENT_REQUESTED_LABEL, { execFileImpl, env })
      : mergeAgentRequestEvent ?? null,
    (async () => {
      let branchProtection = { requiredContexts: [], ok: false, reason: 'branch-protection-check-failed' };
      if (parsed.baseRefName) {
        try {
          const protection = await fetchCachedAdversarialGateBranchProtectionImpl({
            cache: branchProtectionCache,
            repoPath: repo,
            baseBranch: parsed.baseRefName,
            execFileImpl, env,
          });
          branchProtection = {
            requiredContexts: Array.isArray(protection?.requiredContexts) ? protection.requiredContexts : [],
            ok: protection?.ok === true,
            reason: protection?.reason || 'branch-protection-check-failed',
            requiredContext: protection?.context || null,
          };
        } catch {
          branchProtection = { requiredContexts: [], ok: false, reason: 'branch-protection-check-failed', requiredContext: null };
        }
      }
      return branchProtection;
    }),
  ]);
  // Settle the guard and other readers even on failure; no orphaned task may
  // write a hold receipt after the caller has abandoned this candidate.
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  signal?.throwIfAborted();
  const [stackedBaseHold, resolvedOperatorApprovalEvent, resolvedMergeAgentRequestEvent, branchProtection] =
    results.map(result => result.value);
  const checksCfg = loadConfigCached({ env });
  const statusCheckRollup = String(parsed.state).toUpperCase() === 'OPEN' && !parsed.mergedAt
    ? await enrichCiInfrastructureEvidence({ rollup: parsed.statusCheckRollup, repo, headSha: parsed.headRefOid,
      execFileImpl, env, signal }) : parsed.statusCheckRollup;
  const checkSummary = summarizeExternalChecks(statusCheckRollup, { env, cfg: checksCfg });
  let recovering = false;
  let ciBootstrap = { mode: null };
  if (reviewClean && autonomousMergeExecutionEnabled && rootDir && String(parsed.state).toUpperCase() === 'OPEN') {
    try {
      recovering = await recoverCancelledChecksImpl({ rootDir, repo, prNumber, headSha: parsed.headRefOid,
        ...checkSummary, execFileImpl, env, signal });
      ciBootstrap = await inspectCiBootstrapImpl({ rootDir, repo, prNumber, headSha: parsed.headRefOid,
        baseBranch: parsed.baseRefName, rollup: statusCheckRollup,
        ownContext: resolveGateStatusContext(env), execFileImpl, env, signal,
        requiredContexts: resolveRequiredCheckContextsFromCfg(checksCfg) });
    } catch (error) {
      signal?.throwIfAborted();
      logger?.warn?.(`[merge-agent] CI recovery unavailable for ${repo}#${prNumber}: ${error.message}`);
    }
  }
  return {
    repo,
    prNumber,
    branch: parsed.headRefName,
    ...(stackedBaseHold ? { stackedBaseHold } : {}),
    baseBranch: parsed.baseRefName,
    defaultBranch: parsed.defaultBranch || cachedStackedBaseDefaultBranch(repo, execFileImpl) || null,
    // NOOWNER-01: a moved base is one of the inputs that releases a hammer stop hold.
    baseSha: parsed.baseRefOid || null,
    headSha: parsed.headRefOid || null,
    isDraft: typeof parsed.isDraft === 'boolean' ? parsed.isDraft : null,
    mergeable: parsed.mergeable || 'UNKNOWN',
    mergeStateStatus: parsed.mergeStateStatus || null,
    checksConclusion: recovering ? 'PENDING' : summarizeChecksConclusion(statusCheckRollup, { env, cfg: checksCfg }),
    ciBootstrap,
    statusCheckRollup: Array.isArray(statusCheckRollup) ? statusCheckRollup : [],
    branchProtection,
    labels,
    title: String(parsed.title || ''),
    body: String(parsed.body || ''),
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
