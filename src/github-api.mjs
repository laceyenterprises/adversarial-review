import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';

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
    }
  }
}
`;

function splitRepo(repo) {
  const match = /^([^/]+)\/([^/]+)$/.exec(String(repo || '').trim());
  if (!match) {
    throw new TypeError(`Invalid GitHub repo slug: ${repo}`);
  }
  return { owner: match[1], repo: match[2] };
}

function normalizeAuthor(author) {
  const login = String(author?.login || '').trim();
  return login ? { login } : null;
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
  };
}

function buildGhEnv(env = process.env) {
  const ghEnv = { ...env };
  if (!ghEnv.GH_TOKEN && ghEnv.GITHUB_TOKEN) {
    ghEnv.GH_TOKEN = ghEnv.GITHUB_TOKEN;
  }
  return ghEnv;
}

async function execGhJson(execFileImpl, args) {
  try {
    const { stdout } = await execFileImpl('gh', args, {
      maxBuffer: GH_MAX_BUFFER,
      env: buildGhEnv(),
    });
    return JSON.parse(String(stdout || 'null'));
  } catch (err) {
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

async function fetchLegacyPr(execFileImpl, repo, prNumber) {
  return execGhJson(execFileImpl, [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'id,number,title,body,state,mergedAt,closedAt,createdAt,updatedAt,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,author,labels',
  ]);
}

async function fetchLegacyComments(execFileImpl, repo, prNumber) {
  return paginateRest(
    execFileImpl,
    `repos/${repo}/issues/${prNumber}/comments`,
    (data) => (Array.isArray(data) ? data : []).map((comment) => ({
      id: comment?.id == null ? null : String(comment.id),
      author: normalizeAuthor(comment?.user),
      body: String(comment?.body || ''),
      createdAt: comment?.created_at || null,
    })),
  );
}

async function fetchLegacyReviews(execFileImpl, repo, prNumber) {
  return paginateRest(
    execFileImpl,
    `repos/${repo}/pulls/${prNumber}/reviews`,
    (data) => (Array.isArray(data) ? data : []).map((review) => ({
      id: review?.id == null ? null : String(review.id),
      author: normalizeAuthor(review?.user),
      body: String(review?.body || ''),
      state: review?.state || null,
      submittedAt: review?.submitted_at || null,
    })),
  );
}

async function fetchLegacyChecks(execFileImpl, repo, headRefOid) {
  if (!headRefOid) return [];
  const checkRuns = await paginateRest(
    execFileImpl,
    `repos/${repo}/commits/${headRefOid}/check-runs`,
    (data) => (Array.isArray(data?.check_runs) ? data.check_runs : []).map((checkRun) => ({
      name: String(checkRun?.name || '').trim() || null,
      conclusion: checkRun?.conclusion || checkRun?.status || null,
      completedAt: checkRun?.completed_at || null,
    })),
  );
  let statuses = [];
  try {
    statuses = await paginateRest(
      execFileImpl,
      `repos/${repo}/commits/${headRefOid}/statuses`,
      (data) => (Array.isArray(data) ? data : []).map((status) => ({
        name: String(status?.context || '').trim() || null,
        conclusion: status?.state || null,
        completedAt: status?.updated_at || status?.created_at || null,
      })),
    );
  } catch {
    statuses = [];
  }
  return [...checkRuns, ...statuses];
}

async function fetchLegacyWithTelemetry(repo, prNumber, {
  execFileImpl,
  recordApiCallImpl,
} = {}) {
  async function withLegacyTelemetry(category, action) {
    const startedAt = Date.now();
    try {
      const result = await action();
      recordApiCallImpl({
        category,
        repo,
        prNumber,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      recordApiCallImpl({
        category,
        repo,
        prNumber,
        status: apiStatusFromError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const pr = await withLegacyTelemetry('pr_view', () => fetchLegacyPr(execFileImpl, repo, prNumber));
  const comments = await withLegacyTelemetry('comments_list', () => fetchLegacyComments(execFileImpl, repo, prNumber));
  const reviews = await withLegacyTelemetry('reviews_list', () => fetchLegacyReviews(execFileImpl, repo, prNumber));
  const checks = await withLegacyTelemetry('checks_list', () => fetchLegacyChecks(execFileImpl, repo, pr?.headRefOid || null));

  return normalizeRollup(pr, { comments, reviews, checks });
}

function extractGraphqlPr(payload) {
  const pr = payload?.data?.repository?.pullRequest || payload?.repository?.pullRequest || null;
  if (!pr) {
    throw new Error('GitHub GraphQL pullRequest payload missing');
  }
  return pr;
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
  return GRAPHQL_COMPLEXITY_PATTERN.test(message);
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
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const items = [];
  let after = startAfter;
  let hasNextPage = true;
  let page = 0;
  while (hasNextPage) {
    page += 1;
    if (page > MAX_GRAPHQL_CONNECTION_PAGES) {
      throw new Error(`GraphQL ${connectionName} pagination exceeded ${MAX_GRAPHQL_CONNECTION_PAGES} pages`);
    }
    const payload = await runGraphql(execFileImpl, query, {
      owner,
      repo: repoName,
      prNumber,
      ...extraVariables,
      [firstVariable]: PAGE_SIZE,
      [afterVariable]: after,
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
  });
}

async function fetchGraphqlCheckPages(repo, prNumber, headRefOid, {
  execFileImpl,
  startAfter = null,
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
  });
}

async function fetchGraphqlRollupMultiplexed(repo, prNumber, {
  execFileImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const comments = [];
  const reviews = [];
  const checks = [];
  const payload = await runGraphql(execFileImpl, GRAPHQL_ROLLUP_QUERY, {
    owner,
    repo: repoName,
    prNumber,
    commentsFirst: PAGE_SIZE,
    commentsAfter: null,
    reviewsFirst: PAGE_SIZE,
    reviewsAfter: null,
    checksFirst: PAGE_SIZE,
    checksAfter: null,
  });
  const pr = extractGraphqlPr(payload);
  const labels = normalizeLabels(pr?.labels);

  appendGraphqlPage(comments, pr?.comments?.nodes, normalizeComment);
  appendGraphqlPage(reviews, pr?.reviews?.nodes, normalizeReview);
  appendGraphqlPage(checks, extractChecksConnection(pr)?.nodes, normalizeCheck);

  if (pr?.labels?.pageInfo?.hasNextPage) {
    labels.push(...await fetchGraphqlLabelPages(repo, prNumber, {
      execFileImpl,
      startAfter: pr?.labels?.pageInfo?.endCursor || null,
    }));
  }
  if (pr?.comments?.pageInfo?.hasNextPage) {
    comments.push(...await fetchGraphqlConnectionPages(repo, prNumber, {
      execFileImpl,
      query: GRAPHQL_COMMENTS_ONLY_QUERY,
      firstVariable: 'commentsFirst',
      afterVariable: 'commentsAfter',
      startAfter: pr?.comments?.pageInfo?.endCursor || null,
      extractConnection: (value) => value?.comments,
      normalize: normalizeComment,
      connectionName: 'comments',
    }));
  }
  if (pr?.reviews?.pageInfo?.hasNextPage) {
    reviews.push(...await fetchGraphqlConnectionPages(repo, prNumber, {
      execFileImpl,
      query: GRAPHQL_REVIEWS_ONLY_QUERY,
      firstVariable: 'reviewsFirst',
      afterVariable: 'reviewsAfter',
      startAfter: pr?.reviews?.pageInfo?.endCursor || null,
      extractConnection: (value) => value?.reviews,
      normalize: normalizeReview,
      connectionName: 'reviews',
    }));
  }
  if (extractChecksConnection(pr)?.pageInfo?.hasNextPage) {
    checks.push(...await fetchGraphqlCheckPages(repo, prNumber, pr?.headRefOid || null, {
      execFileImpl,
      startAfter: extractChecksConnection(pr)?.pageInfo?.endCursor || null,
    }));
  }

  return normalizeRollup(pr, { labels, comments, reviews, checks });
}

async function fetchGraphqlRollupPerList(repo, prNumber, {
  execFileImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const initial = await runGraphql(execFileImpl, GRAPHQL_PR_METADATA_QUERY, {
    owner,
    repo: repoName,
    prNumber,
  });
  const pr = extractGraphqlPr(initial);
  const labels = normalizeLabels(pr?.labels);
  if (pr?.labels?.pageInfo?.hasNextPage) {
    labels.push(...await fetchGraphqlLabelPages(repo, prNumber, {
      execFileImpl,
      startAfter: pr?.labels?.pageInfo?.endCursor || null,
    }));
  }
  const comments = await fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_COMMENTS_ONLY_QUERY,
    firstVariable: 'commentsFirst',
    afterVariable: 'commentsAfter',
    extractConnection: (value) => value?.comments,
    normalize: normalizeComment,
    connectionName: 'comments',
  });
  const reviews = await fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_REVIEWS_ONLY_QUERY,
    firstVariable: 'reviewsFirst',
    afterVariable: 'reviewsAfter',
    extractConnection: (value) => value?.reviews,
    normalize: normalizeReview,
    connectionName: 'reviews',
  });
  const checks = await fetchGraphqlCheckPages(repo, prNumber, pr?.headRefOid || null, {
    execFileImpl,
  });

  return normalizeRollup(pr, { labels, comments, reviews, checks });
}

async function fetchPullRequestHeadAndState(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const startedAt = Date.now();
  try {
    const payload = await runGraphql(execFileImpl, GRAPHQL_PR_HEAD_STATE_QUERY, {
      owner,
      repo: repoName,
      prNumber,
    });
    const pr = extractGraphqlPr(payload);
    const result = {
      state: typeof pr?.state === 'string' ? pr.state.toLowerCase() : pr?.state || null,
      mergedAt: pr?.mergedAt || null,
      closedAt: pr?.closedAt || null,
      headRefOid: pr?.headRefOid || null,
    };
    recordApiCallImpl({
      category: 'pr_head_state',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    recordApiCallImpl({
      category: 'pr_head_state',
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function fetchPullRequestRollup(repo, prNumber, {
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
} = {}) {
  if (isGraphqlRollupDisabled()) {
    return fetchLegacyWithTelemetry(repo, prNumber, { execFileImpl, recordApiCallImpl });
  }

  const startedAt = Date.now();
  try {
    let result;
    try {
      result = await fetchGraphqlRollupMultiplexed(repo, prNumber, { execFileImpl });
    } catch (err) {
      if (!isGraphqlComplexityError(err)) throw err;
      result = await fetchGraphqlRollupPerList(repo, prNumber, { execFileImpl });
    }
    recordApiCallImpl({
      category: 'graphql_pr_rollup',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    recordApiCallImpl({
      category: 'graphql_pr_rollup',
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

const __test__ = {
  buildGhEnv,
  extractChecksConnection,
  fetchGraphqlConnectionPages,
  fetchGraphqlRollupMultiplexed,
  fetchGraphqlRollupPerList,
  fetchLegacyChecks,
  fetchLegacyComments,
  fetchLegacyPr,
  fetchLegacyReviews,
  normalizeCheck,
  normalizeComment,
  normalizeReview,
  normalizeRollup,
  runGraphql,
  splitRepo,
  isGraphqlComplexityError,
  isGraphqlRollupDisabled,
};

export {
  __test__,
  fetchPullRequestHeadAndState,
  fetchPullRequestRollup,
};
