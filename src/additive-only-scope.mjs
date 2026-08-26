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

// A build pack cannot be additive-only without this carve-out. AGENTS.md requires
// build packs to ship a post-merge-actions YAML (already allowlisted), and every
// such YAML hardcodes production-host values -- at minimum `user: airlock`. The
// OSS-readiness enforced gate REFUSES the push unless those hardcodes are
// registered in the registry below, which is not allowlisted. So shipping an
// allowlisted file forces touching a non-allowlisted one, and no build pack could
// ever satisfy the label the reviewer itself applies.
//
// The carve-out is deliberately narrow rather than adding the registry to
// ADDITIVE_ONLY_ALLOWLIST: a blanket entry would let any additive-only PR rewrite a
// security control unreviewed.
const OSS_READINESS_REGISTRY_PATH = 'scripts/oss-readiness-allowlist.registry.json';
// The category ratchet is the second file the same YAML forces. New hardcodes raise
// the repo-wide per-category count, and the ratchet deliberately fails until the new
// count is acknowledged in the same PR. Unlike the registry this cannot be
// deletions-free -- bumping a count rewrites the line -- so it is gated on the
// forcing post-merge action alone. That is safe because the baseline only gates
// AGGREGATE counts: every individual hardcode still needs an inline marker and a
// registry entry, and the registry stays additive-only. A baseline bump on its own
// therefore cannot smuggle in an unregistered hardcode.
const OSS_READINESS_BASELINE_PATH = 'scripts/oss-readiness-category-baseline.json';
const POST_MERGE_ACTIONS_PATTERN = /^modules\/worker-pool\/post-merge-actions\/[^/]+(?:\/.*)?$/;

function pathIsPostMergeAction(pathname) {
  return POST_MERGE_ACTIONS_PATTERN.test(String(pathname || '').replace(/^\/+/, ''));
}

function registryChangeIsPurelyAdditive(file) {
  // Unknown deletion counts fail closed. A caller that hands us bare
  // `{ filename }` objects must not silently obtain the exception.
  const deletions = file?.deletions;
  return Number.isInteger(deletions) && deletions === 0;
}

function forcedByPostMergeAction(files) {
  return files.some((file) => pathIsPostMergeAction(normalizeChangedPath(file)));
}

function registryExceptionApplies(files) {
  if (!forcedByPostMergeAction(files)) return false;
  // Additive literally: the exception never permits deleting an existing
  // registration, which would silently un-register somebody else's hardcode.
  const registryFiles = files.filter(
    (file) => normalizeChangedPath(file) === OSS_READINESS_REGISTRY_PATH
  );
  return registryFiles.every(registryChangeIsPurelyAdditive);
}

function baselineExceptionApplies(files) {
  return forcedByPostMergeAction(files);
}

function changedFilesWithinAdditiveOnlyAllowlist(files = []) {
  const entries = files.filter((file) => normalizeChangedPath(file));
  if (entries.length === 0) return false;
  const registryAllowed = registryExceptionApplies(entries);
  const baselineAllowed = baselineExceptionApplies(entries);
  return entries.every((file) => {
    const pathname = normalizeChangedPath(file);
    if (pathname === OSS_READINESS_REGISTRY_PATH) return registryAllowed;
    if (pathname === OSS_READINESS_BASELINE_PATH) return baselineAllowed;
    return additiveOnlyPathAllowed(pathname);
  });
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

// Enforcement must apply the SAME carve-out as derivation, and must resolve the
// forcing relationship across the whole PR rather than one commit.
//
// The defect this fixes: `changedFilesWithinAdditiveOnlyAllowlist` (derivation)
// honours the registry/baseline exceptions, so a build pack's initial commit
// derives as additive-only and the reviewer BACKFILLS the label. Enforcement then
// scanned with the bare `additiveOnlyPathAllowed`, whose allowlist contains
// neither file -- so the pack was labeled *because* of the carve-out and then
// violated by a rule that ignored it. Every build pack tripped this.
//
// PR-wide forcing matters because the two land in different commits by nature:
// the post-merge YAML is written first, and the ratchet number is only knowable
// after running the audit against it, so the baseline bump is a later commit.
// Requiring the YAML in the same commit made the exception unreachable in the
// normal workflow.
//
// Still narrow: the registry must be deletions-free IN THE COMMIT THAT TOUCHES IT
// (never un-register someone else's hardcode), and the baseline is licensed only
// when a forcing post-merge action exists somewhere in the PR.
function fileViolatesAdditiveOnly(file, { prForcedByPostMergeAction = false } = {}) {
  const pathname = normalizeChangedPath(file);
  if (!pathname) return false;
  if (pathname === OSS_READINESS_REGISTRY_PATH) {
    return !registryChangeIsPurelyAdditive(file);
  }
  if (pathname === OSS_READINESS_BASELINE_PATH) {
    const status = String(file?.status || '').trim().toLowerCase();
    if (status === 'removed' || status === 'deleted') return true;
    return !prForcedByPostMergeAction;
  }
  return !additiveOnlyPathAllowed(pathname);
}

function collectFilesForCommits(commits = [], filesByCommit = {}) {
  const files = [];
  for (const commit of commits) {
    files.push(...commitFileEntry(filesByCommit, commit).files);
  }
  return files;
}

function collectFinalFilesForCommits(commits = [], filesByCommit = {}) {
  const filesByPath = new Map();
  for (const commit of commits) {
    for (const file of commitFileEntry(filesByCommit, commit).files) {
      const pathname = normalizeChangedPath(file);
      if (!pathname) continue;

      const status = String(file?.status || '').trim().toLowerCase();
      const previousPathname = String(file?.previous_filename || '').trim();
      if (status === 'renamed' && previousPathname && previousPathname !== pathname) {
        filesByPath.delete(previousPathname);
      }
      if (status === 'removed' || status === 'deleted') {
        filesByPath.delete(pathname);
        continue;
      }
      filesByPath.set(pathname, file);
    }
  }
  // The values are the latest commit file objects for paths still present in
  // the PR, not cumulative net-diff objects across the whole PR.
  return [...filesByPath.values()];
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

// Backfill is a BRAND, and a brand outlives the evidence that produced it.
//
// The label is not advisory once written. `commitsToScan` below widens from
// `laterCommits` to the WHOLE commit list the moment `labeledAdditiveOnly` is
// true, and `additiveOnly` short-circuits on the label without consulting
// derivation at all. So a backfilled label is self-proving: the next evaluation
// no longer asks whether the class still derives, it just enforces. Nothing the
// PR subsequently does -- rebase, squash, drop the offending commit -- can clear
// it, because the initial commit is now in scope too.
//
// That is survivable only while the brand is applied to PRs that are actually in
// scope. Applying it to a PR the SAME evaluation has just found violating (or has
// failed to read conclusively, or has waved through on an operator override it
// did not scan) hands that PR a contract it has already been proven unable to
// meet, permanently. agent-os#5879, #5883 and #5906 each stopped dead this way on
// 2026-08-25 and each needed a manual `operator-approved: scope-expand`.
//
// So: derive freely, enforce freely -- but only brand on a completed, clean scan.
// Enforcement does not weaken. Derivation re-runs against live PR state every
// tick, which is what CRG-07N's "bind the decision to the current reviewed head"
// asked for in the first place; the finding re-emits for as long as the condition
// holds, and correctly stops when it no longer does.
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
      // The override short-circuits the scan, so scope is unknown here, and the
      // override itself is bound to the current head while the label is not.
      // Branding now would outlive the approval that licensed it.
      backfillNeeded: false,
      finding: null,
      overrideActive: true,
    };
  }

  // Forcing is a property of the final PR state, not of one historical commit.
  const prForced = forcedByPostMergeAction(collectFinalFilesForCommits(commits, filesByCommit));
  const commitsToScan = labeledAdditiveOnly ? commits : laterCommits;
  for (const commit of commitsToScan) {
    const sha = normalizeSha(commit?.sha);
    const fileEntry = commitFileEntry(filesByCommit, commit);
    const violatingFiles = fileEntry.files
      .filter((file) => fileViolatesAdditiveOnly(file, { prForcedByPostMergeAction: prForced }))
      .map(normalizeChangedPath)
      .filter(Boolean);
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
        // Violating, or unreadable (`fileEntry.truncated`). Either way this PR
        // has not been shown to satisfy the label, so it does not get branded.
        backfillNeeded: false,
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
