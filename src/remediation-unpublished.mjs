import { proveFinalRoundWorkerPush } from './comment-only-final-round.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// Publication debt is distinct from unresolved findings or an operator decision.
import { extractCommitShaFromOperationalBlocker } from './github-auth-recovery.mjs';
import { hqPublicationWorker, resolvePublicationWorkspace } from './remediation-publication-workspace.mjs';

export async function findCommittedUnpublishedWork({ reply, job, workspaceDir, execFileImpl, log = console }) {
  const blockers = Array.isArray(reply?.operationalBlockers) ? reply.operationalBlockers : [];
  const text = [reply?.summary, ...blockers.map(entry => [entry?.finding, entry?.reasoning, entry?.title].join(' '))].join(' ');
  if (!/unpublished|unpushed|not (?:been )?pushed|cannot publish|could not publish|refused publication|empty.*--branch|publish(?:er|ing)?[^.]*?(?:fail|refus|block)/iu.test(text)) return null;
  const reported = blockers.map(extractCommitShaFromOperationalBlocker).find(Boolean)
    || extractCommitShaFromOperationalBlocker({ finding: text });
  const hqWorker = hqPublicationWorker(job);
  workspaceDir = await resolvePublicationWorkspace({ job, workspaceDir, execFileImpl, log });
  let commitSha = reported || null;
  if (workspaceDir) try {
    const result = await execFileImpl('git', ['-C', workspaceDir, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { encoding: 'utf8', timeout: loadAwareTimeoutMs(5000), maxBuffer: 1024 });
    const head = String(result.stdout || '').trim();
    // An inspected workspace takes precedence over hashes in freeform commentary.
    if (/^[a-f0-9]{40}$/iu.test(head)) commitSha = head === job.revisionRef ? null : head;
  } catch { /* HQ workspaces may be unavailable; retain explicit worker evidence. */ }
  if (!commitSha || String(job.revisionRef || '').startsWith(commitSha)) return null;
  let publication = null;
  try {
    publication = job.repo && job.prNumber && job.baseBranch && workspaceDir
      ? await proveFinalRoundWorkerPush({ repo: job.repo, prNumber: job.prNumber,
      jobId: job.jobId, reviewedHead: job.revisionRef, baseBranch: job.baseBranch,
      publicationBranch: hqWorker ? job.branch : null,
      expectedLocalHead: hqWorker ? commitSha.toLowerCase() : null,
      workspaceDir, execFileImpl, log }) : null;
    if (publication?.workerPushedHeadSha) return null;
  } catch { /* Unknown live evidence must retain publication debt. */ }
  return { jobId: job.jobId, commitSha, workspaceDir, reported: true,
    liveHeadSha: publication?.liveHeadSha || null, publicationReason: publication?.reason
      || (hqWorker && !workspaceDir ? 'publication-workspace-unavailable' : 'live-publication-unknown') };
}
