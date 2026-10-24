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
  runDaemonImpl = runDaemonCleanMergeAttempt } = {}) {
  if (subject.terminal || subject.isDraft || docsReviewRequested({ ...subject, ...reviewRow })) return false;
  const read = args => docsReviewRequested({ labels: subject.labels, ...readReviewRow() })
    ? { ...evidence, reviewRequested: true } : readDocsFastPathImpl({ repoPath, prNumber, execFileImpl, ...args });
  let evidence;
  try { evidence = await read({ subject }); }
  catch (error) {
    logger.warn?.(`[docs-fast-path] classification unavailable: ${error.message}`);
    return false;
  }
  if (!evidence || evidence.reviewRequested) return false;
  // An eligible docs head owns its wait, including disabled authority and red CI.
  // Neither a reviewer nor a closer is useful while these deterministic gates wait.
  try {
    cfg = loadCfg();
    if (!cfg?.enabled || cfg.autonomousMergeExecutionEnabled === false) return true;
    const branchProtection = await fetchProtectionImpl({
      repoPath, baseBranch: evidence.baseBranch, execFileImpl });
    await publishStatusImpl(rootDir, { repo: repoPath, prNumber, headSha: evidence.headSha,
      decision: { state: 'success', reason: 'docs-fast-path', description: 'Docs-only head: adversarial review waived by DOCSFASTPATH-01.' }, execFileImpl });
    const result = await runDaemonImpl({ rootDir, repoPath, prNumber, cfg, docsFastPath: evidence,
      readDocsFastPathImpl: read, candidate: { headSha: evidence.headSha, baseBranch: evidence.baseBranch,
        labels: subject.labels, branchProtection }, currentPrHeadSha: evidence.headSha,
      reviewState: {}, execFileImpl, logger });
    if (result?.liveGate?.docsFastPath?.reviewRequested) return false;
    logger.log?.(`[docs-fast-path] ${repoPath} PR ${prNumber}: ${result?.reason || result?.disposition}`);
  } catch (error) {
    logger.warn?.(`[docs-fast-path] merge deferred: ${error.message}`);
  }
  return true;
}
