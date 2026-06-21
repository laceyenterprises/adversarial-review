import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SUMMARY_MARKER = '@@WATCHER_CLAIM_LOOP_SUMMARY@@';

function fixtureEnv(overrides = {}) {
  return {
    ...process.env,
    GITHUB_TOKEN: 'fixture-token',
    WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '1',
    ...overrides,
  };
}

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

function buildLoaderSource({
  reviewerRuntimeSource = "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
  followUpMergeAgentSource = "export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export async function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export function resolveFastMergePerPollCap() { return 5; } export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export function scanStuckMergeAgentDispatches() { return []; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {} export function isScopedMergeAgentRequest() { return false; }",
} = {}) {
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const reviewStateActualUrl = `${reviewStateUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');

  const stubs = {
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [fileUrl('src', 'adapters', 'operator', 'index.mjs')]: 'fixture:operator-surface',
    [fileUrl('src', 'adapters', 'reviewer-runtime', 'index.mjs')]: 'fixture:reviewer-runtime',
    [fileUrl('src', 'branch-protection.mjs')]: 'fixture:branch-protection',
    [fileUrl('src', 'adversarial-gate-status.mjs')]: 'fixture:adversarial-gate-status',
    [fileUrl('src', 'adversarial-gate-context.mjs')]: 'fixture:adversarial-gate-context',
    [fileUrl('src', 'follow-up-jobs.mjs')]: 'fixture:follow-up-jobs',
    [fileUrl('src', 'follow-up-merge-agent.mjs')]: 'fixture:follow-up-merge-agent',
    [fileUrl('src', 'follow-up-retrigger-label.mjs')]: 'fixture:follow-up-retrigger-label',
    [fileUrl('src', 'operator-retrigger-helpers.mjs')]: 'fixture:operator-retrigger-helpers',
    [fileUrl('src', 'reviewer-cascade.mjs')]: 'fixture:reviewer-cascade',
    [fileUrl('src', 'reviewer-reattach.mjs')]: 'fixture:reviewer-reattach',
    [fileUrl('src', 'reviewer-timeout.mjs')]: 'fixture:reviewer-timeout',
    [fileUrl('src', 'reviewer-broker-refresh.mjs')]: 'fixture:reviewer-broker-refresh',
    [fileUrl('src', 'stale-drift.mjs')]: 'fixture:stale-drift',
    [fileUrl('src', 'watcher-fail-loud.mjs')]: 'fixture:watcher-fail-loud',
    [fileUrl('src', 'watcher-memory-pressure.mjs')]: 'fixture:watcher-memory-pressure',
    [fileUrl('src', 'github-api.mjs')]: 'fixture:github-api',
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
  };

  return `
const stubs = new Map(${JSON.stringify(Object.entries(stubs))});

export async function resolve(specifier, context, nextResolve) {
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
        import * as actual from ${JSON.stringify(reviewStateActualUrl)};
        import Database from 'better-sqlite3';
        let db = null;
        export * from ${JSON.stringify(reviewStateActualUrl)};
        export const ensureReviewStateSchema = actual.ensureReviewStateSchema;
        export function openReviewStateDb() {
          if (!db) {
            db = new Database(':memory:');
            actual.ensureReviewStateSchema(db);
            globalThis.__watcherClaimLoopDb = db;
          }
          return db;
        }
      `)}
    };
  }

  if (url === 'fixture:subject-adapter') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        const REPO = 'laceyenterprises/adversarial-review';
        const subjects = [
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#101', revisionRef: 'sha-happy-101' },
            lifecycle: 'pending-review',
            title: '[codex] LAC-636 happy path runtime claim',
            authorRef: 'codex-worker',
            builderClass: 'codex',
            labels: ['risk:medium'],
            updatedAt: '2026-05-15T12:00:00.000Z',
            headSha: 'sha-happy-101',
            terminal: false,
            observedAt: '2026-05-15T12:00:01.000Z',
          },
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#102', revisionRef: null },
            lifecycle: 'pending-review',
            title: '[codex] LAC-636 null head sha runtime claim',
            authorRef: 'codex-worker',
            builderClass: 'codex',
            labels: ['risk:medium'],
            updatedAt: '2026-05-15T12:00:02.000Z',
            headSha: null,
            terminal: false,
            observedAt: '2026-05-15T12:00:03.000Z',
          },
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#103', revisionRef: 'sha-missing-103' },
            missingDetail: true,
          },
        ];

        export function parseSubjectExternalId(subjectExternalId) {
          const match = String(subjectExternalId || '').match(/^([^#/]+\\/[^#/]+)#(\\d+)$/);
          if (!match) throw new TypeError('Invalid GitHub PR subjectExternalId: ' + subjectExternalId);
          return { repo: match[1], prNumber: Number(match[2]) };
        }

        export function makeSubjectExternalId(repo, prNumber) {
          return String(repo) + '#' + Number(prNumber);
        }

        export function revisionRefFromPR(pr) {
          return pr?.head?.sha || null;
        }

        export function stateFromSnapshot(snapshot) {
          return {
            ref: {
              domainId: snapshot.domainId || 'code-pr',
              subjectExternalId: snapshot.subjectExternalId,
              revisionRef: snapshot.revisionRef ?? snapshot.headSha ?? null,
            },
            lifecycle: snapshot.state && snapshot.state !== 'open' ? 'terminal' : 'pending-review',
            title: snapshot.title || '',
            authorRef: snapshot.authorRef,
            builderClass: snapshot.builderClass,
            labels: snapshot.labels || [],
            updatedAt: snapshot.updatedAt,
            headSha: snapshot.headSha ?? null,
            terminal: Boolean(snapshot.state && snapshot.state !== 'open'),
            observedAt: '2026-05-15T12:00:04.000Z',
          };
        }

        export function createGitHubPRSubjectAdapter({ octokit } = {}) {
          return {
            async discoverSubjects() {
              return subjects.map((subject) => subject.ref);
            },
            async fetchState(ref) {
              const subject = subjects.find((candidate) => candidate.ref.subjectExternalId === ref.subjectExternalId);
              if (!subject) throw new Error('unknown subject ' + ref.subjectExternalId);
              if (subject.missingDetail) {
                const { repo, prNumber } = parseSubjectExternalId(ref.subjectExternalId);
                const [owner, repoName] = repo.split('/');
                const detail = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
                if (detail.data !== null) throw new Error('missing-detail fixture expected null PR detail');
                return {
                  ref,
                  lifecycle: 'terminal',
                  title: '',
                  labels: [],
                  headSha: null,
                  terminal: true,
                  observedAt: '2026-05-15T12:00:05.000Z',
                };
              }
              return { ...subject, ref: { ...subject.ref } };
            },
          };
        }
      `)}
    };
  }

  if (url === 'fixture:operator-surface') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "globalThis.__watcherClaimLoopOperatorWrites = []; export function createCompositeOperatorSurface() { return { extractLinearTicketId(title) { const match = String(title || '').match(/\\\\b(LAC-\\\\d+)\\\\b/i); return match ? match[1].toUpperCase() : null; }, syncTriageStatus: async (...args) => globalThis.__watcherClaimLoopOperatorWrites.push(args), observeOperatorApproved: async () => null, observeLabelControl: async () => null }; }"
    };
  }

  if (url === 'fixture:reviewer-runtime') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(reviewerRuntimeSource)}
    };
  }

  const simpleStubs = {
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; } export function deleteGateRecordsForPR() {} export function pickAdversarialGateStatus() { return { state: 'pending', reason: 'fixture', context: 'agent-os/adversarial-gate' }; } export async function projectAdversarialGateStatus() { return { decision: { state: 'pending', reason: 'fixture' } }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; } export const PUBLIC_REPLY_MAX_CHARS = 1200; export function detectPublicReplyNoiseSignal() { return null; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); }",
    'fixture:follow-up-merge-agent': ${JSON.stringify(followUpMergeAgentSource)},
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 3; export function classifyReviewerFailure() { return 'unknown'; } export function clearCascadeState() {} export function formatTransientFailureBreakdown() { return ''; } export function isReviewerSubprocessTimeout() { return false; } export function readCascadeState() { return null; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; }",
    'fixture:reviewer-reattach': "export function makeReviewPostedProbe() { return async () => null; } export function reviewerBotLogin(reviewer) { return reviewer ? 'codex-reviewer-lacey' : null; } export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; } export function resolveProgressTimeoutMs() { return 300000; }",
    'fixture:reviewer-broker-refresh': "globalThis.__watcherClaimLoopBrokerRefreshes = 0; export async function refreshReviewerBrokerTokens() { globalThis.__watcherClaimLoopBrokerRefreshes += 1; return { refreshed: 0, failed: 0, skipped: 3 }; } export async function refreshWatcherGithubToken() { return { refreshed: false, reason: 'fixture' }; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed-title path'); }",
    'fixture:watcher-memory-pressure': "export async function checkReviewerMemoryAdmission() { return { admit: true, reason: null, sample: { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }, projectedHeadroomMb: 999999, availableMb: 999999, swapUsedPct: 0, estimatedReviewerRssMb: 0, reservedMb: 0 }; } export function peakReviewerMemoryMbFor() { return 0; } export async function readMemoryPressureSample() { return { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }; }",
    'fixture:github-api': "export async function fetchPullRequestRollup() { throw new Error('unexpected github rollup call'); } export async function fetchPullRequestHeadAndState() { return { state: 'open', mergedAt: null, closedAt: null, headRefOid: 'fixture-head', labels: [] }; } export async function fetchPullRequestMergeability() { return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }; } export async function fetchReviewBodiesForHead() { return []; } export async function fetchPullRequestCommitSubjects() { return []; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
  };
  if (Object.prototype.hasOwnProperty.call(simpleStubs, url)) {
    return { format: 'module', shortCircuit: true, source: simpleStubs[url] };
  }

  return nextLoad(url, context);
}
`;
}

function buildRegisterSource(loaderPath) {
  return `
import { register } from 'node:module';

register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
`;
}

function buildRunnerSource({ expectPollError = false } = {}) {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';

const githubCalls = [];
const githubWrites = [];
const fetchCalls = [];
const claims = [];
globalThis.fetch = async (...args) => {
  fetchCalls.push(args.map(String));
  throw new Error('unexpected fetch call from watcher claim-loop test');
};
function readRows(db) {
  const rows = db.prepare(
    'SELECT repo, pr_number, review_status, reviewer_head_sha FROM reviewed_prs ORDER BY pr_number'
  ).all();
  return Object.fromEntries(rows.map((row) => [String(row.pr_number), row]));
}

function readPassRows(db) {
  return db.prepare(
    'SELECT repo, pr_number, attempt_number, pass_kind, status, workspace_path, metadata_json FROM reviewer_passes ORDER BY pr_number, pass_id'
  ).all();
}

try {
  const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
  const db = globalThis.__watcherClaimLoopDb;
  assert.ok(db, 'watcher should have opened the synthetic in-memory DB');
  const insert = db.prepare(
    \`INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?)\`
  );
  for (const [prNumber, reviewer] of [[101, 'claude'], [102, 'claude']]) {
    insert.run(
      'laceyenterprises/adversarial-review',
      prNumber,
      '2026-05-15T12:00:00.000Z',
      reviewer,
      'closed',
      'pending',
      0
    );
  }

  const octokit = {
    paginate: async (_fn, params) => {
      githubCalls.push({ kind: 'paginate', params });
      return [{ name: 'adversarial-review', archived: false }];
    },
    rest: {
      repos: {
        listForOrg: async () => {
          throw new Error('listForOrg should be reached through octokit.paginate only');
        },
      },
      pulls: {
        get: async (params) => {
          githubCalls.push({ kind: 'pulls.get', params });
          if (params.pull_number === 103) return { data: null };
          return {
            data: {
              number: params.pull_number,
              state: 'open',
              merged_at: null,
              closed_at: null,
              head: { sha: 'sha-detail-' + params.pull_number },
            },
          };
        },
        list: async (params) => {
          githubCalls.push({ kind: 'pulls.list', params });
          return { data: [] };
        },
      },
      issues: new Proxy({}, {
        get(_target, property) {
          return async (...args) => {
            githubWrites.push({ surface: 'issues', property: String(property), args });
            throw new Error('unexpected GitHub issues write');
          };
        },
      }),
    },
    request: async (...args) => {
      githubWrites.push({ surface: 'request', args });
      throw new Error('unexpected octokit.request call');
    },
  };

  let pollError = null;
  try {
    await pollOnce(octokit, {
      healthProbe: {
        beginTick() { return {}; },
        recordOpenPending() {},
        recordSpawn() {},
        async finishTick() {},
      },
      afterClaim(payload) {
        claims.push(payload);
      },
    });
  } catch (err) {
    pollError = err;
  }

  if (${expectPollError ? 'pollError === null' : 'pollError !== null'}) {
    throw pollError || new Error('expected watcher pollOnce to throw');
  }

  console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
    rows: readRows(db),
    reviewerPassRows: readPassRows(db),
    claims,
    githubCalls,
    githubWrites,
    fetchCalls,
    operatorWrites: globalThis.__watcherClaimLoopOperatorWrites || [],
    reviewerSpawns: globalThis.__watcherClaimLoopReviewerSpawns || [],
    brokerRefreshes: globalThis.__watcherClaimLoopBrokerRefreshes || 0,
    pollError: pollError ? String(pollError.message || pollError) : null,
  }));
} catch (err) {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
}
`;
}

function buildRefreshRunnerSource() {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  cancelReviewerRuntimeSession,
  refreshReviewerRuntimeAdapter,
  reviewerRuntimeAdapterForRunRecord,
} = await import(${JSON.stringify(watcherUrl)});
const calls = [];
const loggerMessages = [];
const logger = { error: (message) => loggerMessages.push(String(message)) };

let mode = 'native';
let mtime = 1;
let throwAgentosAdapter = false;
function loadConfigImpl() {
  if (mode === 'throw') throw new Error('invalid orchestration mode');
  return { getOrchestrationMode: () => mode };
}

function createAdapterImpl({ orchestrationMode }) {
  calls.push(orchestrationMode);
  if (throwAgentosAdapter && orchestrationMode === 'agentos') {
    throw new Error('agent-os-hq unavailable');
  }
  return { describe: () => ({ id: orchestrationMode }) };
}

const first = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
const second = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(first, second);
assert.deepEqual(calls, ['native']);

mode = 'agentos';
throwAgentosAdapter = true;
const third = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(third, second);
assert.deepEqual(calls, ['native', 'agentos']);
assert.ok(
  loggerMessages.some((message) => /requested orchestration_mode=agentos but active adapter remains native/.test(message))
);

mode = 'native';
const recoveredNative = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(recoveredNative, first);
loggerMessages.length = 0;

mode = 'agentos';
const staleSignalCheck = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(staleSignalCheck, third);
assert.ok(
  loggerMessages.some((message) => /reviewer runtime adapter degraded consecutive=1/.test(message))
);

throwAgentosAdapter = false;
const fourth = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.notEqual(fourth, third);
assert.deepEqual(calls, ['native', 'agentos', 'agentos', 'agentos']);

throwAgentosAdapter = true;
mtime = 2;
loggerMessages.length = 0;
const sameModeFailure = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(sameModeFailure, fourth);
const repeatedSameModeFailure = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(repeatedSameModeFailure, fourth);
assert.ok(
  loggerMessages.some((message) => /reviewer runtime adapter degraded consecutive=1/.test(message))
);
assert.ok(
  loggerMessages.some((message) => /reviewer runtime adapter degraded consecutive=2/.test(message))
);
assert.ok(
  loggerMessages.some((message) => /orchestration_mode=agentos adapter refresh failed/.test(message))
);
throwAgentosAdapter = false;

mtime = 1;
mode = 'throw';
const fifth = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.equal(fifth, fourth);
assert.deepEqual(calls, ['native', 'agentos', 'agentos', 'agentos', 'agentos', 'agentos']);
assert.ok(loggerMessages.some((message) => /invalid orchestration mode/.test(message)));
assert.ok(loggerMessages.some((message) => /broker token refresh still runs/.test(message)));

mtime = 3;
mode = 'agentos';
const sixth = refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
assert.notEqual(sixth, fifth);
assert.deepEqual(calls, ['native', 'agentos', 'agentos', 'agentos', 'agentos', 'agentos', 'agentos']);

const cancelled = [];
const cancelLogs = [];
await cancelReviewerRuntimeSession({
  sessionUuid: 'corrupt-record',
  reason: 'test',
  readRunRecord: () => {
    throw new Error('bad json');
  },
  defaultAdapter: {
    cancel: async (sessionUuid) => cancelled.push(['default', sessionUuid]),
  },
  logger: { error: (message) => cancelLogs.push(String(message)) },
});
assert.deepEqual(cancelled, [['default', 'corrupt-record']]);
assert.ok(cancelLogs.some((message) => /cancel_record_read_failed/.test(message)));

await cancelReviewerRuntimeSession({
  sessionUuid: 'unknown-runtime',
  reason: 'test',
  readRunRecord: () => ({ sessionUuid: 'unknown-runtime', runtime: 'removed-runtime' }),
  adapterForRecord: () => {
    throw new Error('runtime removed');
  },
  defaultAdapter: {
    cancel: async (sessionUuid) => cancelled.push(['fallback', sessionUuid]),
  },
  logger: { error: (message) => cancelLogs.push(String(message)) },
});
assert.deepEqual(cancelled, [
  ['default', 'corrupt-record'],
  ['fallback', 'unknown-runtime'],
]);
assert.ok(cancelLogs.some((message) => /cancel_adapter_resolve_failed/.test(message)));

const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-runtime-cache-'));
try {
  mkdirSync(path.join(rootDir, 'domains'), { recursive: true });
  const domainPath = path.join(rootDir, 'domains', 'code-pr.json');
  writeFileSync(domainPath, '{"marker":"first"}\\n');
  utimesSync(domainPath, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
  const firstByName = reviewerRuntimeAdapterForRunRecord(
    { runtime: 'fixture-by-name', domain: 'code-pr' },
    { rootDir, logger }
  );
  writeFileSync(domainPath, '{"marker":"second"}\\n');
  utimesSync(domainPath, new Date('2026-01-01T00:00:01.000Z'), new Date('2026-01-01T00:00:01.000Z'));
  const secondByName = reviewerRuntimeAdapterForRunRecord(
    { runtime: 'fixture-by-name', domain: 'code-pr' },
    { rootDir, logger }
  );
  const cachedSecondByName = reviewerRuntimeAdapterForRunRecord(
    { runtime: 'fixture-by-name', domain: 'code-pr' },
    { rootDir, logger }
  );
  assert.notEqual(firstByName, secondByName);
  assert.equal(cachedSecondByName, secondByName);
  assert.deepEqual(globalThis.__watcherRuntimeByNameCalls.map((call) => call.domainConfig.marker), [
    'first',
    'second',
  ]);
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}

loggerMessages.length = 0;
const missingDomainRoot = mkdtempSync(path.join(tmpdir(), 'watcher-runtime-missing-domain-'));
try {
  mkdirSync(path.join(missingDomainRoot, 'domains'), { recursive: true });
  assert.throws(
    () => reviewerRuntimeAdapterForRunRecord(
      { runtime: 'fixture-by-name', domain: 'code-pr' },
      { rootDir: missingDomainRoot, logger }
    ),
    /ENOENT/
  );
  assert.ok(
    loggerMessages.some((message) => /reviewer runtime adapter degraded/.test(message) && /domain=code-pr/.test(message) && /during mtime/.test(message))
  );
} finally {
  rmSync(missingDomainRoot, { recursive: true, force: true });
}

loggerMessages.length = 0;
const corruptDomainRoot = mkdtempSync(path.join(tmpdir(), 'watcher-runtime-corrupt-domain-'));
try {
  mkdirSync(path.join(corruptDomainRoot, 'domains'), { recursive: true });
  const corruptDomainPath = path.join(corruptDomainRoot, 'domains', 'code-pr.json');
  writeFileSync(corruptDomainPath, '{not-json}\\n');
  assert.throws(
    () => reviewerRuntimeAdapterForRunRecord(
      { runtime: 'fixture-by-name', domain: 'code-pr' },
      { rootDir: corruptDomainRoot, logger }
    ),
    /Expected property name|Unexpected token/
  );
  assert.ok(
    loggerMessages.some((message) => /reviewer runtime adapter degraded/.test(message) && /domain=code-pr/.test(message) && /during load/.test(message))
  );
} finally {
  rmSync(corruptDomainRoot, { recursive: true, force: true });
}
`;
}

test('watcher pollOnce claim loop records subject-state head SHAs and drives the happy path', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.rows['101'].review_status, 'posted');
    assert.equal(summary.rows['101'].reviewer_head_sha, 'sha-happy-101');
    assert.equal(summary.rows['102'].review_status, 'posted');
    assert.equal(summary.rows['102'].reviewer_head_sha, null);
    assert.deepEqual(
      summary.claims
        .map((claim) => [claim.prNumber, claim.reviewerHeadSha])
        .sort((a, b) => a[0] - b[0]),
      [
        [101, 'sha-happy-101'],
        [102, null],
      ]
    );
    assert.ok(
      summary.githubCalls.some((call) => call.kind === 'pulls.get' && call.params.pull_number === 103),
      'missing-PR detail edge should exercise the synthetic pulls.get fixture'
    );
    assert.deepEqual(summary.githubWrites, []);
    assert.deepEqual(
      summary.fetchCalls.filter(([url]) => url !== 'https://api.github.com/user'),
      []
    );
    assert.equal(summary.brokerRefreshes, 1);
    assert.equal(summary.operatorWrites.length, 2);
    assert.deepEqual(
      summary.operatorWrites
        .map(([subjectRef, status]) => [subjectRef.subjectExternalId, status])
        .sort((a, b) => a[0].localeCompare(b[0])),
      [
        ['laceyenterprises/adversarial-review#101', 'in-review'],
        ['laceyenterprises/adversarial-review#102', 'in-review'],
      ]
    );
    assert.equal(summary.reviewerSpawns.length, 2);
    assert.ok(
      summary.reviewerSpawns.every(Boolean),
      'happy-path subjects should spawn reviewer work after the claim'
    );
    assert.ok(
      summary.reviewerPassRows.every((row) => row.workspace_path === REPO_ROOT),
      'reviewer pass rows should retain the tool root so transcript token fallback can match Claude sessions on disk'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher reviewer runtime refresh memoizes and falls back on config errors', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-refresh-runtime-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-refresh-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: `
        import { readFileSync } from 'node:fs';
        import { join } from 'node:path';
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        globalThis.__watcherRuntimeByNameCalls = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return {
            describe: () => ({ id: 'cli-direct' }),
            spawnReviewer: async (payload) => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              return { ok: true, stdout: '', stderr: '' };
            },
            cancel: async () => {},
            reattach: async () => ({}),
          };
        }
        export function createReviewerRuntimeAdapterByName(name, options = {}) {
          globalThis.__watcherRuntimeByNameCalls.push({
            name,
            domainConfig: options.domainConfig,
          });
          return {
            describe: () => ({ id: name }),
            cancel: async () => {},
            reattach: async () => ({}),
          };
        }
        export function loadDomainConfig(rootDir, domainId) {
          return JSON.parse(readFileSync(join(rootDir, 'domains', \`\${domainId}.json\`), 'utf8'));
        }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
      `,
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRefreshRunnerSource());

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce refreshes broker tokens when orchestration_mode config is invalid', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ expectPollError: true }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv({
          AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'agent-os',
        }),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /roles\.adversarial\.orchestration_mode/);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
    assert.equal(summary.brokerRefreshes, 1);
    assert.match(summary.pollError, /AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE/);
    assert.equal(summary.reviewerSpawns.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce isolates fast-merge poll exceptions and still claims normal review work', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      followUpMergeAgentSource: `
        export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add';
        export function classifyBlockingFindings() { return { count: 0, state: 'known' }; }
        export async function addMergeAgentDispatchedLabel() { return { added: true }; }
        export function buildMergeAgentDispatchJob() { return null; }
        export async function dispatchMergeAgentForPR() { return { dispatched: false }; }
        export function fetchMergeAgentCandidate() { return null; }
        export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; }
        export function clearMergeAgentLifecycleCleanup() { return true; }
        export function listMergeAgentDispatches() { return []; }
        export function listMergeAgentLifecycleCleanups() { return []; }
        export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; }
        export async function pollFastMergeQueue() { throw new Error('fixture fast-merge select failed'); }
        export function resolveFastMergePerPollCap() { return 5; }
        export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; }
        export function summarizeChecksConclusion() { return 'SUCCESS'; }
        export function updateMergeAgentLifecycleCleanup() { return {}; }
        export function upsertMergeAgentLifecycleCleanup() { return {}; }
        export function scanStuckMergeAgentDispatches() { return []; }
        export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; }
        export function validateStartupMergeAgentConfig() {}
        export function isScopedMergeAgentRequest() { return false; }
      `,
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /fixture fast-merge select failed/);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
    assert.equal(summary.pollError, null);
    assert.equal(summary.rows['101'].review_status, 'posted');
    assert.equal(summary.rows['102'].review_status, 'posted');
    assert.equal(summary.reviewerSpawns.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce settles reviewer_passes as failed when reviewer spawn throws', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); throw new Error('fixture reviewer spawn failure'); }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ expectPollError: true }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.pollError, '2 reviewer dispatch tasks failed');
    assert.equal(summary.reviewerSpawns.length, 2);
    assert.equal(summary.reviewerPassRows.length, 2);
    assert.ok(summary.reviewerPassRows.every((row) => row.status === 'failed'));
    assert.ok(summary.reviewerPassRows.every((row) => row.workspace_path === REPO_ROOT));
    assert.ok(summary.reviewerPassRows.every((row) => /fixture reviewer spawn failure/.test(row.metadata_json)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce serial fallback preserves stop-on-first-spawn-failure behavior', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); throw new Error('fixture reviewer spawn failure'); }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ expectPollError: true }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv({
          ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_ENABLED: 'false',
        }),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.pollError, 'fixture reviewer spawn failure');
    assert.equal(summary.reviewerSpawns.length, 1);
    assert.equal(summary.reviewerPassRows.length, 1);
    assert.equal(summary.reviewerPassRows[0].status, 'failed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
