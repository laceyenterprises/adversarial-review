import { docsReviewRequested, readDocsFastPath } from './docs-only.mjs';
import { publishAdversarialGateStatus } from './adversarial-gate-status.mjs';
import { createBranchProtectionChecker } from './branch-protection.mjs';
import { runDaemonCleanMergeAttempt } from './daemon-clean-merge.mjs';

const readProtection = createBranchProtectionChecker();

export async function maybeRunDocsFastPath({ subject, reviewRow, cfg, loadCfg = () => cfg, rootDir, repoPath, prNumber,
  execFileImpl, logger = console,
  readReviewRow = () => reviewRow, readDocsFastPathImpl = readDocsFastPath,
  publishStatusImpl = publishAdversarialGateStatus,
  fetchProtectionImpl = readProtection,
  runDaemonImpl = runDaemonCleanMergeAttempt, onHandled = () => {} } = {}) {
  if (subject.terminal || subject.isDraft) return false;
  const withdrawWaiver = async (headSha, reason = 'docs-review-requested') => {
    try {
      await publishStatusImpl(rootDir, { repo: repoPath, prNumber, headSha,
        decision: { state: 'pending', reason, description: 'Adversarial review pending; docs waiver withdrawn.' }, execFileImpl });
      return false;
    } catch (error) {
      logger.warn?.(`[docs-fast-path] waiver withdrawal unavailable: ${error.message}`);
      onHandled('docs-waiver-withdrawal-unavailable');
      return true;
    }
  };
  if (docsReviewRequested({ ...subject, ...reviewRow })) return withdrawWaiver(subject.headSha);
  if (reviewRow?.reviewer && (reviewRow.revision_ref === subject.headSha
    || reviewRow.reviewer_head_sha === subject.headSha)) return false;
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
    return false;
  }
  if (evidence?.reviewRequested) return withdrawWaiver(evidence.headSha || subject.headSha);
  if (!evidence) return false;
  // An eligible docs head owns its wait, including disabled authority and red CI.
  // Neither a reviewer nor a closer is useful while these deterministic gates wait.
  try {
    cfg = loadCfg();
    if (!cfg?.enabled || cfg.autonomousMergeExecutionEnabled === false) {
      onHandled('docs-merge-disabled');
      return true;
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
      onHandled(reason, true);
      return true;
    }
    // The daemon declined the shortcut. Restore the pending gate before the
    // ordinary first pass, which can run while external CI is red.
    if (reason === 'not-eligible') return withdrawWaiver(evidence.headSha, 'docs-fast-path-not-eligible');
    onHandled(reason);
  } catch (error) {
    logger.warn?.(`[docs-fast-path] merge deferred: ${error.message}`);
    onHandled('docs-merge-unavailable');
  }
  return true;
}
