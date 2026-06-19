import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADDITIVE_ONLY_LABEL = 'pr-class: additive-only';
const SCOPE_EXPAND_LABEL = 'operator-approved: scope-expand';
const SCOPE_VIOLATION_KIND = 'scope-violation';
const MAX_REST_PAGES = 10;
const MAX_COMMIT_FILE_PAGES = 5;

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

function initialCommitWindow(commits = [], prCreatedAt = null) {
  const normalized = commits
    .map((commit, index) => ({
      ...commit,
      sha: normalizeSha(commit?.sha),
      index,
      committedAt: commit?.committedAt || commit?.commit?.committer?.date || commit?.commit?.author?.date || null,
    }))
    .filter((commit) => commit.sha);
  if (normalized.length === 0) return { initialCommits: [], laterCommits: [], initialHeadSha: null };

  const createdAtMs = Date.parse(String(prCreatedAt || ''));
  if (!Number.isFinite(createdAtMs)) {
    return {
      initialCommits: [normalized[0]],
      laterCommits: normalized.slice(1),
      initialHeadSha: normalized[0].sha,
    };
  }

  const initialCommits = normalized.filter((commit) => {
    const committedAtMs = Date.parse(String(commit.committedAt || ''));
    return Number.isFinite(committedAtMs) && committedAtMs <= createdAtMs;
  });
  const window = initialCommits.length > 0 ? initialCommits : [normalized[0]];
  const initialHeadIndex = Math.max(...window.map((commit) => commit.index));
  return {
    initialCommits: window,
    laterCommits: normalized.filter((commit) => commit.index > initialHeadIndex),
    initialHeadSha: normalized[initialHeadIndex]?.sha || window.at(-1)?.sha || null,
  };
}

function currentHeadLabelAuthorized({ events = [], labelName, currentHeadSha }) {
  if (!labelName || !currentHeadSha) return false;
  const labelEvents = events
    .filter((event) => (
      (event.event === 'labeled' || event.type === 'LabeledEvent') &&
      String(event?.label?.name || event?.label || '').trim() === labelName
    ))
    .sort((a, b) => Date.parse(a.created_at || a.createdAt || '') - Date.parse(b.created_at || b.createdAt || ''));
  if (labelEvents.length === 0) return false;

  const latestLabelAt = Date.parse(labelEvents.at(-1)?.created_at || labelEvents.at(-1)?.createdAt || '');
  if (!Number.isFinite(latestLabelAt)) return false;
  const laterHeadEvents = events.some((event) => {
    const eventName = String(event.event || event.type || '').toLowerCase();
    if (!['committed', 'head_ref_force_pushed', 'headref forcepushed event', 'head_ref_restored'].includes(eventName)) {
      return false;
    }
    const eventAt = Date.parse(event.created_at || event.createdAt || '');
    return Number.isFinite(eventAt) && eventAt > latestLabelAt;
  });
  return !laterHeadEvents;
}

function collectFilesForCommits(commits = [], filesByCommit = {}) {
  const files = [];
  for (const commit of commits) {
    const sha = normalizeSha(commit?.sha);
    if (!sha) continue;
    files.push(...(filesByCommit[sha] || commit.files || []));
  }
  return files;
}

function buildScopeViolationFinding({ repo, prNumber, commitSha, violatingFiles }) {
  return {
    kind: SCOPE_VIOLATION_KIND,
    severity: 'high',
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    violating_files: uniqueSorted(violatingFiles),
    detail: `PR is labeled ${ADDITIVE_ONLY_LABEL} but commit ${commitSha} added files outside the additive-only allowlist. To override, add label '${SCOPE_EXPAND_LABEL}' on the current head.`,
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
  return /"kind"\s*:\s*"scope-violation"/.test(String(reviewBody || '')) ||
    String(reviewBody || '').includes(`kind: ${SCOPE_VIOLATION_KIND}`);
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

async function fetchAdditiveOnlyScopeSnapshot({ repo, prNumber, execFileImpl = execFileAsync } = {}) {
  const { owner, repoName } = splitRepo(repo);
  const prPath = `repos/${owner}/${repoName}/pulls/${prNumber}`;
  const [pr, labels, commits, timeline] = await Promise.all([
    ghJson(prPath, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/issues/${prNumber}/labels`, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/pulls/${prNumber}/commits`, { execFileImpl }),
    fetchPagedGh(repo, `repos/${owner}/${repoName}/issues/${prNumber}/timeline`, { execFileImpl }),
  ]);

  const filesByCommit = {};
  await Promise.all(commits.map(async (commit) => {
    const sha = normalizeSha(commit?.sha);
    if (!sha) return;
    const commitDetail = await ghJson(`repos/${owner}/${repoName}/commits/${sha}?per_page=100`, { execFileImpl });
    filesByCommit[sha] = Array.isArray(commitDetail?.files)
      ? commitDetail.files.slice(0, MAX_COMMIT_FILE_PAGES * 100)
      : [];
  }));

  return {
    repo,
    prNumber,
    prCreatedAt: pr?.created_at || null,
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
  prCreatedAt = null,
  currentHeadSha = null,
  commits = [],
  filesByCommit = {},
  timeline = [],
} = {}) {
  const labeledAdditiveOnly = hasLabel(labels, ADDITIVE_ONLY_LABEL);
  const overrideActive = hasLabel(labels, SCOPE_EXPAND_LABEL) &&
    currentHeadLabelAuthorized({ events: timeline, labelName: SCOPE_EXPAND_LABEL, currentHeadSha });

  const { initialCommits, laterCommits, initialHeadSha } = initialCommitWindow(commits, prCreatedAt);
  const initialFiles = collectFilesForCommits(initialCommits, filesByCommit);
  const derivedAdditiveOnly = changedFilesWithinAdditiveOnlyAllowlist(initialFiles);
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

  for (const commit of laterCommits) {
    const sha = normalizeSha(commit?.sha);
    const files = (filesByCommit[sha] || commit.files || []).map(normalizeChangedPath).filter(Boolean);
    const violatingFiles = files.filter((file) => !additiveOnlyPathAllowed(file));
    if (violatingFiles.length > 0) {
      return {
        additiveOnly: true,
        derivedAdditiveOnly,
        labeledAdditiveOnly,
        initialHeadSha,
        violatingCommitSha: sha,
        violatingFiles: uniqueSorted(violatingFiles),
        finding: buildScopeViolationFinding({ repo, prNumber, commitSha: sha, violatingFiles }),
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
