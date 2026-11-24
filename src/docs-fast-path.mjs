import { DOCS_WITHDRAWAL_REASON, docsReviewRequested, readDocsFastPath } from './docs-only.mjs';
import { publishAdversarialGateStatus, readGateRecord } from './adversarial-gate-status.mjs';
import { createBranchProtectionChecker } from './branch-protection.mjs';
import { runDaemonCleanMergeAttempt } from './daemon-clean-merge.mjs';

const readProtection = createBranchProtectionChecker();

export async function maybeRunDocsFastPath({ subject, reviewRow, cfg, loadCfg = () => cfg, rootDir, repoPath, prNumber,
  execFileImpl, logger = console,
  readReviewRow = () => reviewRow, readDocsFastPathImpl = readDocsFastPath,
  publishStatusImpl = publishAdversarialGateStatus,
  readGateRecordImpl = readGateRecord,
  fetchProtectionImpl = readProtection,
  runDaemonImpl = runDaemonCleanMergeAttempt } = {}) {
  if (subject.terminal || subject.isDraft) return null;
  const waiverWithdrawn = headSha => {
    const gate = rootDir && headSha && readGateRecordImpl(rootDir, { repo: repoPath, prNumber, headSha });
    return gate?.state === 'pending' && gate.reason === DOCS_WITHDRAWAL_REASON;
  };
  const withdrawWaiver = async (headSha, reason = 'docs-review-requested') => {
    try {
      await publishStatusImpl(rootDir, { repo: repoPath, prNumber, headSha,
        decision: { state: 'pending', reason, description: 'Adversarial review pending; docs waiver withdrawn.' }, execFileImpl });
      return null;
    } catch (error) {
      logger.warn?.(`[docs-fast-path] waiver withdrawal unavailable: ${error.message}`);
      return 'docs-waiver-withdrawal-unavailable';
    }
  };
  if (docsReviewRequested({ ...subject, ...reviewRow })) {
    return waiverWithdrawn(subject.headSha) ? null : withdrawWaiver(subject.headSha);
  }
  if (reviewRow?.reviewer && (reviewRow.revision_ref === subject.headSha
    || reviewRow.reviewer_head_sha === subject.headSha)) return null;
  // A same-head unrouted wait still belongs to ordinary review after withdrawal.
  if (reviewRow?.reviewer === '' && reviewRow.revision_ref === subject.headSha
    && waiverWithdrawn(subject.headSha)) return null;
  let evidence = null;
  const read = async args => {
    const current = await readDocsFastPathImpl({ repoPath, prNumber, execFileImpl, ...args });
    // Live labels and native review requests belong to the reader; the row
    // independently retains operator retriggers between discovery snapshots.
    return docsReviewRequested({ labels: [], ...readReviewRow() })
      ? { ...(current || evidence), reviewRequested: true } : current;
  };
  try { evidence = await read({ subject }); }
  catch (error) {
    logger.warn?.(`[docs-fast-path] classification unavailable: ${error.message}`);
    return null;
  }
  if (!evidence) return null;
  const evidenceHead = evidence.headSha || subject.headSha;
  if (waiverWithdrawn(evidenceHead)) return null;
  if (evidence.reviewRequested) return withdrawWaiver(evidenceHead);
  // An eligible docs head owns its wait, including disabled authority and unsettled CI.
  // Neither a reviewer nor a closer is useful while these deterministic gates wait.
  try {
    cfg = loadCfg();
    if (!cfg?.enabled || cfg.autonomousMergeExecutionEnabled === false) {
      return 'docs-merge-disabled';
    }
    const branchProtection = await fetchProtectionImpl({
      repoPath, baseBranch: evidence.baseBranch, execFileImpl });
    await publishStatusImpl(rootDir, { repo: repoPath, prNumber, headSha: evidence.headSha,
      decision: { state: 'success', reason: 'docs-fast-path', description: 'Docs-only head: adversarial review waived by DOCSFASTPATH-01.' }, execFileImpl });
    const result = await runDaemonImpl({ rootDir, repoPath, prNumber, cfg, docsFastPath: evidence,
      readDocsFastPathImpl: read, candidate: { headSha: evidence.headSha, baseBranch: evidence.baseBranch,
        labels: subject.labels, branchProtection }, currentPrHeadSha: evidence.headSha,
      reviewState: {}, execFileImpl, logger });
    if (result?.liveGate?.docsFastPath?.reviewRequested) {
      return withdrawWaiver(evidence.headSha);
    }
    const reason = result?.reason || result?.disposition || 'docs-merge-deferred';
    const gates = result?.reasons?.join(',');
    logger.log?.(`[docs-fast-path] ${repoPath} PR ${prNumber}: ${reason}${gates ? ` gates=${gates}` : ''}`);
    if (result?.merged || ['MERGED', 'CLOSED'].includes(result?.liveGate?.prState)) {
      return 'terminal';
    }
    // Settled CI failures and definite mergeability refusals take ordinary review.
    if (result?.docsReviewRequired) return withdrawWaiver(evidence.headSha, DOCS_WITHDRAWAL_REASON);
    return reason;
  } catch (error) {
    logger.warn?.(`[docs-fast-path] merge deferred: ${error.message}`);
    return 'docs-merge-unavailable';
  }
}
