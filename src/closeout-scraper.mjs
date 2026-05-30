import {
  GH_LOOKUP_TIMEOUT_MS,
  execGhWithRetry,
  parseDate,
  parseJsonLines,
} from './gh-cli.mjs';

const CLOSEOUT_MARKER = 'hq:closeout:pr';
const CLOSEOUT_SETTLE_DELAY_MS = 10 * 60 * 1000;

function isMergeCloseoutMarked(body) {
  return String(body || '').includes(CLOSEOUT_MARKER);
}

function stripMergeCloseoutMarker(body) {
  return String(body || '')
    .replace(/<!--\s*hq:closeout:pr\s*-->\s*/gi, '')
    .trim();
}

function normalizeIssueComment(raw = {}) {
  return {
    id: raw.id ?? null,
    nodeId: raw.node_id ?? raw.nodeId ?? null,
    body: String(raw.body ?? ''),
    createdAt: raw.created_at ?? raw.createdAt ?? null,
    updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
    authorLogin: raw?.user?.login ?? raw.authorLogin ?? null,
    url: raw.html_url ?? raw.url ?? null,
  };
}

async function fetchIssueComments({
  repo,
  prNumber,
  execFileImpl,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
  retries,
} = {}) {
  const { stdout } = await execGhWithRetry({
    execFileImpl,
    env,
    timeoutMs,
    retries,
    args: [
      'api',
      '--paginate',
      `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
      '-q',
      '.[] | {id: .id, node_id: .node_id, body: .body, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, user: {login: .user.login}}',
    ],
  });
  return parseJsonLines(stdout).map(normalizeIssueComment);
}

function composeMergeCloseoutFromComments({ comments = [] } = {}) {
  const marked = comments
    .map(normalizeIssueComment)
    .filter((comment) => isMergeCloseoutMarked(comment.body))
    .map((comment) => ({
      ...comment,
      strippedBody: stripMergeCloseoutMarker(comment.body),
      createdAtDate: parseDate(comment.createdAt),
    }))
    .filter((comment) => comment.strippedBody);

  if (marked.length === 0) {
    return {
      closeoutBodyMd: null,
      closeoutAuthors: [],
      closeoutPostedAt: null,
      ghArtifactRefs: [],
      artifactCount: 0,
    };
  }

  marked.sort((left, right) => {
    const leftMs = left.createdAtDate?.getTime() ?? 0;
    const rightMs = right.createdAtDate?.getTime() ?? 0;
    return leftMs - rightMs;
  });
  // Body: last marked comment wins (most recent operator/agent intent).
  // Authors: deduplicated across all marked comments so multi-author
  // closeouts are not silently discarded; column is structurally a JSON
  // array of distinct authors in first-seen order.
  const selected = marked.at(-1);
  const closeoutAuthors = [];
  const seenAuthors = new Set();
  for (const comment of marked) {
    const author = comment.authorLogin;
    if (!author || seenAuthors.has(author)) continue;
    seenAuthors.add(author);
    closeoutAuthors.push(author);
  }
  const ghArtifactRefs = marked.map((comment) => ({
    kind: 'comment',
    id: comment.nodeId || comment.id || null,
    url: comment.url || null,
  }));
  return {
    closeoutBodyMd: selected.strippedBody,
    closeoutAuthors,
    closeoutPostedAt: selected.createdAt || selected.updatedAt || null,
    ghArtifactRefs,
    artifactCount: ghArtifactRefs.length,
  };
}

function shouldConfirmEmptyCloseout({ mergedAt, observedAt }) {
  const merged = parseDate(mergedAt);
  const observed = parseDate(observedAt);
  if (!merged || !observed) return false;
  return observed.getTime() >= (merged.getTime() + CLOSEOUT_SETTLE_DELAY_MS);
}

export {
  CLOSEOUT_MARKER,
  CLOSEOUT_SETTLE_DELAY_MS,
  composeMergeCloseoutFromComments,
  fetchIssueComments,
  isMergeCloseoutMarked,
  shouldConfirmEmptyCloseout,
  stripMergeCloseoutMarker,
};
