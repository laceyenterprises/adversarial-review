import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLOSEOUT_MARKER = 'hq:closeout:pr';
const CLOSEOUT_SETTLE_DELAY_MS = 10 * 60 * 1000;
const GH_CLOSEOUT_LOOKUP_TIMEOUT_MS = 30_000;

function buildAllowlistedGhEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
  const allowlisted = {
    PATH: env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME ?? '',
  };
  if (token) allowlisted.GH_TOKEN = token;
  return allowlisted;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMergeCloseoutMarked(body) {
  return String(body || '').includes(CLOSEOUT_MARKER);
}

function stripMergeCloseoutMarker(body) {
  return String(body || '')
    .replace(/<!--\s*hq:closeout:pr\s*-->\s*/gi, '')
    .trim();
}

function parseJsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = GH_CLOSEOUT_LOOKUP_TIMEOUT_MS,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
      '-q',
      '.[] | {id: .id, node_id: .node_id, body: .body, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, user: {login: .user.login}}',
    ],
    {
      env: buildAllowlistedGhEnv(env),
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    }
  );
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
  const selected = marked.at(-1);
  return {
    closeoutBodyMd: selected.strippedBody,
    closeoutAuthors: selected.authorLogin ? [selected.authorLogin] : [],
    closeoutPostedAt: selected.createdAt || selected.updatedAt || null,
    ghArtifactRefs: [
      {
        kind: 'comment',
        id: selected.nodeId || selected.id || null,
        url: selected.url || null,
      },
    ],
    artifactCount: 1,
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
