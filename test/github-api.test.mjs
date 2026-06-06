import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const FIXTURE_REPO = 'laceyenterprises/adversarial-review';
const FIXTURE_PR = 1388;
const WATCHER_SUMMARY_MARKER = '@@GITHUB_API_WATCHER_SUMMARY@@';

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function importGithubApiFresh({ disableGraphqlRollup = false } = {}) {
  return withEnv({ GHO_DISABLE_GRAPHQL_ROLLUP: disableGraphqlRollup ? '1' : undefined }, async () => {
    const url = new URL(`../src/github-api.mjs?test=${Date.now()}-${Math.random()}`, import.meta.url);
    return import(url);
  });
}

function makeExpectedRollup() {
  return {
    id: 'PR_kwDOA1',
    number: FIXTURE_PR,
    title: '[codex] GHO-03: GraphQL roll-up for PR view + comments + checks + reviews',
    body: 'Links docs/SPEC-gho.md and README.md for context.',
    state: 'OPEN',
    mergedAt: null,
    closedAt: null,
    createdAt: '2026-06-06T08:00:00.000Z',
    updatedAt: '2026-06-06T08:30:00.000Z',
    headRefName: 'feature/graphql-rollup',
    baseRefName: 'main',
    headRefOid: 'abc123def456',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    author: { login: 'lacey' },
    labels: [{ name: 'automerge' }, { name: 'gho-03' }],
    comments: [
      {
        id: 'IC_kw1',
        author: { login: 'operator' },
        body: 'docs/SPEC-gho.md needs to stay authoritative.',
        createdAt: '2026-06-06T08:05:00.000Z',
      },
      {
        id: 'IC_kw2',
        author: { login: 'reviewer' },
        body: 'README.md also describes the current workflow.',
        createdAt: '2026-06-06T08:06:00.000Z',
      },
    ],
    reviews: [
      {
        id: 'PRR_kw1',
        author: { login: 'codex-reviewer-lacey' },
        body: 'Looks good with one note.',
        state: 'COMMENTED',
        submittedAt: '2026-06-06T08:20:00.000Z',
      },
      {
        id: 'PRR_kw2',
        author: { login: 'claude-reviewer-lacey' },
        body: 'Please keep the fallback path for one release.',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-06-06T08:25:00.000Z',
      },
    ],
    checks: [
      {
        name: 'ci / unit',
        conclusion: 'SUCCESS',
        completedAt: '2026-06-06T08:10:00.000Z',
      },
      {
        name: 'lint',
        conclusion: 'SUCCESS',
        completedAt: '2026-06-06T08:11:00.000Z',
      },
    ],
  };
}

function buildGraphqlResponse(expected, {
  comments = expected.comments,
  reviews = expected.reviews,
  checks = expected.checks,
  commentsHasNextPage = false,
  reviewsHasNextPage = false,
  checksHasNextPage = false,
  commentsEndCursor = commentsHasNextPage ? 'comments-cursor' : null,
  reviewsEndCursor = reviewsHasNextPage ? 'reviews-cursor' : null,
  checksEndCursor = checksHasNextPage ? 'checks-cursor' : null,
} = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: expected.id,
          number: expected.number,
          title: expected.title,
          body: expected.body,
          state: expected.state,
          mergedAt: expected.mergedAt,
          closedAt: expected.closedAt,
          createdAt: expected.createdAt,
          updatedAt: expected.updatedAt,
          headRefName: expected.headRefName,
          baseRefName: expected.baseRefName,
          headRefOid: expected.headRefOid,
          mergeable: expected.mergeable,
          mergeStateStatus: expected.mergeStateStatus,
          author: expected.author,
          labels: {
            nodes: expected.labels,
          },
          comments: {
            nodes: comments,
            pageInfo: {
              hasNextPage: commentsHasNextPage,
              endCursor: commentsEndCursor,
            },
          },
          reviews: {
            nodes: reviews,
            pageInfo: {
              hasNextPage: reviewsHasNextPage,
              endCursor: reviewsEndCursor,
            },
          },
          commits: {
            nodes: [{
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: checks.map((check) => ({
                      __typename: 'CheckRun',
                      name: check.name,
                      conclusion: check.conclusion,
                      completedAt: check.completedAt,
                      status: 'COMPLETED',
                    })),
                    pageInfo: {
                      hasNextPage: checksHasNextPage,
                      endCursor: checksEndCursor,
                    },
                  },
                },
              },
            }],
          },
        },
      },
    },
  };
}

function parseGhArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '-f' || arg === '-F') && typeof args[index + 1] === 'string') {
      const pair = args[index + 1];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        parsed[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      index += 1;
    }
  }
  return parsed;
}

function makeGraphqlExecStub(expected, { pagination = false } = {}) {
  const calls = [];
  const firstComments = pagination ? expected.comments.slice(0, 100) : expected.comments;
  const secondComments = pagination ? expected.comments.slice(100) : [];
  const firstReviews = pagination ? expected.reviews.slice(0, 100) : expected.reviews;
  const secondReviews = pagination ? expected.reviews.slice(100) : [];
  const firstChecks = pagination ? expected.checks.slice(0, 100) : expected.checks;
  const secondChecks = pagination ? expected.checks.slice(100) : [];

  async function execFileImpl(command, args) {
    calls.push({ command, args: [...args] });
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'graphql');
    const vars = parseGhArgs(args);
    if (!pagination || (!vars.commentsAfter && !vars.reviewsAfter && !vars.checksAfter)) {
      return {
        stdout: JSON.stringify(buildGraphqlResponse(expected, {
          comments: firstComments,
          reviews: firstReviews,
          checks: firstChecks,
          commentsHasNextPage: pagination,
          reviewsHasNextPage: pagination,
          checksHasNextPage: pagination,
          commentsEndCursor: pagination ? 'comments-100' : null,
          reviewsEndCursor: pagination ? 'reviews-100' : null,
          checksEndCursor: pagination ? 'checks-100' : null,
        })),
      };
    }
    assert.equal(vars.commentsAfter, 'comments-100');
    assert.equal(vars.reviewsAfter, 'reviews-100');
    assert.equal(vars.checksAfter, 'checks-100');
    return {
      stdout: JSON.stringify(buildGraphqlResponse(expected, {
        comments: secondComments,
        reviews: secondReviews,
        checks: secondChecks,
      })),
    };
  }

  return { calls, execFileImpl };
}

function makeLegacyExecStub(expected) {
  const calls = [];
  async function execFileImpl(command, args) {
    calls.push({ command, args: [...args] });
    assert.equal(command, 'gh');
    const joined = args.join(' ');
    if (joined.startsWith(`pr view ${FIXTURE_PR} --repo ${FIXTURE_REPO}`)) {
      const { comments, reviews, checks, ...pr } = expected;
      return { stdout: JSON.stringify(pr) };
    }
    if (joined.startsWith(`api repos/${FIXTURE_REPO}/issues/${FIXTURE_PR}/comments?`)) {
      return {
        stdout: JSON.stringify(expected.comments.map((comment) => ({
          id: comment.id,
          user: comment.author,
          body: comment.body,
          created_at: comment.createdAt,
        }))),
      };
    }
    if (joined.startsWith(`api repos/${FIXTURE_REPO}/pulls/${FIXTURE_PR}/reviews?`)) {
      return {
        stdout: JSON.stringify(expected.reviews.map((review) => ({
          id: review.id,
          user: review.author,
          body: review.body,
          state: review.state,
          submitted_at: review.submittedAt,
        }))),
      };
    }
    if (joined.startsWith(`api repos/${FIXTURE_REPO}/commits/${expected.headRefOid}/check-runs?`)) {
      return {
        stdout: JSON.stringify({
          check_runs: expected.checks.map((check) => ({
            name: check.name,
            conclusion: check.conclusion,
            completed_at: check.completedAt,
          })),
        }),
      };
    }
    if (joined === `api repos/${FIXTURE_REPO}/commits/${expected.headRefOid}/status`) {
      return { stdout: JSON.stringify({ statuses: [] }) };
    }
    throw new Error(`Unexpected gh invocation: ${joined}`);
  }
  return { calls, execFileImpl };
}

function makeTelemetrySink() {
  const events = [];
  return {
    events,
    recordApiCallImpl(entry) {
      events.push(entry);
    },
  };
}

function makeLargeExpectedRollup() {
  const base = makeExpectedRollup();
  return {
    ...base,
    comments: Array.from({ length: 150 }, (_, index) => ({
      id: `IC_${index + 1}`,
      author: { login: `commenter-${index + 1}` },
      body: `Comment ${index + 1}`,
      createdAt: `2026-06-06T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })),
    reviews: Array.from({ length: 145 }, (_, index) => ({
      id: `PRR_${index + 1}`,
      author: { login: `reviewer-${index + 1}` },
      body: `Review ${index + 1}`,
      state: index % 2 === 0 ? 'COMMENTED' : 'APPROVED',
      submittedAt: `2026-06-06T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })),
    checks: Array.from({ length: 135 }, (_, index) => ({
      name: `check-${index + 1}`,
      conclusion: 'SUCCESS',
      completedAt: `2026-06-06T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })),
  };
}

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

function buildWatcherLoaderSource(scenario) {
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');
  const stubs = {
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')]: 'fixture:routing',
    [fileUrl('src', 'role-config.mjs')]: 'fixture:role-config',
    [fileUrl('src', 'config-loader.mjs')]: 'fixture:config-loader',
    [fileUrl('src', 'adapters', 'operator', 'index.mjs')]: 'fixture:operator-surface',
    [fileUrl('src', 'adapters', 'reviewer-runtime', 'index.mjs')]: 'fixture:reviewer-runtime',
    [fileUrl('src', 'branch-protection.mjs')]: 'fixture:branch-protection',
    [fileUrl('src', 'adversarial-gate-status.mjs')]: 'fixture:adversarial-gate-status',
    [fileUrl('src', 'adversarial-gate-context.mjs')]: 'fixture:adversarial-gate-context',
    [fileUrl('src', 'follow-up-jobs.mjs')]: 'fixture:follow-up-jobs',
    [fileUrl('src', 'follow-up-merge-agent.mjs')]: 'fixture:follow-up-merge-agent',
    [fileUrl('src', 'follow-up-retrigger-label.mjs')]: 'fixture:follow-up-retrigger-label',
    [fileUrl('src', 'follow-up-retrigger-review-label.mjs')]: 'fixture:follow-up-retrigger-review-label',
    [fileUrl('src', 'operator-retrigger-helpers.mjs')]: 'fixture:operator-retrigger-helpers',
    [fileUrl('src', 'reviewer-cascade.mjs')]: 'fixture:reviewer-cascade',
    [fileUrl('src', 'reviewer-fence.mjs')]: 'fixture:reviewer-fence',
    [fileUrl('src', 'reviewer-lease.mjs')]: 'fixture:reviewer-lease',
    [fileUrl('src', 'reviewer-pass-tokens.mjs')]: 'fixture:reviewer-pass-tokens',
    [fileUrl('src', 'reviewer-reattach.mjs')]: 'fixture:reviewer-reattach',
    [fileUrl('src', 'reviewer-timeout.mjs')]: 'fixture:reviewer-timeout',
    [fileUrl('src', 'routing-tier-readiness.mjs')]: 'fixture:routing-tier-readiness',
    [fileUrl('src', 'session-ledger-read-adapter.mjs')]: 'fixture:session-ledger-read-adapter',
    [fileUrl('src', 'stale-drift.mjs')]: 'fixture:stale-drift',
    [fileUrl('src', 'watcher-fail-loud.mjs')]: 'fixture:watcher-fail-loud',
    [fileUrl('src', 'watcher-reviewer-pool.mjs')]: 'fixture:watcher-reviewer-pool',
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
    [fileUrl('src', 'atomic-write.mjs')]: 'fixture:atomic-write',
    [fileUrl('src', 'github-api.mjs')]: 'fixture:github-api',
  };

  return `
const stubs = new Map(${JSON.stringify(Object.entries(stubs))});
const scenario = ${JSON.stringify(scenario)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@octokit/rest') {
    return { url: 'fixture:octokit-rest', shortCircuit: true };
  }
  if (context.parentURL?.startsWith('fixture:') && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
    return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(packageParentUrl)} });
  }
  const resolved = await nextResolve(specifier, context);
  const stubUrl = stubs.get(resolved.url);
  if (stubUrl) return { url: stubUrl, shortCircuit: true };
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'fixture:review-state') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        let db = null;
        function makeDb() {
          const rows = [];
          function findRow(repo, prNumber) {
            return rows.find((row) => row.repo === repo && row.pr_number === prNumber) || null;
          }
          return {
            seedRow(row) {
              rows.push({
                repo: row.repo,
                pr_number: row.pr_number,
                reviewed_at: row.reviewed_at || null,
                reviewer: row.reviewer || null,
                pr_state: row.pr_state || 'open',
                review_status: row.review_status || 'posted',
                review_attempts: row.review_attempts || 0,
                labels_json: row.labels_json || '[]',
                merged_at: row.merged_at || null,
                closed_at: row.closed_at || null,
              });
            },
            prepare(sql) {
              const normalized = String(sql || '').replace(/\\s+/g, ' ').trim();
              if (normalized.includes("FROM reviewed_prs") && normalized.includes("pr_state = 'open'")) {
                return { all: () => rows.filter((row) => row.pr_state === 'open').map((row) => ({ ...row })) };
              }
              if (normalized.startsWith("UPDATE reviewed_prs SET pr_state = 'merged'")) {
                return {
                  run: (mergedAt, repo, prNumber) => {
                    const row = findRow(repo, prNumber);
                    if (!row) return { changes: 0 };
                    row.pr_state = 'merged';
                    row.merged_at = mergedAt;
                    return { changes: 1 };
                  },
                };
              }
              if (normalized.startsWith("UPDATE reviewed_prs SET pr_state = 'closed'")) {
                return {
                  run: (closedAt, repo, prNumber) => {
                    const row = findRow(repo, prNumber);
                    if (!row) return { changes: 0 };
                    row.pr_state = 'closed';
                    row.closed_at = closedAt;
                    return { changes: 1 };
                  },
                };
              }
              if (normalized.startsWith('SELECT repo, pr_number, pr_state, merged_at, closed_at FROM reviewed_prs')) {
                return {
                  all: () => rows.map((row) => ({
                    repo: row.repo,
                    pr_number: row.pr_number,
                    pr_state: row.pr_state,
                    merged_at: row.merged_at,
                    closed_at: row.closed_at,
                  })),
                };
              }
              return {
                all: () => [],
                get: () => null,
                run: () => ({ changes: 0 }),
              };
            },
            exec() {},
            pragma() { return null; },
            transaction(fn) { return (...args) => fn(...args); },
            close() {},
          };
        }
        export function openReviewStateDb() {
          if (!db) {
            db = makeDb();
            globalThis.__githubApiWatcherDb = db;
          }
          return db;
        }
        export function ensureReviewStateSchema() {}
        export function listPendingMergeCloseouts() { return []; }
        export function readLatestCompletedReviewerPassEndedAt() { return null; }
        export function readReviewerPassLogins() { return []; }
        export function recordMergeCloseout() { return { changes: 0 }; }
        export function recordMergeCloseoutScrapeFailure() { return { changes: 0 }; }
        export function requestReviewRereview() { return { changes: 0 }; }
      `)}
    };
  }

  if (url === 'fixture:subject-adapter') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        export function parseSubjectExternalId(subjectExternalId) {
          const match = String(subjectExternalId || '').match(/^([^#/]+\\/[^#/]+)#(\\d+)$/);
          if (!match) throw new TypeError('Invalid GitHub PR subjectExternalId: ' + subjectExternalId);
          return { repo: match[1], prNumber: Number(match[2]) };
        }
        export function createGitHubPRSubjectAdapter() {
          return {
            async discoverSubjects() {
              return [];
            },
            async fetchState() {
              throw new Error('fetchState should not be called in this watcher fixture');
            },
          };
        }
      `)}
    };
  }

  const simpleStubs = {
    'fixture:routing': "export function routeSubject() { return null; } export function defaultReviewerRouteFromEnv() { return null; } export function describeCrossModelReviewWaiver() { return null; } export function isCrossModelReviewWaived() { return false; }",
    'fixture:role-config': "export function resetRoleConfigCache() {}",
    'fixture:config-loader': "export function loadConfigCached() { return {}; }",
    'fixture:octokit-rest': "export class Octokit {}",
    'fixture:operator-surface': "globalThis.__githubApiWatcherTriage = []; export function createCompositeOperatorSurface() { return { extractLinearTicketId() { return null; }, syncTriageStatus: async (subjectRef, state) => { globalThis.__githubApiWatcherTriage.push({ subjectRef, state }); }, observeOperatorApproved: async () => null, observeLabelControl: async () => null }; }",
    'fixture:reviewer-runtime': "export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async () => ({ ok: true }), cancel: async () => {} }; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function deleteGateRecordsForPR() {} export async function projectAdversarialGateStatus() { return { decision: { state: 'pending', reason: 'fixture' } }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; } export function isActiveFollowUpJobStatus() { return false; }",
    'fixture:follow-up-merge-agent': "export const MERGE_AGENT_DISPATCHED_LABEL = 'merge-agent-dispatched'; export const MERGE_AGENT_REQUESTED_LABEL = 'merge-agent-requested'; export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export async function addMergeAgentDispatchedLabel() { return { added: false }; } export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export function resolveFastMergePerPollCap() { return 5; } export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export function scanStuckMergeAgentDispatches() { return []; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {}",
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:follow-up-retrigger-review-label': "export const RETRIGGER_REVIEW_LABEL = 'retrigger-review'; export async function retryPendingRetriggerReviewAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerReviewFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 3; export function clearCascadeState() {} export function formatTransientFailureBreakdown() { return ''; } export function readCascadeState() { return null; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; }",
    'fixture:reviewer-fence': "export function appendFenceAuditEvent() {} export function classifyFenceOrphan() { return null; } export function deleteCleanupJob() {} export function deleteSpawnRecord() {} export function inspectWatcherExitTimeout() { return null; } export function isFenceStale() { return false; } export function listCleanupJobs() { return []; } export function listFenceJsonPaths() { return []; } export function listFenceLockPaths() { return []; } export function loadSpawnRecords() { return []; } export function moveFenceArtifactToQuarantine() {} export function probeFenceLock() { return null; } export function queueFenceCleanupJob() {} export function readFenceRecord() { return null; } export function resolveAdversarialReviewStateDir() { return '/tmp/adversarial-review-state'; } export function resolveFencePaths() { return {}; } export function resolveSigtermFenceGraceSeconds() { return 60; } export function syncSpawnRecords() {} export function upsertSpawnRecord() {} export function validateFenceConfig() {}",
    'fixture:reviewer-lease': "export function computeReviewerLeaseExpiryAt() { return null; } export function isReviewerLeaseExpired() { return false; } export function resolveReviewerLeaseRecoveryEnabled() { return false; }",
    'fixture:reviewer-pass-tokens': "export function beginReviewerPass() { return { ok: true }; } export function completeReviewerPass() { return { ok: true }; } export function readBestReviewerEvidenceTokenUsage() { return null; }",
    'fixture:reviewer-reattach': "export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; }",
    'fixture:routing-tier-readiness': "export function createRoutingTierReadinessProbeCache() { return { get: () => null, set: () => {} }; } export async function probeRoutingTierReadiness() { return { ready: true }; }",
    'fixture:session-ledger-read-adapter': "export function readLatestWorkerRunStatusFromLedger() { return null; } export function resolveSessionLedgerReadTarget() { return null; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed title'); }",
    'fixture:watcher-reviewer-pool': "export function compareReviewerDispatchCandidates() { return 0; } export function createReviewerMemoryAdmissionSampler() { return { sample: async () => ({ admit: true }) }; } export function reserveReviewerMemoryAdmission() { return () => {}; } export function resolveFirstPassReviewerPoolConfig() { return { enabled: false }; } export async function runBoundedReviewerDispatchQueue() { return { dispatched: 0, skipped: 0 }; } export function sortReviewerDispatchCandidates(items) { return items; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
    'fixture:atomic-write': "export function writeFileAtomic() {}",
    'fixture:github-api': "const scenario = globalThis.__githubApiWatcherScenario; export async function fetchPullRequestRollup() { return { ...scenario.rollup, labels: [...scenario.rollup.labels] }; }",
  };

  if (Object.prototype.hasOwnProperty.call(simpleStubs, url)) {
    return { format: 'module', shortCircuit: true, source: simpleStubs[url] };
  }

  return nextLoad(url, context);
}
`;
}

function buildWatcherRegisterSource(loaderPath) {
  return `
import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
`;
}

function buildWatcherRunnerSource() {
  return `
globalThis.__githubApiWatcherScenario = JSON.parse(process.env.GITHUB_API_WATCHER_SCENARIO || '{}');
const { pollOnce } = await import(${JSON.stringify(fileUrl('src', 'watcher.mjs'))});
const db = globalThis.__githubApiWatcherDb;
db.seedRow({
  repo: ${JSON.stringify(FIXTURE_REPO)},
  pr_number: ${FIXTURE_PR},
  reviewed_at: '2026-06-06T08:01:00.000Z',
  reviewer: 'claude',
  pr_state: 'open',
  review_status: 'posted',
  labels_json: JSON.stringify(['automerge']),
});
const octokit = {
  paginate: async () => [],
  rest: {
    repos: { listForOrg: async () => ({ data: [] }) },
    pulls: { list: async () => ({ data: [] }) },
    issues: {},
  },
};
await pollOnce(octokit, {
  healthProbe: {
    beginTick() { return {}; },
    recordOpenPending() {},
    recordSpawn() {},
    async finishTick() {},
  },
});
const rows = db.prepare('SELECT repo, pr_number, pr_state, merged_at, closed_at FROM reviewed_prs ORDER BY pr_number').all();
console.log(${JSON.stringify(WATCHER_SUMMARY_MARKER)} + JSON.stringify({
  rows,
  triage: globalThis.__githubApiWatcherTriage || [],
}));
`;
}

function runWatcherScenario(rollup) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'github-api-watcher-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildWatcherLoaderSource({ rollup }), 'utf8');
    writeFileSync(registerPath, buildWatcherRegisterSource(loaderPath), 'utf8');
    writeFileSync(runnerPath, buildWatcherRunnerSource(), 'utf8');
    const result = spawnSync(process.execPath, ['--import', registerPath, runnerPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GITHUB_API_WATCHER_SCENARIO: JSON.stringify({ rollup }),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summaryLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith(WATCHER_SUMMARY_MARKER));
    assert.ok(summaryLine, `missing watcher summary marker in output:\n${result.stdout}`);
    return JSON.parse(summaryLine.slice(WATCHER_SUMMARY_MARKER.length));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('GraphQL response shape matches the REST union contract', async () => {
  const expected = makeExpectedRollup();
  const { fetchPullRequestRollup } = await importGithubApiFresh();
  const telemetry = makeTelemetrySink();
  const { execFileImpl } = makeGraphqlExecStub(expected);

  const result = await fetchPullRequestRollup(FIXTURE_REPO, FIXTURE_PR, {
    execFileImpl,
    recordApiCallImpl: telemetry.recordApiCallImpl,
  });

  assert.deepEqual(result, expected);
  assert.equal(typeof result.id, 'string');
  assert.equal(typeof result.number, 'number');
  assert.equal(Array.isArray(result.labels), true);
  assert.equal(Array.isArray(result.comments), true);
  assert.equal(Array.isArray(result.reviews), true);
  assert.equal(Array.isArray(result.checks), true);
  assert.deepEqual(telemetry.events.map((entry) => entry.category), ['graphql_pr_rollup']);
});

test('feature flag fallback runs the legacy cluster path and preserves shape', async () => {
  const expected = makeExpectedRollup();
  const graphqlMod = await importGithubApiFresh();
  const graphqlTelemetry = makeTelemetrySink();
  const graphqlExec = makeGraphqlExecStub(expected);
  const graphqlResult = await graphqlMod.fetchPullRequestRollup(FIXTURE_REPO, FIXTURE_PR, {
    execFileImpl: graphqlExec.execFileImpl,
    recordApiCallImpl: graphqlTelemetry.recordApiCallImpl,
  });

  const legacyMod = await importGithubApiFresh({ disableGraphqlRollup: true });
  const legacyTelemetry = makeTelemetrySink();
  const legacyExec = makeLegacyExecStub(expected);
  const legacyResult = await legacyMod.fetchPullRequestRollup(FIXTURE_REPO, FIXTURE_PR, {
    execFileImpl: legacyExec.execFileImpl,
    recordApiCallImpl: legacyTelemetry.recordApiCallImpl,
  });

  assert.deepEqual(legacyResult, graphqlResult);
  assert.deepEqual(
    legacyTelemetry.events.map((entry) => entry.category),
    ['pr_view', 'comments_list', 'reviews_list', 'checks_list'],
  );
  assert.deepEqual(
    graphqlTelemetry.events.map((entry) => entry.category),
    ['graphql_pr_rollup'],
  );
});

test('pagination cursor handling returns all comments, reviews, and checks without truncation', async () => {
  const expected = makeLargeExpectedRollup();
  const { fetchPullRequestRollup } = await importGithubApiFresh();
  const { calls, execFileImpl } = makeGraphqlExecStub(expected, { pagination: true });

  const result = await fetchPullRequestRollup(FIXTURE_REPO, FIXTURE_PR, {
    execFileImpl,
    recordApiCallImpl: () => {},
  });

  assert.equal(result.comments.length, 150);
  assert.equal(result.reviews.length, 145);
  assert.equal(result.checks.length, 135);
  assert.equal(calls.length, 2);
});

test('watcher tick downstream output is unchanged when PR fetches come from the roll-up helper', () => {
  const rollup = {
    ...makeExpectedRollup(),
    state: 'OPEN',
    mergedAt: '2026-06-06T08:45:00.000Z',
    labels: [{ name: 'automerge' }],
  };
  const summary = runWatcherScenario(rollup);

  assert.deepEqual(summary.rows, [{
    repo: FIXTURE_REPO,
    pr_number: FIXTURE_PR,
    pr_state: 'merged',
    merged_at: '2026-06-06T08:45:00.000Z',
    closed_at: null,
  }]);
  assert.deepEqual(summary.triage, [{
    subjectRef: {
      domainId: 'code-pr',
      subjectExternalId: `${FIXTURE_REPO}#${FIXTURE_PR}`,
      revisionRef: rollup.headRefOid,
      labels: ['automerge'],
    },
    state: 'finalized',
  }]);
});
