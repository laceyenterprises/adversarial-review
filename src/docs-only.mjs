import { execGhWithRetry } from './gh-cli.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { isExplicitOperatorRetriggerReason } from './retrigger-review-reason.mjs';
import { isOperatorHeld } from './operator-hold-labels.mjs';

const revisions = new Map();
const SHA = /^[0-9a-f]{40}$/i;
const docsPath = path => typeof path === 'string' && path.startsWith('docs/')
  && !path.split('/').some(part => ['.', '..', 'prompts', 'personas', 'identities'].includes(part))
  && !/(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(path)
  && /\.(?:md|png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?)$/i.test(path);

export function isDocsOnlyFiles(files) {
  // Compare responses cap files at 300. Never authorize a potentially partial list.
  return Array.isArray(files) && files.length > 0 && files.length < 300
    && files.every(file => docsPath(file.filename)
      && (!file.previous_filename || docsPath(file.previous_filename)));
}

export function docsReviewRequested({ labels, requested_reviewers = [], requested_teams = [], rereview_reason } = {}) {
  return !Array.isArray(labels) || labels.some(label =>
    ['request-review', 'retrigger-review', 'fast-merge-veto'].includes(typeof label === 'string' ? label : label?.name))
    || requested_reviewers.length > 0 || requested_teams.length > 0
    || isExplicitOperatorRetriggerReason(rereview_reason) || isOperatorHeld(labels);
}

export async function readDocsFastPath({ repoPath, prNumber, subject, execFileImpl, env = process.env,
  execGhWithRetryImpl = execGhWithRetry, live = false } = {}) {
  const get = async path => {
    const { stdout } = await execGhWithRetryImpl({ execFileImpl, env,
      args: ['api', path], timeoutMs: loadAwareTimeoutMs(15_000) });
    return JSON.parse(stdout);
  };
  // Discovery already supplies these fields on REST and native CLI paths.
  // Older adapters refresh metadata only when their discovery version changes.
  const identity = `${repoPath}:${prNumber}`;
  const version = JSON.stringify([subject?.headSha, subject?.baseSha, subject?.updatedAt]);
  const cached = revisions.get(identity);
  if (!live && cached?.version === version) return cached.evidence;
  const pr = await get(`repos/${repoPath}/pulls/${prNumber}`);
  const headSha = pr?.head?.sha, baseSha = pr?.base?.sha;
  if (!SHA.test(headSha || '') || !SHA.test(baseSha || '') || headSha !== subject?.headSha) return null;
  if (docsReviewRequested(pr) || pr.draft || pr.state !== 'open') return null;
  if (live && cached?.evidence?.headSha === headSha && cached.evidence.baseSha === baseSha) return cached.evidence;
  const compare = await get(`repos/${repoPath}/compare/${baseSha}...${headSha}?per_page=1`);
  const evidence = isDocsOnlyFiles(compare.files) ? { headSha, baseSha, baseBranch: pr.base.ref } : null;
  revisions.set(identity, { version, evidence });
  if (revisions.size > 512) revisions.delete(revisions.keys().next().value);
  return evidence;
}
