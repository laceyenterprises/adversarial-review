import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import {
  readAdapterHeadAndState,
  readAdapterPrRollup,
  readAdapterReviewBodiesForHead,
  readAdapterReviewContext,
  resolveGitHubAdapterBin,
} from './github-adapter-client.mjs';
import { awaitThrottleIfNeeded, extractRateLimitObservation, recordResponseRateLimit } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 100;
const MAX_GRAPHQL_CONNECTION_PAGES = 100;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const GRAPHQL_COMPLEXITY_PATTERN = /\b(complexity|cost limit|maximum cost|resource limit)\b/i;
const GRAPHQL_COMPLEXITY_ERROR_TYPES = new Set([
  'MAX_COMPLEXITY_EXCEEDED',
  'MAX_NODE_LIMIT_EXCEEDED',
  'MAX_QUERY_COST_EXCEEDED',
  'RESOURCE_LIMIT_EXCEEDED',
]);
const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

const GRAPHQL_ROLLUP_QUERY = `
query PullRequestRollup(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $commentsFirst: Int
  $commentsAfter: String
  $reviewsFirst: Int
  $reviewsAfter: String
  $checksFirst: Int
  $checksAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      id
      number
      title
      body
      state
      mergedAt
      closedAt
      createdAt
      updatedAt
      headRefName
      baseRefName
      headRefOid
      mergeable
      mergeStateStatus
      author {
        login
      }
      labels(first: 100) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      comments(first: $commentsFirst, after: $commentsAfter) {
        nodes {
          id
          author {
            login
          }
          body
          createdAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      reviews(first: $reviewsFirst, after: $reviewsAfter) {
        nodes {
          id
          author {
            login
          }
          body
          state
          submittedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: $checksFirst, after: $checksAfter) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    conclusion
                    completedAt
                    status
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const GRAPHQL_PR_METADATA_QUERY = `
query PullRequestRollupMetadata(
  $owner: String!
  $repo: String!
  $prNumber: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      id
      number
      title
      body
      state
      mergedAt
      closedAt
      createdAt
      updatedAt
      headRefName
      baseRefName
      headRefOid
      mergeable
      mergeStateStatus
      author {
        login
      }
      labels(first: 100) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const GRAPHQL_LABELS_ONLY_QUERY = `
query PullRequestRollupLabels(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $labelsFirst: Int!
  $labelsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      labels(first: $labelsFirst, after: $labelsAfter) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const GRAPHQL_COMMENTS_ONLY_QUERY = `
query PullRequestRollupComments(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $commentsFirst: Int!
  $commentsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      comments(first: $commentsFirst, after: $commentsAfter) {
        nodes {
          id
          author {
            login
          }
          body
          createdAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const GRAPHQL_PR_COMMIT_SUBJECTS_QUERY = `
query PullRequestCommitSubjects(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $commitLast: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      commits(last: $commitLast) {
        nodes {
          commit {
            messageHeadline
            message
          }
        }
      }
    }
  }
}
`;

const GRAPHQL_REVIEWS_ONLY_QUERY = `
query PullRequestRollupReviews(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $reviewsFirst: Int!
  $reviewsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviews(first: $reviewsFirst, after: $reviewsAfter) {
        nodes {
          id
          author {
            login
          }
          body
          state
          submittedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const GRAPHQL_CHECKS_ONLY_QUERY = `
query PullRequestRollupChecks(
  $owner: String!
  $repo: String!
  $headRefOid: GitObjectID!
  $checksFirst: Int!
  $checksAfter: String
) {
  repository(owner: $owner, name: $repo) {
    object(oid: $headRefOid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: $checksFirst, after: $checksAfter) {
            nodes {
              __typename
              ... on CheckRun {
                name
                conclusion
                completedAt
                status
              }
              ... on StatusContext {
                context
                state
                createdAt
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }
}
`;

const GRAPHQL_PR_HEAD_STATE_QUERY = `
query PullRequestHeadState(
  $owner: String!
  $repo: String!
  $prNumber: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      state
      mergedAt
      closedAt
      headRefOid
      author {
        login
      }
      labels(first: 100) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const GRAPHQL_PR_HEAD_ONLY_QUERY = `
query PullRequestHeadOnly(
  $owner: String!
  $repo: String!
  $prNumber: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      state
      mergedAt
      closedAt
      headRefOid
      author {
        login
      }
    }
  }
}
`;

const GRAPHQL_REVIEW_CONTEXT_QUERY = `
query PullRequestReviewContext(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $commentsFirst: Int!
  $commentsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      id
      number
      title
      body
      state
      mergedAt
      closedAt
      createdAt
      updatedAt
      headRefName
      baseRefName
      headRefOid
      mergeable
      mergeStateStatus
      author {
        login
      }
      comments(first: $commentsFirst, after: $commentsAfter) {
        nodes {
          id
          author {
            login
          }
          body
          createdAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

function normalizeCommitSubject(commit) {
  const message = String(
    commit?.commit?.messageHeadline
    || commit?.messageHeadline
    || commit?.commit?.message
    || commit?.message
    || ''
  );
  const subject = message.split(/\r?\n/, 1)[0].trim();
  return subject || null;
}

function splitRepo(repo) {
  const match = /^([^/]+)\/([^/]+)$/.exec(String(repo || '').trim());
  if (!match) {
    throw new TypeError(`Invalid GitHub repo slug: ${repo}`);
  }
  return { owner: match[1], repo: match[2] };
}

function normalizePrNumber(prNumber) {
  const normalized = Number(String(prNumber ?? '').trim());
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`Invalid GitHub PR number: ${prNumber}`);
  }
  return normalized;
}

function normalizeAuthor(author) {
  const login = String(author?.login || '').trim();
  return login ? { login } : null;
}

function normalizeLogin(login) {
  // GitHub App actors (the reviewer bots) surface their login as
  // `<app-slug>[bot]` in the REST reviews API, but the trusted-reviewer set is
  // configured/derived as the bare slug (`lacey-codex-reviewer`). Strip the
  // GitHub-reserved `[bot]` actor-type suffix so the AMA anti-spoof filter in
  // `fetchReviewBodiesForHead` matches App-bot reviews. This does NOT weaken the
  // anti-spoof guarantee: GitHub usernames cannot contain `[` or `]`, so only
  // genuine App actors ever carry the suffix and no human account can forge it.
  return String(login || '')
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}

function normalizeLabel(label) {
  const name = String(label?.name || '').trim();
  return name ? { name } : null;
}

function normalizeLabels(labelsConnection) {
  const source = Array.isArray(labelsConnection)
    ? labelsConnection
    : (labelsConnection?.nodes || []);
  return source
    .map(normalizeLabel)
    .filter(Boolean);
}

function normalizeComment(comment) {
  return {
    id: comment?.id == null ? null : String(comment.id),
    author: normalizeAuthor(comment?.author),
    body: String(comment?.body || ''),
    createdAt: comment?.createdAt || null,
  };
}

function normalizeReview(review) {
  return {
    id: review?.id == null ? null : String(review.id),
    author: normalizeAuthor(review?.author),
    body: String(review?.body || ''),
    state: review?.state || null,
    submittedAt: review?.submittedAt || null,
  };
}

function normalizeCheck(node) {
  if (!node) return null;
  if (node.__typename === 'StatusContext') {
    return {
      name: String(node.context || '').trim() || null,
      conclusion: node.state || null,
      completedAt: node.createdAt || null,
    };
  }
  return {
    name: String(node.name || '').trim() || null,
    conclusion: node.conclusion || node.status || null,
    completedAt: node.completedAt || null,
  };
}

function normalizeRollup(pr, {
  labels = null,
  comments = [],
  reviews = [],
  checks = [],
} = {}) {
  // The exported contract is normalized across GraphQL and legacy fallback:
  // node ids are string-or-null, authors are {login}-or-null, collections are
  // arrays, and state is lower-case open/closed/merged.
  const state = typeof pr?.state === 'string' ? pr.state.toLowerCase() : pr?.state || null;
  const truncatedConnections = collectGraphqlTruncatedConnections(labels, comments, reviews, checks);
  return {
    id: pr?.id ?? null,
    number: Number.isInteger(Number(pr?.number)) ? Number(pr.number) : null,
    title: String(pr?.title || ''),
    body: String(pr?.body || ''),
    state,
    mergedAt: pr?.mergedAt || null,
    closedAt: pr?.closedAt || null,
    createdAt: pr?.createdAt || null,
    updatedAt: pr?.updatedAt || null,
    headRefName: pr?.headRefName || null,
    baseRefName: pr?.baseRefName || null,
    headRefOid: pr?.headRefOid || null,
    mergeable: pr?.mergeable || null,
    mergeStateStatus: pr?.mergeStateStatus || null,
    author: normalizeAuthor(pr?.author),
    labels: labels || normalizeLabels(pr?.labels),
    comments,
    reviews,
    checks,
    ...(truncatedConnections.length > 0
      ? { truncated: true, truncatedConnections }
      : {}),
  };
}

function normalizeAdapterRollup(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub adapter rollup payload must be an object');
  }
  const normalized = normalizeRollup(payload, {
    labels: normalizeLabels(payload.labels),
    comments: Array.isArray(payload.comments) ? payload.comments.map(normalizeComment) : [],
    reviews: Array.isArray(payload.reviews) ? payload.reviews.map(normalizeReview) : [],
    checks: Array.isArray(payload.checks) ? payload.checks.map(normalizeCheck).filter(Boolean) : [],
  });
  if (!Number.isInteger(normalized.number)) {
    throw new Error('GitHub adapter rollup payload missing PR number');
  }
  if (!normalized.headRefOid) {
    throw new Error('GitHub adapter rollup payload missing headRefOid');
  }
  if (!normalized.mergeable) {
    throw new Error('GitHub adapter rollup payload missing mergeable');
  }
  if (!normalized.mergeStateStatus) {
    throw new Error('GitHub adapter rollup payload missing mergeStateStatus');
  }
  return normalized;
}

function normalizeAdapterReviewContext(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub adapter review-context payload must be an object');
  }
  const normalized = normalizeRollup(payload, {
    labels: [],
    comments: Array.isArray(payload.comments) ? payload.comments.map(normalizeComment) : [],
    reviews: [],
    checks: [],
  });
  if (!Number.isInteger(normalized.number)) {
    throw new Error('GitHub adapter review-context payload missing PR number');
  }
  if (!normalized.headRefOid) {
    throw new Error('GitHub adapter review-context payload missing headRefOid');
  }
  return {
    ...normalized,
    mergeable: null,
    mergeStateStatus: null,
    labels: [],
    reviews: [],
    checks: [],
  };
}

function normalizeHeadAndStateShape({
  state,
  mergedAt = null,
  closedAt = null,
  headRefOid = null,
  author = null,
  labels = [],
  truncatedConnections = [],
} = {}) {
  return {
    state: typeof state === 'string' ? state.toLowerCase() : state || null,
    mergedAt: mergedAt || null,
    closedAt: closedAt || null,
    headRefOid: headRefOid || null,
    author: normalizeAuthor(author),
    labels,
    ...(truncatedConnections.length > 0
      ? { truncated: true, truncatedConnections }
      : {}),
  };
}

function normalizeAdapterHeadAndState(payload, { withLabels = true } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub adapter head/state payload must be an object');
  }
  const labels = withLabels ? normalizeLabels(payload.labels) : [];
  const headRefOid = payload?.headRefOid || payload?.head_sha || payload?.headSha || null;
  if (!headRefOid) {
    throw new Error('GitHub adapter head/state payload missing headRefOid');
  }
  return normalizeHeadAndStateShape({
    state: payload?.state,
    mergedAt: payload?.mergedAt || payload?.merged_at,
    closedAt: payload?.closedAt || payload?.closed_at,
    headRefOid,
    author: payload?.author || payload?.user,
    labels,
    truncatedConnections: payload?.truncated ? payload.truncatedConnections || [] : [],
  });
}

function markGraphqlTruncated(items, connectionName) {
  const existing = Array.isArray(items?.graphqlTruncatedConnections)
    ? items.graphqlTruncatedConnections
    : [];
  Object.defineProperty(items, 'graphqlTruncated', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(items, 'graphqlTruncatedConnections', {
    value: [...new Set([...existing, connectionName])],
    configurable: true,
  });
  return items;
}

function appendGraphqlItemsPreservingTruncation(target, source, connectionName) {
  target.push(...source);
  if (source?.graphqlTruncated) {
    markGraphqlTruncated(target, connectionName);
  }
}

function collectGraphqlTruncatedConnections(...lists) {
  return [...new Set(lists.flatMap((list) => (
    Array.isArray(list?.graphqlTruncatedConnections) ? list.graphqlTruncatedConnections : []
  )))];
}

function copyEnvValue(source, target, key) {
  if (source[key] !== undefined) target[key] = source[key];
}

function buildGhEnv(env = process.env) {
  const ghEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_CONFIG_DIR',
    'GH_HOST',
    'GITHUB_HOST',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE_BUNDLE',
  ]) {
    copyEnvValue(env, ghEnv, key);
  }
  if (!ghEnv.GH_TOKEN && ghEnv.GITHUB_TOKEN) {
    ghEnv.GH_TOKEN = ghEnv.GITHUB_TOKEN;
  }
  return ghEnv;
}

function parseGhApiHttpEnvelope(stdout) {
  const text = String(stdout || '');
  const crlfSeparator = text.indexOf('\r\n\r\n');
  const lfSeparator = text.indexOf('\n\n');
  let separator = -1;
  let separatorLength = 0;
  if (crlfSeparator >= 0 && (lfSeparator < 0 || crlfSeparator <= lfSeparator)) {
    separator = crlfSeparator;
    separatorLength = 4;
  } else if (lfSeparator >= 0) {
    separator = lfSeparator;
    separatorLength = 2;
  }
  if (separator < 0) {
    return { headers: {}, bodyText: text };
  }
  const headerText = text.slice(0, separator).replace(/\r\n/g, '\n');
  const bodyText = text.slice(separator + separatorLength);
  const headers = {};
  for (const line of headerText.split('\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, bodyText };
}

async function execGhJson(execFileImpl, args) {
  const headerAware = args[0] === 'api';
  if (headerAware && args.includes('--paginate')) {
    throw new Error('execGhJson does not support `gh api --paginate` with header-aware rate-limit parsing; use an explicit page loop instead');
  }
  const throttleResource = args[0] === 'api' && args[1] === 'graphql' ? 'graphql' : 'core';
  try {
    await awaitThrottleIfNeeded(throttleResource);
    const effectiveArgs = headerAware ? ['api', '-i', ...args.slice(1)] : args;
    const { stdout } = await execFileImpl('gh', effectiveArgs, {
      maxBuffer: GH_MAX_BUFFER,
      env: buildGhEnv(),
    });
    if (headerAware) {
      const response = parseGhApiHttpEnvelope(stdout);
      await recordResponseRateLimit(extractRateLimitObservation(response.headers));
      return JSON.parse(String(response.bodyText || 'null'));
    }
    return JSON.parse(String(stdout || 'null'));
  } catch (err) {
    if (headerAware) {
      const response = parseGhApiHttpEnvelope(err?.stdout || '');
      await recordResponseRateLimit(extractRateLimitObservation(response.headers));
    }
    const payload = tryParseGraphqlErrorPayload(err);
    if (payload?.errors) {
      err.graphqlErrors = payload.errors;
    }
    throw err;
  }
}

async function runGraphql(execFileImpl, query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    const flag = typeof value === 'number' ? '-F' : '-f';
    args.push(flag, `${key}=${value}`);
  }
  return execGhJson(execFileImpl, args);
}

async function runGraphqlWithTelemetry(execFileImpl, query, variables, {
  repo,
  prNumber,
  category,
  recordApiCallImpl,
} = {}) {
  const startedAt = Date.now();
  try {
    const result = await runGraphql(execFileImpl, query, variables);
    recordApiCallImpl?.({
      category,
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    recordApiCallImpl?.({
      category,
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    err.graphqlTelemetryRecorded = true;
    throw err;
  }
}

async function runAdapterReadWithTelemetry(category, {
  repo,
  prNumber,
  recordApiCallImpl,
  env = process.env,
  adapterAvailable = Boolean(resolveGitHubAdapterBin({ env })),
}, action) {
  if (!adapterAvailable) return null;
  const startedAt = Date.now();
  try {
    await awaitThrottleIfNeeded('core');
    const result = await action();
    if (result !== null && result !== undefined) {
      recordApiCallImpl?.({
        category,
        repo,
        prNumber,
        status: 200,
        durationMs: Date.now() - startedAt,
        extra: { transport: 'github-adapter' },
      });
    }
    return result;
  } catch (err) {
    recordApiCallImpl?.({
      category,
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
      extra: { transport: 'github-adapter' },
    });
    throw err;
  }
}

async function paginateRest(execFileImpl, basePath, mapPage) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const data = await execGhJson(execFileImpl, ['api', `${basePath}${separator}per_page=${PAGE_SIZE}&page=${page}`]);
    const pageRows = mapPage(data);
    if (pageRows.length === 0) break;
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }
  return rows;
}

async function paginateRestWithTotalCount(execFileImpl, basePath, mapPage, totalCountFromPage) {
  const rows = [];
  let expectedTotal = null;
  for (let page = 1; ; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const data = await execGhJson(execFileImpl, ['api', `${basePath}${separator}per_page=${PAGE_SIZE}&page=${page}`]);
    const pageRows = mapPage(data);
    const pageTotal = Number(totalCountFromPage(data));
    if (Number.isFinite(pageTotal) && pageTotal >= 0) {
      expectedTotal = pageTotal;
    }
    if (pageRows.length === 0) break;
    rows.push(...pageRows);
    if (expectedTotal !== null && rows.length >= expectedTotal) break;
    if (expectedTotal === null && pageRows.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchLegacyPr(execFileImpl, repo, prNumber) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  return execGhJson(execFileImpl, [
    'pr',
    'view',
    String(normalizedPrNumber),
    '--repo',
    repo,
    '--json',
    'id,number,title,body,state,mergedAt,closedAt,createdAt,updatedAt,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,author,labels',
  ]);
}

async function fetchLegacyComments(execFileImpl, repo, prNumber) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  return paginateRest(
    execFileImpl,
    `repos/${repo}/issues/${normalizedPrNumber}/comments`,
    (data) => (Array.isArray(data) ? data : []).map((comment) => ({
      id: comment?.id == null ? null : String(comment.id),
      author: normalizeAuthor(comment?.user),
      body: String(comment?.body || ''),
      createdAt: comment?.created_at || null,
    })),
  );
}

async function fetchLegacyReviews(execFileImpl, repo, prNumber) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  return paginateRest(
    execFileImpl,
    `repos/${repo}/pulls/${normalizedPrNumber}/reviews`,
    (data) => (Array.isArray(data) ? data : []).map((review) => ({
      id: review?.id == null ? null : String(review.id),
      author: normalizeAuthor(review?.user),
      body: String(review?.body || ''),
      state: review?.state || null,
      submittedAt: review?.submitted_at || null,
    })),
  );
}

/**
 * Fetch the bodies of every submitted review whose `commit_id` matches
 * `headSha`, newest-first. The AMA closer uses this to reconcile its stored
 * verdict source against the LIVE latest authoritative review on the current
 * head — a completed remediation job's stored `reviewBody` can be stale
 * relative to a fresh `Request changes` review on the same head, which let the
 * closer fail-open merge #1824 / #1816. Reviews with no `submitted_at`, a
 * non-submitted state, a non-matching `commit_id`, or (when supplied) a
 * non-authoritative author are excluded. Throws on API failure so the caller can
 * fail closed.
 *
 * @returns {Promise<string[]>} review bodies on `headSha`, newest submitted first.
 */
async function fetchReviewBodiesForHead(execFileImpl, repo, prNumber, headSha, {
  authoritativeReviewerLogins = null,
  authoritativeReviewerLogin = null,
  env = process.env,
  recordApiCallImpl = recordApiCall,
} = {}) {
  if (!headSha) return [];
  // Accept reviews from ANY login in the trusted reviewer-bot set (anti-spoof).
  // The set carries both observed naming forms for the reviewer model. An
  // explicit-but-empty/unresolvable set fails closed. Keep the deprecated
  // singular option as a transition alias so stale callers cannot accidentally
  // disable filtering.
  const reviewerLoginCandidates = authoritativeReviewerLogins != null
    ? authoritativeReviewerLogins
    : authoritativeReviewerLogin == null
      ? null
      : [authoritativeReviewerLogin];
  const loginList = Array.isArray(reviewerLoginCandidates)
    ? reviewerLoginCandidates.map(normalizeLogin).filter(Boolean)
    : [];
  const expectedReviewerLoginSet = loginList.length ? new Set(loginList) : null;
  if (reviewerLoginCandidates != null && !expectedReviewerLoginSet) return [];
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const filterSubmittedReviewForHead = (review) => {
    if (!review.submittedAt || !review.commitId || String(review.commitId) !== String(headSha)) {
      return false;
    }
    if (!SUBMITTED_REVIEW_STATES.has(String(review.state || '').toUpperCase())) {
      return false;
    }
    if (expectedReviewerLoginSet && !expectedReviewerLoginSet.has(normalizeLogin(review.author?.login))) {
      return false;
    }
    return true;
  };
  const sortNewestSubmittedFirst = (a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt));
  try {
    const adapterReviews = await runAdapterReadWithTelemetry('reviews_list', {
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
      env,
    }, () => readAdapterReviewBodiesForHead(repo, normalizedPrNumber, headSha, {
      execFileImpl,
      env,
      reviewerLogins: loginList,
    }));
    if (Array.isArray(adapterReviews) && adapterReviews.length > 0) {
      const allAdapterReviewsVerifiable = adapterReviews.every((review) => (
        review && typeof review === 'object' && !Array.isArray(review)
      ));
      if (allAdapterReviewsVerifiable) {
        return adapterReviews
          .map((review) => ({
            ...review,
            author: normalizeAuthor(review.author),
          }))
          .filter(filterSubmittedReviewForHead)
          .sort(sortNewestSubmittedFirst)
          .map((review) => review.body);
      }
    }
  } catch {
    // Optional adapter failed or returned malformed data; preserve the existing
    // fail-closed legacy read contract by falling through to the old reader.
  }
  const reviews = await paginateRest(
    execFileImpl,
    `repos/${repo}/pulls/${normalizedPrNumber}/reviews`,
    (data) => (Array.isArray(data) ? data : []).map((review) => ({
      author: normalizeAuthor(review?.user),
      body: String(review?.body || ''),
      state: review?.state || null,
      submittedAt: review?.submitted_at || null,
      commitId: review?.commit_id || null,
    })),
  );
  return reviews
    .filter(filterSubmittedReviewForHead)
    .sort(sortNewestSubmittedFirst)
    .map((review) => review.body);
}

async function fetchLegacyChecks(execFileImpl, repo, headRefOid) {
  if (!headRefOid) return [];
  const checkRuns = await paginateRestWithTotalCount(
    execFileImpl,
    `repos/${repo}/commits/${headRefOid}/check-runs`,
    (data) => (Array.isArray(data?.check_runs) ? data.check_runs : []).map((checkRun) => ({
      name: String(checkRun?.name || '').trim() || null,
      conclusion: checkRun?.conclusion || checkRun?.status || null,
      completedAt: checkRun?.completed_at || null,
    })),
    (data) => data?.total_count,
  );
  const statuses = await paginateRest(
    execFileImpl,
    `repos/${repo}/commits/${headRefOid}/status`,
    (data) => (Array.isArray(data?.statuses) ? data.statuses : []).map((status) => ({
      name: String(status?.context || '').trim() || null,
      conclusion: status?.state || null,
      completedAt: status?.updated_at || status?.created_at || null,
    })),
  );
  const byName = new Map();
  for (const check of checkRuns) {
    if (check?.name) byName.set(check.name, check);
  }
  for (const status of statuses) {
    if (status?.name && !byName.has(status.name)) byName.set(status.name, status);
  }
  return [...byName.values()];
}

async function fetchLegacyHeadAndState(execFileImpl, repo, prNumber, { withLabels = true } = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const pr = await execGhJson(execFileImpl, [
    'api',
    `repos/${repo}/pulls/${normalizedPrNumber}`,
  ]);
  const labels = withLabels
    ? await paginateRest(
      execFileImpl,
      `repos/${repo}/issues/${normalizedPrNumber}/labels`,
      (data) => normalizeLabels(Array.isArray(data) ? data : []),
    )
    : [];
  return {
    ...normalizeHeadAndStateShape({
      state: pr?.state,
      mergedAt: pr?.merged_at,
      closedAt: pr?.closed_at,
      headRefOid: pr?.head?.sha,
      author: pr?.user,
      labels,
    }),
  };
}

async function fetchLegacyWithTelemetry(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  async function withLegacyTelemetry(category, action) {
    const startedAt = Date.now();
    try {
      const result = await action();
      recordApiCallImpl({
        category,
        repo,
        prNumber: normalizedPrNumber,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      recordApiCallImpl({
        category,
        repo,
        prNumber: normalizedPrNumber,
        status: apiStatusFromError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const pr = await withLegacyTelemetry('pr_view', () => fetchLegacyPr(execFileImpl, repo, normalizedPrNumber));
  const comments = await withLegacyTelemetry('comments_list', () => fetchLegacyComments(execFileImpl, repo, normalizedPrNumber));
  const reviews = await withLegacyTelemetry('reviews_list', () => fetchLegacyReviews(execFileImpl, repo, normalizedPrNumber));
  const checks = await withLegacyTelemetry('checks_list', () => fetchLegacyChecks(execFileImpl, repo, pr?.headRefOid || null));

  return normalizeRollup(pr, { comments, reviews, checks });
}

async function fetchLegacyReviewContextWithTelemetry(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  async function withLegacyTelemetry(category, action) {
    const startedAt = Date.now();
    try {
      const result = await action();
      recordApiCallImpl({
        category,
        repo,
        prNumber: normalizedPrNumber,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      recordApiCallImpl({
        category,
        repo,
        prNumber: normalizedPrNumber,
        status: apiStatusFromError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const pr = await withLegacyTelemetry('pr_view', () => fetchLegacyPr(execFileImpl, repo, normalizedPrNumber));
  const comments = await withLegacyTelemetry('comments_list', () => fetchLegacyComments(execFileImpl, repo, normalizedPrNumber));
  return normalizeRollup(pr, { labels: [], comments });
}

function describeGraphqlErrorTypes(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const types = errors
    .map((entry) => entry?.type || entry?.extensions?.type || entry?.extensions?.code || entry?.code)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return types.length ? `; error types: ${[...new Set(types)].join(', ')}` : '';
}

function extractGraphqlPr(payload) {
  const repository = payload?.data?.repository || payload?.repository || null;
  const suffix = describeGraphqlErrorTypes(payload);
  if (!payload || (!payload.data && !payload.repository)) {
    const err = new Error(`GitHub GraphQL payload missing${suffix}`);
    err.code = 'graphql_payload_missing';
    throw err;
  }
  if (!repository) {
    const err = new Error(`GitHub GraphQL repository payload missing${suffix}`);
    err.code = 'graphql_repository_missing';
    throw err;
  }
  if (!repository.pullRequest) {
    const err = new Error(`GitHub GraphQL pullRequest payload missing${suffix}`);
    err.code = 'graphql_pull_request_missing';
    throw err;
  }
  return repository.pullRequest;
}

function extractGraphqlRepository(payload) {
  return payload?.data?.repository || payload?.repository || null;
}

function extractGraphqlCommitObject(payload) {
  return extractGraphqlRepository(payload)?.object || null;
}

function extractChecksConnection(pr) {
  return pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts || null;
}

function extractChecksConnectionFromCommitObject(payload) {
  return extractGraphqlCommitObject(payload)?.statusCheckRollup?.contexts || null;
}

function extractLabelsConnection(pr) {
  return pr?.labels || null;
}

function appendGraphqlPage(target, nodes, normalize) {
  for (const node of nodes || []) {
    const normalized = normalize(node);
    if (normalized) target.push(normalized);
  }
}

function tryParseJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryParseGraphqlErrorPayload(err) {
  const candidates = [
    err?.stdout,
    err?.stderr,
    err?.cause?.stdout,
    err?.cause?.stderr,
  ];
  for (const candidate of candidates) {
    if (String(candidate || '').trim() && !tryParseJson(candidate)) {
      err.graphqlErrorPayloadParseFailed = true;
    }
    const parsed = tryParseJson(candidate);
    if (parsed?.errors) return parsed;
  }
  return null;
}

function isStructuredComplexityType(value) {
  const type = String(value || '').trim().toUpperCase();
  return GRAPHQL_COMPLEXITY_ERROR_TYPES.has(type);
}

function isRateLimitErrorType(value) {
  const type = String(value || '').trim().toUpperCase();
  return type === 'RATE_LIMITED' || type === 'RESOURCE_NOT_ACCESSIBLE';
}

let warnedRegexComplexityFallback = false;

function graphqlStatusFromError(err) {
  const status = Number(
    err?.status ??
    err?.response?.status ??
    graphqlStatusFromText(err?.stderr) ??
    graphqlStatusFromText(err?.stdout) ??
    graphqlStatusFromText(err?.cause?.stderr) ??
    graphqlStatusFromText(err?.cause?.stdout)
  );
  return Number.isFinite(status) ? Math.trunc(status) : null;
}

function graphqlStatusFromText(value) {
  const match = String(value || '').match(/\bHTTP\s+([1-5][0-9]{2})\b/i);
  return match ? Number(match[1]) : null;
}

function warnRegexComplexityFallbackOnce() {
  if (warnedRegexComplexityFallback) return;
  warnedRegexComplexityFallback = true;
  console.warn('[github-api] WARN: falling back to GraphQL complexity regex detection because gh did not return structured GraphQL errors');
}

function isGraphqlComplexityError(err) {
  const errors = Array.isArray(err?.graphqlErrors) ? err.graphqlErrors : [];
  for (const entry of errors) {
    const typeCandidates = [
      entry?.type,
      entry?.extensions?.type,
      entry?.extensions?.code,
      entry?.code,
    ];
    if (typeCandidates.some(isRateLimitErrorType)) {
      return false;
    }
    if (typeCandidates.some(isStructuredComplexityType)) {
      return true;
    }
  }
  const message = String(err?.message || '');
  if (/\brate[-_ ]?limit(?:ed)?\b/i.test(message)) return false;
  const status = graphqlStatusFromError(err);
  const explicitGraphqlFailure = status !== null && status >= 400 && status <= 599;
  if (explicitGraphqlFailure && GRAPHQL_COMPLEXITY_PATTERN.test(message)) {
    if (err?.graphqlErrorPayloadParseFailed || err?.stderr) {
      warnRegexComplexityFallbackOnce();
    }
    return true;
  }
  return false;
}

function isGraphqlRollupDisabled(env = process.env) {
  return env.GHO_DISABLE_GRAPHQL_ROLLUP === '1';
}

function assertGraphqlCursorProgress({ connectionName, page, after, nextAfter }) {
  if (!nextAfter) {
    throw new Error(`GraphQL ${connectionName} pagination did not return an endCursor on page ${page}`);
  }
  if (after && nextAfter === after) {
    throw new Error(`GraphQL ${connectionName} pagination cursor did not advance on page ${page}`);
  }
}

async function fetchGraphqlConnectionPages(repo, prNumber, {
  execFileImpl,
  query,
  firstVariable,
  afterVariable,
  startAfter = null,
  extractConnection,
  normalize,
  connectionName = firstVariable,
  extraVariables = {},
  recordApiCallImpl,
  telemetryCategory = 'graphql_pr_rollup',
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const items = [];
  let after = startAfter;
  let hasNextPage = true;
  let page = 0;
  while (hasNextPage) {
    page += 1;
    if (page > MAX_GRAPHQL_CONNECTION_PAGES) {
      console.warn(
        `[github-api] WARN: GraphQL ${connectionName} pagination exceeded ${MAX_GRAPHQL_CONNECTION_PAGES} pages for ${repo}#${normalizedPrNumber}; returning partial results with truncated=true`
      );
      markGraphqlTruncated(items, connectionName);
      break;
    }
    const payload = await runGraphqlWithTelemetry(execFileImpl, query, {
      owner,
      repo: repoName,
      prNumber: normalizedPrNumber,
      ...extraVariables,
      [firstVariable]: PAGE_SIZE,
      [afterVariable]: after,
    }, {
      repo,
      prNumber: normalizedPrNumber,
      category: telemetryCategory,
      recordApiCallImpl,
    });
    const pr = payload?.data?.repository?.pullRequest || payload?.repository?.pullRequest || null;
    const connection = extractConnection(pr, payload);
    appendGraphqlPage(items, connection?.nodes, normalize);
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    const nextAfter = connection?.pageInfo?.endCursor || null;
    if (hasNextPage) {
      assertGraphqlCursorProgress({ connectionName, page, after, nextAfter });
      after = nextAfter;
    }
  }
  return items;
}

async function fetchGraphqlLabelPages(repo, prNumber, {
  execFileImpl,
  startAfter = null,
  recordApiCallImpl,
  telemetryCategory = 'graphql_pr_rollup',
} = {}) {
  return fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_LABELS_ONLY_QUERY,
    firstVariable: 'labelsFirst',
    afterVariable: 'labelsAfter',
    startAfter,
    extractConnection: extractLabelsConnection,
    normalize: normalizeLabel,
    connectionName: 'labels',
    recordApiCallImpl,
    telemetryCategory,
  });
}

async function fetchGraphqlCheckPages(repo, prNumber, headRefOid, {
  execFileImpl,
  startAfter = null,
  recordApiCallImpl,
  telemetryCategory = 'graphql_pr_rollup',
} = {}) {
  if (!headRefOid) return [];
  return fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_CHECKS_ONLY_QUERY,
    firstVariable: 'checksFirst',
    afterVariable: 'checksAfter',
    startAfter,
    extractConnection: (_pr, payload) => extractChecksConnectionFromCommitObject(payload),
    normalize: normalizeCheck,
    connectionName: 'checks',
    extraVariables: { headRefOid },
    recordApiCallImpl,
    telemetryCategory,
  });
}

async function fetchGraphqlRollupMultiplexed(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const comments = [];
  const reviews = [];
  const checks = [];
  const payload = await runGraphqlWithTelemetry(execFileImpl, GRAPHQL_ROLLUP_QUERY, {
    owner,
    repo: repoName,
    prNumber: normalizedPrNumber,
    commentsFirst: PAGE_SIZE,
    commentsAfter: null,
    reviewsFirst: PAGE_SIZE,
    reviewsAfter: null,
    checksFirst: PAGE_SIZE,
    checksAfter: null,
  }, {
    repo,
    prNumber: normalizedPrNumber,
    category: 'graphql_pr_rollup',
    recordApiCallImpl,
  });
  const pr = extractGraphqlPr(payload);
  const labels = normalizeLabels(pr?.labels);

  appendGraphqlPage(comments, pr?.comments?.nodes, normalizeComment);
  appendGraphqlPage(reviews, pr?.reviews?.nodes, normalizeReview);
  appendGraphqlPage(checks, extractChecksConnection(pr)?.nodes, normalizeCheck);

  if (pr?.labels?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(labels, await fetchGraphqlLabelPages(repo, normalizedPrNumber, {
      execFileImpl,
      startAfter: pr?.labels?.pageInfo?.endCursor || null,
      recordApiCallImpl,
      telemetryCategory: 'graphql_pr_rollup',
    }), 'labels');
  }
  if (pr?.comments?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(comments, await fetchGraphqlConnectionPages(repo, normalizedPrNumber, {
      execFileImpl,
      query: GRAPHQL_COMMENTS_ONLY_QUERY,
      firstVariable: 'commentsFirst',
      afterVariable: 'commentsAfter',
      startAfter: pr?.comments?.pageInfo?.endCursor || null,
      extractConnection: (value) => value?.comments,
      normalize: normalizeComment,
      connectionName: 'comments',
      recordApiCallImpl,
      telemetryCategory: 'graphql_pr_rollup',
    }), 'comments');
  }
  if (pr?.reviews?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(reviews, await fetchGraphqlConnectionPages(repo, normalizedPrNumber, {
      execFileImpl,
      query: GRAPHQL_REVIEWS_ONLY_QUERY,
      firstVariable: 'reviewsFirst',
      afterVariable: 'reviewsAfter',
      startAfter: pr?.reviews?.pageInfo?.endCursor || null,
      extractConnection: (value) => value?.reviews,
      normalize: normalizeReview,
      connectionName: 'reviews',
      recordApiCallImpl,
      telemetryCategory: 'graphql_pr_rollup',
    }), 'reviews');
  }
  if (extractChecksConnection(pr)?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(checks, await fetchGraphqlCheckPages(repo, normalizedPrNumber, pr?.headRefOid || null, {
      execFileImpl,
      startAfter: extractChecksConnection(pr)?.pageInfo?.endCursor || null,
      recordApiCallImpl,
      telemetryCategory: 'graphql_pr_rollup',
    }), 'checks');
  }

  return normalizeRollup(pr, { labels, comments, reviews, checks });
}

async function fetchGraphqlRollupPerList(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const initial = await runGraphqlWithTelemetry(execFileImpl, GRAPHQL_PR_METADATA_QUERY, {
    owner,
    repo: repoName,
    prNumber: normalizedPrNumber,
  }, {
    repo,
    prNumber: normalizedPrNumber,
    category: 'graphql_pr_rollup',
    recordApiCallImpl,
  });
  const pr = extractGraphqlPr(initial);
  const labels = normalizeLabels(pr?.labels);
  if (pr?.labels?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(labels, await fetchGraphqlLabelPages(repo, normalizedPrNumber, {
      execFileImpl,
      startAfter: pr?.labels?.pageInfo?.endCursor || null,
      recordApiCallImpl,
      telemetryCategory: 'graphql_pr_rollup',
    }), 'labels');
  }
  const comments = await fetchGraphqlConnectionPages(repo, normalizedPrNumber, {
    execFileImpl,
    query: GRAPHQL_COMMENTS_ONLY_QUERY,
    firstVariable: 'commentsFirst',
    afterVariable: 'commentsAfter',
    extractConnection: (value) => value?.comments,
    normalize: normalizeComment,
    connectionName: 'comments',
    recordApiCallImpl,
    telemetryCategory: 'graphql_pr_rollup',
  });
  const reviews = await fetchGraphqlConnectionPages(repo, normalizedPrNumber, {
    execFileImpl,
    query: GRAPHQL_REVIEWS_ONLY_QUERY,
    firstVariable: 'reviewsFirst',
    afterVariable: 'reviewsAfter',
    extractConnection: (value) => value?.reviews,
    normalize: normalizeReview,
    connectionName: 'reviews',
    recordApiCallImpl,
    telemetryCategory: 'graphql_pr_rollup',
  });
  const checks = await fetchGraphqlCheckPages(repo, normalizedPrNumber, pr?.headRefOid || null, {
    execFileImpl,
    recordApiCallImpl,
    telemetryCategory: 'graphql_pr_rollup',
  });

  return normalizeRollup(pr, { labels, comments, reviews, checks });
}

async function fetchGraphqlReviewContext(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const comments = [];
  let after = null;
  let hasNextPage = true;
  let page = 0;
  let pr = null;
  while (hasNextPage) {
    page += 1;
    if (page > MAX_GRAPHQL_CONNECTION_PAGES) {
      console.warn(
        `[github-api] WARN: GraphQL review-context comments pagination exceeded ${MAX_GRAPHQL_CONNECTION_PAGES} pages for ${repo}#${normalizedPrNumber}; returning partial results with truncated=true`
      );
      markGraphqlTruncated(comments, 'comments');
      break;
    }
    const payload = await runGraphqlWithTelemetry(execFileImpl, GRAPHQL_REVIEW_CONTEXT_QUERY, {
      owner,
      repo: repoName,
      prNumber: normalizedPrNumber,
      commentsFirst: PAGE_SIZE,
      commentsAfter: after,
    }, {
      repo,
      prNumber: normalizedPrNumber,
      category: 'pr_review_context',
      recordApiCallImpl,
    });
    pr = extractGraphqlPr(payload);
    const connection = pr?.comments || null;
    appendGraphqlPage(comments, connection?.nodes, normalizeComment);
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    const nextAfter = connection?.pageInfo?.endCursor || null;
    if (hasNextPage) {
      assertGraphqlCursorProgress({
        connectionName: 'review-context comments',
        page,
        after,
        nextAfter,
      });
      after = nextAfter;
    }
  }
  return normalizeRollup(pr, { labels: [], comments });
}

async function fetchPullRequestHeadAndState(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  withLabels = true,
  env = process.env,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  try {
    const adapterResult = await runAdapterReadWithTelemetry('pr_head_state', {
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
      env,
    }, () => readAdapterHeadAndState(repo, normalizedPrNumber, { execFileImpl, withLabels, env }));
    if (adapterResult) {
      return normalizeAdapterHeadAndState(adapterResult, { withLabels });
    }
  } catch {
    // Adapter is optional during the migration window; fall back to the current
    // GraphQL/REST path and keep that path's established safety behavior.
  }
  if (isGraphqlRollupDisabled()) {
    const startedAt = Date.now();
    try {
      const result = await fetchLegacyHeadAndState(execFileImpl, repo, normalizedPrNumber, { withLabels });
      recordApiCallImpl({
        category: 'pr_head_state',
        repo,
        prNumber: normalizedPrNumber,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      recordApiCallImpl({
        category: 'pr_head_state',
        repo,
        prNumber: normalizedPrNumber,
        status: apiStatusFromError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const payload = await runGraphqlWithTelemetry(execFileImpl, withLabels ? GRAPHQL_PR_HEAD_STATE_QUERY : GRAPHQL_PR_HEAD_ONLY_QUERY, {
      owner,
      repo: repoName,
      prNumber: normalizedPrNumber,
    }, {
      repo,
      prNumber: normalizedPrNumber,
      category: 'pr_head_state',
      recordApiCallImpl,
    });
  const pr = extractGraphqlPr(payload);
  const labels = withLabels ? normalizeLabels(pr?.labels) : [];
  if (withLabels && pr?.labels?.pageInfo?.hasNextPage) {
    appendGraphqlItemsPreservingTruncation(labels, await fetchGraphqlLabelPages(repo, normalizedPrNumber, {
      execFileImpl,
      startAfter: pr?.labels?.pageInfo?.endCursor || null,
      recordApiCallImpl,
      telemetryCategory: 'pr_head_state',
    }), 'labels');
  }
  return normalizeHeadAndStateShape({
    state: pr?.state,
    mergedAt: pr?.mergedAt,
    closedAt: pr?.closedAt,
    headRefOid: pr?.headRefOid,
    author: pr?.author,
    labels,
    truncatedConnections: labels.graphqlTruncated ? labels.graphqlTruncatedConnections : [],
  });
}

async function fetchPullRequestRollup(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  env = process.env,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  try {
    const adapterResult = await runAdapterReadWithTelemetry('graphql_pr_rollup', {
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
      env,
    }, () => readAdapterPrRollup(repo, normalizedPrNumber, { execFileImpl, env }));
    if (adapterResult) {
      return normalizeAdapterRollup(adapterResult);
    }
  } catch {
    // Optional adapter failed or returned a non-contract payload. The legacy
    // implementation remains authoritative until the superproject cutover.
  }
  if (isGraphqlRollupDisabled()) {
    return fetchLegacyWithTelemetry(repo, normalizedPrNumber, { execFileImpl, recordApiCallImpl });
  }

  const startedAt = Date.now();
  try {
    let result;
    try {
      result = await fetchGraphqlRollupMultiplexed(repo, normalizedPrNumber, { execFileImpl, recordApiCallImpl });
    } catch (err) {
      if (!isGraphqlComplexityError(err)) throw err;
      result = await fetchGraphqlRollupPerList(repo, normalizedPrNumber, { execFileImpl, recordApiCallImpl });
    }
    return result;
  } catch (err) {
    if (!err?.graphqlTelemetryRecorded) recordApiCallImpl({
      category: 'graphql_pr_rollup',
      repo,
      prNumber: normalizedPrNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function fetchPullRequestReviewContext(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  env = process.env,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  try {
    const adapterResult = await runAdapterReadWithTelemetry('pr_review_context', {
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
      env,
    }, () => readAdapterReviewContext(repo, normalizedPrNumber, { execFileImpl, env }));
    if (adapterResult) {
      return normalizeAdapterReviewContext(adapterResult);
    }
  } catch {
    // Optional adapter failed or returned malformed data; preserve fallback.
  }
  if (isGraphqlRollupDisabled()) {
    return fetchLegacyReviewContextWithTelemetry(repo, normalizedPrNumber, { execFileImpl, recordApiCallImpl });
  }
  return fetchGraphqlReviewContext(repo, normalizedPrNumber, { execFileImpl, recordApiCallImpl });
}

async function fetchPullRequestCommitSubjects(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  limit = 5,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const normalizedLimit = Number(limit);
  const commitLast = Number.isInteger(normalizedLimit) && normalizedLimit > 0
    ? Math.min(normalizedLimit, PAGE_SIZE)
    : 5;
  const { owner, repo: repoName } = splitRepo(repo);
  try {
    const payload = await runGraphqlWithTelemetry(execFileImpl, GRAPHQL_PR_COMMIT_SUBJECTS_QUERY, {
      owner,
      repo: repoName,
      prNumber: normalizedPrNumber,
      commitLast,
    }, {
      category: 'pr_commits',
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
    });
    const pr = extractGraphqlPr(payload);
    const nodes = pr?.commits?.nodes || [];
    return Array.isArray(nodes) ? nodes.map(normalizeCommitSubject).filter(Boolean) : [];
  } catch (err) {
    throw err;
  }
}

async function fetchPullRequestMergeability(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  env = process.env,
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);
  try {
    const adapterResult = await runAdapterReadWithTelemetry('pr_mergeability', {
      repo,
      prNumber: normalizedPrNumber,
      recordApiCallImpl,
      env,
    }, () => readAdapterPrRollup(repo, normalizedPrNumber, { execFileImpl, env }));
    if (adapterResult && typeof adapterResult === 'object' && !Array.isArray(adapterResult)) {
      const mergeable = adapterResult.mergeable ?? null;
      const mergeStateStatus = adapterResult.mergeStateStatus ?? null;
      if (mergeable && mergeStateStatus) {
        return { mergeable, mergeStateStatus };
      }
    }
  } catch {
    // Optional adapter failures must not make mergeability sampling mandatory.
  }

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileImpl('gh', [
      'pr',
      'view',
      String(normalizedPrNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,mergeStateStatus',
    ], {
      maxBuffer: GH_MAX_BUFFER,
      env: buildGhEnv(env),
    });
    const parsed = JSON.parse(String(stdout || '{}'));
    recordApiCallImpl?.({
      category: 'pr_mergeability',
      repo,
      prNumber: normalizedPrNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return {
      mergeable: parsed?.mergeable ?? null,
      mergeStateStatus: parsed?.mergeStateStatus ?? null,
    };
  } catch (err) {
    recordApiCallImpl?.({
      category: 'pr_mergeability',
      repo,
      prNumber: normalizedPrNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

const __test__ = {
  buildGhEnv,
  extractChecksConnection,
  execGhJson,
  extractGraphqlPr,
  fetchGraphqlConnectionPages,
  fetchGraphqlReviewContext,
  fetchGraphqlRollupMultiplexed,
  fetchGraphqlRollupPerList,
  fetchLegacyChecks,
  fetchLegacyComments,
  fetchLegacyHeadAndState,
  fetchLegacyPr,
  fetchLegacyReviewContextWithTelemetry,
  fetchLegacyReviews,
  fetchPullRequestMergeability,
  fetchReviewBodiesForHead,
  normalizeAdapterHeadAndState,
  normalizeAdapterReviewContext,
  normalizeAdapterRollup,
  normalizeCheck,
  normalizeComment,
  normalizeCommitSubject,
  normalizePrNumber,
  normalizeReview,
  normalizeRollup,
  parseGhApiHttpEnvelope,
  runAdapterReadWithTelemetry,
  runGraphql,
  splitRepo,
  isGraphqlComplexityError,
  isGraphqlRollupDisabled,
  runGraphqlWithTelemetry,
};

export {
  __test__,
  fetchPullRequestCommitSubjects,
  fetchPullRequestHeadAndState,
  fetchPullRequestMergeability,
  fetchPullRequestReviewContext,
  fetchPullRequestRollup,
  fetchReviewBodiesForHead,
};
