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
      && (file.status !== 'renamed' || docsPath(file.previous_filename))
      && (!file.previous_filename || docsPath(file.previous_filename)));
}

export function docsReviewRequested({ labels, requested_reviewers = [], requested_teams = [], rereview_reason } = {}) {
  return !Array.isArray(labels) || labels.some(label =>
    ['request-review', 'retrigger-review', 'fast-merge-veto'].includes(typeof label === 'string' ? label : label?.name))
    || !Array.isArray(requested_reviewers) || !Array.isArray(requested_teams)
    || requested_reviewers.length > 0 || requested_teams.length > 0
    || isExplicitOperatorRetriggerReason(rereview_reason) || isOperatorHeld(labels);
}

export async function readDocsFastPath({ repoPath, prNumber, subject, execFileImpl, env = process.env,
  execGhWithRetryImpl = execGhWithRetry, live = false } = {}) {
  const get = async (path, projection = null) => {
    const { stdout } = await execGhWithRetryImpl({ execFileImpl, env,
      args: ['api', path, ...(projection ? ['--jq', projection] : [])], timeoutMs: loadAwareTimeoutMs(15_000) });
    return JSON.parse(stdout);
  };
  const identity = `${repoPath}:${prNumber}`;
  let headSha = subject?.headSha, baseSha = subject?.baseSha, baseBranch = subject?.baseRefName;
  if (!SHA.test(headSha || '')) return null;
  if (live) {
    const pr = await get(`repos/${repoPath}/pulls/${prNumber}`);
    if (pr?.head?.sha !== headSha || pr.draft || pr.state !== 'open') return null;
    baseSha = pr.base?.sha; baseBranch = pr.base?.ref;
    if (docsReviewRequested(pr)) return { headSha, baseSha, baseBranch, reviewRequested: true };
  }
  if (!SHA.test(baseSha || '') || !baseBranch) return null;
  const version = `${baseSha}:${headSha}`;
  const cached = revisions.get(identity);
  if (cached?.version === version) return cached.evidence ? { ...cached.evidence, baseBranch } : null;
  const compare = await get(`repos/${repoPath}/compare/${baseSha}...${headSha}?per_page=1`,
    '{files: [.files[] | {filename, previous_filename, status}]}');
  const evidence = isDocsOnlyFiles(compare.files) ? { headSha, baseSha, baseBranch } : null;
  revisions.set(identity, { version, evidence });
  if (revisions.size > 512) revisions.delete(revisions.keys().next().value);
  return evidence;
}
