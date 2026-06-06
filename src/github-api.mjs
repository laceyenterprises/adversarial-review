import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';

const execFileAsync = promisify(execFile);
const GRAPHQL_ROLLUP_DISABLED = process.env.GHO_DISABLE_GRAPHQL_ROLLUP === '1';
const PAGE_SIZE = 100;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const GRAPHQL_COMPLEXITY_PATTERN = /\b(complexity|cost limit|maximum cost|resource limit)\b/i;

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
  $prNumber: Int!
  $checksFirst: Int!
  $checksAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
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

function normalizeLabels(labelsConnection) {
  const source = Array.isArray(labelsConnection)
    ? labelsConnection
    : (labelsConnection?.nodes || []);
  return source
    .map((label) => String(label?.name || '').trim())
    .filter(Boolean)
    .map((name) => ({ name }));
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
  comments = [],
  reviews = [],
  checks = [],
} = {}) {
  // GraphQL exposes merged PRs as a distinct `merged` state; callers that
  // care about merged-vs-closed should treat `state` as tri-state.
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
    labels: normalizeLabels(pr?.labels),
    comments,
    reviews,
    checks,
  };
}

async function execGhJson(execFileImpl, args) {
  const { stdout } = await execFileImpl('gh', args, { maxBuffer: GH_MAX_BUFFER });
  return JSON.parse(String(stdout || 'null'));
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
    const data = await execGhJson(execFileImpl, ['api', `${basePath}${basePath.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`]);
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
    const data = await execGhJson(execFileImpl, ['api', `repos/${repo}/commits/${headRefOid}/status`]);
    statuses = (Array.isArray(data?.statuses) ? data.statuses : []).map((status) => ({
      name: String(status?.context || '').trim() || null,
      conclusion: status?.state || null,
      completedAt: status?.updated_at || status?.created_at || null,
    }));
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

function extractChecksConnection(pr) {
  return pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts || null;
}

function appendGraphqlPage(target, nodes, normalize) {
  for (const node of nodes || []) {
    const normalized = normalize(node);
    if (normalized) target.push(normalized);
  }
}

async function fetchGraphqlRollupMultiplexed(repo, prNumber, {
  execFileImpl,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const comments = [];
  const reviews = [];
  const checks = [];
  let prData = null;
  let commentsAfter = null;
  let reviewsAfter = null;
  let checksAfter = null;
  let commentsFirst = PAGE_SIZE;
  let reviewsFirst = PAGE_SIZE;
  let checksFirst = PAGE_SIZE;
  let hasNextComments = true;
  let hasNextReviews = true;
  let hasNextChecks = true;
  let isFirstIteration = true;

  while (hasNextComments || hasNextReviews || hasNextChecks) {
    const payload = await runGraphql(execFileImpl, GRAPHQL_ROLLUP_QUERY, {
      owner,
      repo: repoName,
      prNumber,
      commentsFirst,
      commentsAfter,
      reviewsFirst,
      reviewsAfter,
      checksFirst,
      checksAfter,
    });
    const pr = extractGraphqlPr(payload);
    if (!prData) prData = pr;

    if (isFirstIteration || hasNextComments) {
      appendGraphqlPage(comments, pr?.comments?.nodes, normalizeComment);
    }
    if (isFirstIteration || hasNextReviews) {
      appendGraphqlPage(reviews, pr?.reviews?.nodes, normalizeReview);
    }
    if (isFirstIteration || hasNextChecks) {
      appendGraphqlPage(checks, extractChecksConnection(pr)?.nodes, normalizeCheck);
    }

    hasNextComments = Boolean(pr?.comments?.pageInfo?.hasNextPage);
    hasNextReviews = Boolean(pr?.reviews?.pageInfo?.hasNextPage);
    hasNextChecks = Boolean(extractChecksConnection(pr)?.pageInfo?.hasNextPage);
    commentsAfter = hasNextComments ? pr?.comments?.pageInfo?.endCursor || null : null;
    reviewsAfter = hasNextReviews ? pr?.reviews?.pageInfo?.endCursor || null : null;
    checksAfter = hasNextChecks ? extractChecksConnection(pr)?.pageInfo?.endCursor || null : null;
    commentsFirst = hasNextComments ? PAGE_SIZE : null;
    reviewsFirst = hasNextReviews ? PAGE_SIZE : null;
    checksFirst = hasNextChecks ? PAGE_SIZE : null;
    isFirstIteration = false;
    if (!hasNextComments && !hasNextReviews && !hasNextChecks) break;
  }

  return normalizeRollup(prData, { comments, reviews, checks });
}

async function fetchGraphqlConnectionPages(repo, prNumber, {
  execFileImpl,
  query,
  firstVariable,
  afterVariable,
  startAfter = null,
  extractConnection,
  normalize,
} = {}) {
  const { owner, repo: repoName } = splitRepo(repo);
  const items = [];
  let after = startAfter;
  let hasNextPage = true;
  while (hasNextPage) {
    const payload = await runGraphql(execFileImpl, query, {
      owner,
      repo: repoName,
      prNumber,
      [firstVariable]: PAGE_SIZE,
      [afterVariable]: after,
    });
    const pr = extractGraphqlPr(payload);
    const connection = extractConnection(pr);
    appendGraphqlPage(items, connection?.nodes, normalize);
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = hasNextPage ? connection?.pageInfo?.endCursor || null : after;
  }
  return items;
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
  const comments = await fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_COMMENTS_ONLY_QUERY,
    firstVariable: 'commentsFirst',
    afterVariable: 'commentsAfter',
    extractConnection: (value) => value?.comments,
    normalize: normalizeComment,
  });
  const reviews = await fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_REVIEWS_ONLY_QUERY,
    firstVariable: 'reviewsFirst',
    afterVariable: 'reviewsAfter',
    extractConnection: (value) => value?.reviews,
    normalize: normalizeReview,
  });
  const checks = await fetchGraphqlConnectionPages(repo, prNumber, {
    execFileImpl,
    query: GRAPHQL_CHECKS_ONLY_QUERY,
    firstVariable: 'checksFirst',
    afterVariable: 'checksAfter',
    extractConnection: extractChecksConnection,
    normalize: normalizeCheck,
  });

  return normalizeRollup(pr, { comments, reviews, checks });
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
  if (GRAPHQL_ROLLUP_DISABLED) {
    return fetchLegacyWithTelemetry(repo, prNumber, { execFileImpl, recordApiCallImpl });
  }

  const startedAt = Date.now();
  try {
    let result;
    try {
      result = await fetchGraphqlRollupMultiplexed(repo, prNumber, { execFileImpl });
    } catch (err) {
      if (!GRAPHQL_COMPLEXITY_PATTERN.test(String(err?.message || ''))) throw err;
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
  extractChecksConnection,
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
  GRAPHQL_ROLLUP_DISABLED,
};

export {
  __test__,
  fetchPullRequestHeadAndState,
  fetchPullRequestRollup,
};
