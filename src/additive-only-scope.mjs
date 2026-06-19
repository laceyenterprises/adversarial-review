import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADDITIVE_ONLY_LABEL = 'pr-class: additive-only';
const SCOPE_EXPAND_LABEL = 'operator-approved: scope-expand';
const SCOPE_VIOLATION_KIND = 'scope-violation';
const MAX_REST_PAGES = 10;
const MAX_COMMIT_FILE_PAGES = 10;
const MAX_CONCURRENT_COMMIT_FILE_FETCHES = 4;

const ADDITIVE_ONLY_ALLOWLIST = Object.freeze([
  /^projects\/[^/]+(?:\/.*)?$/,
  /^modules\/worker-pool\/post-merge-actions\/[^/]+(?:\/.*)?$/,
  /^docs\/POSTMORTEM-[^/]+\.md$/,
  /^docs\/AUDIT-[^/]+\.md$/,
]);

function normalizeLabelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim();
}

function hasLabel(labels, name) {
  return Array.isArray(labels) && labels.some((label) => normalizeLabelName(label) === name);
}

function splitRepo(repo) {
  const [owner, repoName, ...rest] = String(repo || '').split('/');
  if (!owner || !repoName || rest.length > 0) {
    throw new TypeError(`Invalid GitHub repo slug: ${repo}`);
  }
  return { owner, repoName };
}

function normalizeSha(value) {
  const sha = String(value || '').trim();
  return sha || null;
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeChangedPath(file) {
  return String(file?.filename || file?.path || '').trim();
}

function additiveOnlyPathAllowed(pathname) {
  const normalized = String(pathname || '').replace(/^\/+/, '');
  return Boolean(normalized) && ADDITIVE_ONLY_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

function changedFilesWithinAdditiveOnlyAllowlist(files = []) {
  const paths = files.map(normalizeChangedPath).filter(Boolean);
  return paths.length > 0 && paths.every(additiveOnlyPathAllowed);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function initialCommitWindow(commits = []) {
  const normalized = commits
    .map((commit, index) => ({
      ...commit,
      sha: normalizeSha(commit?.sha),
      index,
    }))
    .filter((commit) => commit.sha);
  if (normalized.length === 0) return { initialCommits: [], laterCommits: [], initialHeadSha: null };

  return {
    initialCommits: [normalized[0]],
    laterCommits: normalized.slice(1),
    initialHeadSha: normalized[0].sha,
  };
}

function eventName(event) {
  return String(event?.event || event?.type || '').trim().toLowerCase();
}

function eventLabelName(event) {
  return String(event?.label?.name || event?.label || '').trim();
}

function eventActorLogin(event) {
  if (typeof event?.actor === 'string') return event.actor;
  return event?.actor?.login || event?.user?.login || event?.sender?.login || null;
}

function eventHeadSha(event) {
  return normalizeSha(event?.sha || event?.commit_id || event?.commit?.sha || event?.commit?.id);
}

function isHeadChangingEvent(event) {
  return [
    'committed',
    'head_ref_force_pushed',
    'headrefforcepushedevent',
    'head_ref_restored',
    'headrefrestoredevent',
  ].includes(eventName(event));
}

function currentHeadLabelAuthorized({ events = [], labelName, currentHeadSha, prAuthor = null }) {
  if (!labelName || !currentHeadSha) return false;
  const normalizedHead = normalizeSha(currentHeadSha);
  const normalizedAuthor = normalizeLogin(prAuthor);
  if (!normalizedHead || !normalizedAuthor) return false;

  let latestLabelEvent = null;
  let latestHeadEvent = null;
  events.forEach((event, index) => {
    if ((eventName(event) === 'labeled' || eventName(event) === 'labeledevent') && eventLabelName(event) === labelName) {
      latestLabelEvent = { event, index };
    }
    if (isHeadChangingEvent(event)) {
      latestHeadEvent = { event, index, sha: eventHeadSha(event) };
    }
  });
  if (!latestLabelEvent) return false;

  const actor = normalizeLogin(eventActorLogin(latestLabelEvent.event));
  if (!actor || actor === normalizedAuthor) return false;
  if (latestHeadEvent && latestHeadEvent.index > latestLabelEvent.index) return false;
  if (latestHeadEvent?.sha && latestHeadEvent.sha !== normalizedHead) return false;
  return true;
}

function commitFileEntry(filesByCommit = {}, commit = {}) {
  const sha = normalizeSha(commit?.sha);
  const entry = sha ? filesByCommit[sha] : null;
  if (Array.isArray(entry)) return { files: entry, truncated: false };
  if (entry && typeof entry === 'object') {
    return {
      files: Array.isArray(entry.files) ? entry.files : [],
      truncated: Boolean(entry.truncated),
    };
  }
  return { files: Array.isArray(commit.files) ? commit.files : [], truncated: false };
}

function collectFilesForCommits(commits = [], filesByCommit = {}) {
  const files = [];
  for (const commit of commits) {
    files.push(...commitFileEntry(filesByCommit, commit).files);
  }
  return files;
}

function commitsHaveTruncatedFileCoverage(commits = [], filesByCommit = {}) {
  return commits.some((commit) => commitFileEntry(filesByCommit, commit).truncated);
}

function buildScopeViolationFinding({
  repo,
  prNumber,
  commitSha,
  violatingFiles = [],
  fileListTruncated = false,
} = {}) {
  const normalizedViolatingFiles = uniqueSorted(violatingFiles);
  const detail = fileListTruncated && normalizedViolatingFiles.length === 0
    ? `PR is labeled ${ADDITIVE_ONLY_LABEL}, but commit ${commitSha} touched more files than the additive-only guard could verify. Treating truncated scope input as inconclusive; to override, add label '${SCOPE_EXPAND_LABEL}' on the current head from a non-author actor.`
    : `PR is labeled ${ADDITIVE_ONLY_LABEL} but commit ${commitSha} added files outside the additive-only allowlist. To override, add label '${SCOPE_EXPAND_LABEL}' on the current head from a non-author actor.`;
  return {
    kind: SCOPE_VIOLATION_KIND,
    severity: 'high',
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    violating_files: normalizedViolatingFiles,
    file_list_truncated: Boolean(fileListTruncated),
    detail,
  };
}

function appendScopeViolationFinding(reviewBody, finding) {
  if (!finding) return String(reviewBody || '');
  const body = String(reviewBody || '').trimEnd();
  const block = [
    '',
    '## Scope Violation Finding',
    '```json',
    JSON.stringify(finding, null, 2),
    '```',
  ].join('\n');
  return `${body}${block}\n`;
}

function reviewBodyHasScopeViolationFinding(reviewBody) {
  const body = String(reviewBody || '');
  const blockPattern = /^## Scope Violation Finding\s*\r?\n```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gim;
  let match;
  while ((match = blockPattern.exec(body))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.kind === SCOPE_VIOLATION_KIND) return true;
    } catch {
      // Ignore malformed quoted examples; only the structured block suppresses automation.
    }
  }
  return false;
}

async function ghJson(path, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl('gh', ['api', path], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(String(stdout || 'null'));
}

async function fetchPagedGh(repo, path, { execFileImpl = execFileAsync, maxPages = MAX_REST_PAGES } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await ghJson(`${path}${separator}per_page=100&page=${page}`, { execFileImpl });
    const pageItems = Array.isArray(data) ? data : [];
    out.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return out;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchCommitFiles({ owner, repoName, sha, execFileImpl, logger = console } = {}) {
  const files = [];
  for (let page = 1; page <= MAX_COMMIT_FILE_PAGES; page += 1) {
    const commitDetail = await ghJson(
      `repos/${owner}/${repoName}/commits/${sha}?per_page=100&page=${page}`,
      { execFileImpl }
    );
    const pageFiles = Array.isArray(commitDetail?.files) ? commitDetail.files : [];
    files.push(...pageFiles);
    if (pageFiles.length < 100) {
      return { files, truncated: false };
    }
  }
  logger?.warn?.(
    `[additive-only-scope] commit ${sha} reached ${MAX_COMMIT_FILE_PAGES * 100} fetched files; treating scope coverage as inconclusive`
  );
  return { files, truncated: true };
}

async function fetchAdditiveOnlyScopeSnapshot({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const { owner, repoName } = splitRepo(repo);
  const prPath = `repos/${owner}/${repoName}/pulls/${prNumber}`;
  const [pr, labels, commits, timeline] = await Promise.all([
    ghJson(prPath, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/issues/${prNumber}/labels`, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/pulls/${prNumber}/commits`, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/issues/${prNumber}/timeline`, { execFileImpl }),
  ]);

  const filesByCommit = {};
  await mapWithConcurrency(commits, MAX_CONCURRENT_COMMIT_FILE_FETCHES, async (commit) => {
    const sha = normalizeSha(commit?.sha);
    if (!sha) return;
    filesByCommit[sha] = await fetchCommitFiles({ owner, repoName, sha, execFileImpl, logger });
  });

  return {
    repo,
    prNumber,
    prCreatedAt: pr?.created_at || null,
    prAuthor: pr?.user?.login || pr?.author?.login || null,
    currentHeadSha: pr?.head?.sha || null,
    labels,
    commits,
    filesByCommit,
    timeline,
  };
}

async function backfillAdditiveOnlyLabel({ repo, prNumber, execFileImpl = execFileAsync, logger = console } = {}) {
  const { owner, repoName } = splitRepo(repo);
  try {
    await execFileImpl('gh', [
      'api',
      `repos/${owner}/${repoName}/issues/${prNumber}/labels`,
      '-X',
      'POST',
      '-f',
      `labels[]=${ADDITIVE_ONLY_LABEL}`,
    ]);
    return { attempted: true, added: true };
  } catch (err) {
    logger?.warn?.(
      `[additive-only-scope] failed to backfill ${ADDITIVE_ONLY_LABEL} on ${repo}#${prNumber}; continuing enforcement: ${err?.message || err}`
    );
    return { attempted: true, added: false, error: err?.message || String(err) };
  }
}

function evaluateAdditiveOnlyScope({
  repo,
  prNumber,
  labels = [],
  prAuthor = null,
  currentHeadSha = null,
  commits = [],
  filesByCommit = {},
  timeline = [],
} = {}) {
  const labeledAdditiveOnly = hasLabel(labels, ADDITIVE_ONLY_LABEL);
  const overrideActive = hasLabel(labels, SCOPE_EXPAND_LABEL) &&
    currentHeadLabelAuthorized({
      events: timeline,
      labelName: SCOPE_EXPAND_LABEL,
      currentHeadSha,
      prAuthor,
    });

  const { initialCommits, laterCommits, initialHeadSha } = initialCommitWindow(commits);
  const initialCoverageTruncated = commitsHaveTruncatedFileCoverage(initialCommits, filesByCommit);
  const initialFiles = collectFilesForCommits(initialCommits, filesByCommit);
  const derivedAdditiveOnly = !initialCoverageTruncated && changedFilesWithinAdditiveOnlyAllowlist(initialFiles);
  const additiveOnly = labeledAdditiveOnly || derivedAdditiveOnly;

  if (!additiveOnly) {
    return {
      additiveOnly: false,
      derivedAdditiveOnly,
      labeledAdditiveOnly,
      initialHeadSha,
      finding: null,
      backfillNeeded: false,
    };
  }

  if (overrideActive) {
    return {
      additiveOnly: true,
      derivedAdditiveOnly,
      labeledAdditiveOnly,
      initialHeadSha,
      finding: null,
      backfillNeeded: derivedAdditiveOnly && !labeledAdditiveOnly,
      overrideActive: true,
    };
  }

  const commitsToScan = labeledAdditiveOnly ? commits : laterCommits;
  for (const commit of commitsToScan) {
    const sha = normalizeSha(commit?.sha);
    const fileEntry = commitFileEntry(filesByCommit, commit);
    const files = fileEntry.files.map(normalizeChangedPath).filter(Boolean);
    const violatingFiles = files.filter((file) => !additiveOnlyPathAllowed(file));
    if (violatingFiles.length > 0 || fileEntry.truncated) {
      return {
        additiveOnly: true,
        derivedAdditiveOnly,
        labeledAdditiveOnly,
        initialHeadSha,
        violatingCommitSha: sha,
        violatingFiles: uniqueSorted(violatingFiles),
        finding: buildScopeViolationFinding({
          repo,
          prNumber,
          commitSha: sha,
          violatingFiles,
          fileListTruncated: fileEntry.truncated,
        }),
        backfillNeeded: derivedAdditiveOnly && !labeledAdditiveOnly,
      };
    }
  }

  return {
    additiveOnly: true,
    derivedAdditiveOnly,
    labeledAdditiveOnly,
    initialHeadSha,
    finding: null,
    backfillNeeded: derivedAdditiveOnly && !labeledAdditiveOnly,
  };
}

async function resolveAdditiveOnlyScopeReview({
  repo,
  prNumber,
  snapshot = null,
  fetchSnapshotImpl = fetchAdditiveOnlyScopeSnapshot,
  backfillLabelImpl = backfillAdditiveOnlyLabel,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const resolvedSnapshot = snapshot || await fetchSnapshotImpl({ repo, prNumber, execFileImpl, logger });
  const result = evaluateAdditiveOnlyScope({ repo, prNumber, ...resolvedSnapshot });
  if (result.backfillNeeded) {
    result.backfill = await backfillLabelImpl({ repo, prNumber, execFileImpl, logger });
  }
  return result;
}

export {
  ADDITIVE_ONLY_LABEL,
  SCOPE_EXPAND_LABEL,
  SCOPE_VIOLATION_KIND,
  additiveOnlyPathAllowed,
  appendScopeViolationFinding,
  backfillAdditiveOnlyLabel,
  changedFilesWithinAdditiveOnlyAllowlist,
  currentHeadLabelAuthorized,
  evaluateAdditiveOnlyScope,
  fetchAdditiveOnlyScopeSnapshot,
  resolveAdditiveOnlyScopeReview,
  reviewBodyHasScopeViolationFinding,
};
