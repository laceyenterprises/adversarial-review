// Publication debt is distinct from unresolved findings or an operator decision.
import { extractCommitShaFromOperationalBlocker } from './github-auth-recovery.mjs';

export async function findCommittedUnpublishedWork({ reply, job, workspaceDir, execFileImpl }) {
  const blockers = reply?.operationalBlockers || [];
  const text = [reply?.summary, ...blockers.map(entry => [entry.finding, entry.reasoning, entry.title].join(' '))].join(' ');
  if (!/unpublished|unpushed|not (?:been )?pushed|cannot publish|could not publish|refused publication|empty.*--branch|publish(?:er|ing)?[^.]*?(?:fail|refus|block)/iu.test(text)) return null;
  const reported = blockers.map(extractCommitShaFromOperationalBlocker).find(Boolean)
    || extractCommitShaFromOperationalBlocker({ finding: text });
  let commitSha = reported || null;
  try {
    const result = await execFileImpl('git', ['-C', workspaceDir, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
    const head = String(result.stdout || '').trim();
    if (/^[a-f0-9]{40}$/iu.test(head) && head !== job.revisionRef) commitSha = head;
  } catch { /* HQ workspaces may be unavailable; retain explicit worker evidence. */ }
  if (!commitSha || String(job.revisionRef || '').startsWith(commitSha)) return null;
  return { jobId: job.jobId, commitSha, workspaceDir, reported: true };
}
