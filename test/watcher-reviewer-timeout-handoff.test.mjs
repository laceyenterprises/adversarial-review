import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SUMMARY_MARKER = '@@WATCHER_TIMEOUT_HANDOFF@@';

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

function buildLoaderSource() {
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
    [fileUrl('src', 'follow-up-retrigger-review-label.mjs')]: 'fixture:follow-up-retrigger-review-label',
    [fileUrl('src', 'operator-retrigger-helpers.mjs')]: 'fixture:operator-retrigger-helpers',
    [fileUrl('src', 'reviewer-cascade.mjs')]: 'fixture:reviewer-cascade',
    [fileUrl('src', 'reviewer-reattach.mjs')]: 'fixture:reviewer-reattach',
    [fileUrl('src', 'reviewer-timeout.mjs')]: 'fixture:reviewer-timeout',
    [fileUrl('src', 'stale-drift.mjs')]: 'fixture:stale-drift',
    [fileUrl('src', 'watcher-fail-loud.mjs')]: 'fixture:watcher-fail-loud',
    [fileUrl('src', 'watcher-memory-pressure.mjs')]: 'fixture:watcher-memory-pressure',
    [fileUrl('src', 'github-api.mjs')]: 'fixture:github-api',
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
    [fileUrl('src', 'ama', 'dispatch-closer.mjs')]: 'fixture:ama-dispatch-closer',
    [fileUrl('src', 'config-loader.mjs')]: 'fixture:config-loader',
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
            globalThis.__timeoutHandoffDb = db;
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
        export function parseSubjectExternalId(subjectExternalId) {
          const match = String(subjectExternalId || '').match(/^([^#/]+\\/[^#/]+)#(\\d+)$/);
          if (!match) throw new TypeError('Invalid GitHub PR subjectExternalId: ' + subjectExternalId);
          return { repo: match[1], prNumber: Number(match[2]) };
        }
        export function createGitHubPRSubjectAdapter() {
          return {
            async discoverSubjects() {
              return [{ domainId: 'code-pr', subjectExternalId: REPO + '#164', revisionRef: 'timeout-head-164' }];
            },
            async fetchState(ref) {
              return {
                ref,
                lifecycle: 'pending-review',
                title: '[codex] LAC-999 timeout handoff',
                authorRef: 'codex-worker',
                builderClass: 'codex',
                labels: [
                  'risk:medium',
                  ...(process.env.FIXTURE_MERGE_AGENT_REQUESTED === '1' ? ['merge-agent-requested'] : []),
                ],
                updatedAt: '2026-05-27T04:00:00.000Z',
                headSha: 'timeout-head-164',
                terminal: false,
                observedAt: '2026-05-27T04:00:01.000Z',
              };
            },
          };
        }
      `)}
    };
  }

  const simpleStubs = {
    'fixture:operator-surface': "globalThis.__timeoutHandoffOperatorWrites = []; export function createCompositeOperatorSurface() { return { extractLinearTicketId() { return null; }, syncTriageStatus: async (...args) => globalThis.__timeoutHandoffOperatorWrites.push(args), observeOperatorApproved: async () => null, observeMergeAgentOverride: async () => process.env.FIXTURE_MERGE_AGENT_REQUESTED === '1' ? { applied: true, observedRevisionRef: 'timeout-head-164', actor: process.env.FIXTURE_MERGE_AGENT_ACTOR || 'operator-bot', eventId: 'evt-merge-agent-requested', observedAt: process.env.FIXTURE_MERGE_AGENT_CREATED_AT || '2026-05-27T04:00:01.000Z' } : null, observeLabelControl: async () => null }; }",
    'fixture:reviewer-runtime': "globalThis.__timeoutHandoffReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__timeoutHandoffReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function deleteGateRecordsForPR() {} export async function projectAdversarialGateStatus() { return { decision: { state: 'success', reason: 'reviewer-timeout' } }; } export function resolveSettledReviewVerdict() { return { verdict: '', remediationPending: false }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export function resolveRoundBudgetForJob() { return { roundBudget: 2, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 1, latestRiskClass: 'medium', latestMaxRounds: 2 }; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); }",
    'fixture:follow-up-merge-agent': "globalThis.__timeoutHandoffDispatches = []; export const MERGE_AGENT_DISPATCHED_LABEL = 'merge-agent-dispatched'; export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob() { return { repo: 'laceyenterprises/adversarial-review', prNumber: 164, branch: 'codex/timeout-handoff', baseBranch: 'main', headSha: 'timeout-head-164', lastVerdict: 'Request changes', latestFollowUpJobStatus: 'completed', latestFollowUpReReviewRequested: true, reviewFailureClass: 'reviewer-timeout', reviewFailureExhausted: true, mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS', labels: [] }; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export async function dispatchMergeAgentForPR(payload) { globalThis.__timeoutHandoffDispatches.push(payload); return { decision: 'dispatch', trigger: 'reviewer-timeout-exhausted' }; } export function fetchMergeAgentCandidate(repo, prNumber) { return { repo, prNumber, branch: 'codex/timeout-handoff', baseBranch: 'main', headSha: 'timeout-head-164', mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS', labels: [], operatorNotes: null, prState: 'open', merged: false, prUpdatedAt: '2026-05-27T04:00:01.000Z' }; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export function isScopedMergeAgentRequest(job) { const request = job?.mergeAgentRequest; if (!request) return false; if (!request.actor || String(request.actor).trim().toLowerCase() === 'unknown') return false; if (!request.labelEventId && !request.labelEventNodeId) return false; if (!request.createdAt) return false; if (String(request.headSha || '') !== String(job?.headSha || '')) return false; const prUpdatedAt = request.prUpdatedAt || job?.prUpdatedAt || null; if (prUpdatedAt && Date.parse(request.createdAt) < Date.parse(prUpdatedAt)) return false; return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export function resolveFastMergePerPollCap() { return 5; } export function scanStuckMergeAgentDispatches() { return []; } export function shouldUseReviewerTimeoutExhaustedMergeGate(job) { return job.reviewFailureClass === 'reviewer-timeout' && job.reviewFailureExhausted === true && job.latestFollowUpJobStatus === 'completed' && job.latestFollowUpReReviewRequested === true; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {}",
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:follow-up-retrigger-review-label': "export const RETRIGGER_REVIEW_LABEL = 'retrigger-review'; export async function retryPendingRetriggerReviewAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerReviewFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 5; export function classifyReviewerFailure() { return 'unknown'; } export function clearCascadeState() {} export function formatTransientFailureBreakdown() { return ''; } export function readCascadeState() { return { transientFailureBreakdown: { 'reviewer-timeout': 5 }, lastFailureClass: 'reviewer-timeout', nextRetryAfter: '2026-05-27T03:00:00.000Z' }; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; }",
    'fixture:reviewer-reattach': "export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed-title path'); }",
    'fixture:watcher-memory-pressure': "export async function checkReviewerMemoryAdmission() { return { admit: true, reason: null, sample: { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }, projectedHeadroomMb: 999999, availableMb: 999999, swapUsedPct: 0, estimatedReviewerRssMb: 0, reservedMb: 0 }; } export function peakReviewerMemoryMbFor() { return 0; } export async function readMemoryPressureSample() { return { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }; }",
    'fixture:github-api': "export async function fetchPullRequestRollup() { throw new Error('unexpected github rollup call'); } export async function fetchPullRequestHeadAndState() { return { state: 'open', mergedAt: null, closedAt: null, headRefOid: 'timeout-head-164', labels: [] }; } export async function fetchReviewBodiesForHead() { return []; } export async function fetchPullRequestCommitSubjects() { return []; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
    'fixture:ama-dispatch-closer': "export async function maybeDispatchAmaCloser() { const reason = process.env.FIXTURE_AMA_REASON || 'not-eligible'; return { dispatched: false, reason, ...(reason === 'not-eligible' ? { reasons: ['risk-class-blocked'] } : {}) }; }",
    'fixture:config-loader': "export class AgentOSConfigError extends Error {} function buildConfig() { return { get() { return undefined; }, getMergeAuthorityConfig() { return { enabled: process.env.FIXTURE_AMA_ENABLED === '1' }; }, getOrchestrationMode() { return process.env.FIXTURE_ORCHESTRATION_MODE || 'native'; } }; } export function loadConfig() { return buildConfig(); } export function loadConfigCached() { return buildConfig(); } export function resetConfigCache() {}",
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

function buildRunnerSource() {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';

const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
const db = globalThis.__timeoutHandoffDb;
assert.ok(db, 'watcher should open the synthetic review-state DB');
db.prepare(
  \`INSERT INTO reviewed_prs
     (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`
).run(
  'laceyenterprises/adversarial-review',
  164,
  '2026-05-27T04:00:00.000Z',
  'claude',
  'open',
  'pending-upstream',
  0,
  '2026-05-27T04:00:00.000Z',
  '[reviewer-timeout] Reviewer command timed out before posting; watcher backoff engaged.'
);

const octokit = {
  paginate: async () => [{ name: 'adversarial-review', archived: false }],
  rest: {
    repos: { listForOrg: async () => ({ data: [] }) },
    pulls: {
      list: async () => ({ data: [] }),
      get: async ({ pull_number }) => ({
        data: {
          number: pull_number,
          state: 'open',
          merged_at: null,
          closed_at: null,
          head: { sha: 'timeout-head-164' },
        },
      }),
    },
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

const row = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
  .get('laceyenterprises/adversarial-review', 164);
console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
  reviewStatus: row.review_status,
  reviewerSpawns: globalThis.__timeoutHandoffReviewerSpawns || [],
  dispatches: globalThis.__timeoutHandoffDispatches || [],
  operatorWrites: globalThis.__timeoutHandoffOperatorWrites || [],
}));
`;
}

test('watcher pollOnce routes reviewer-timeout exhaustion through merge-agent instead of spawning reviewer', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-handoff-'));
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
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
          FIXTURE_ORCHESTRATION_MODE: 'agentos',
        },
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.reviewStatus, 'pending-upstream');
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.operatorWrites.length, 0);
    assert.equal(summary.dispatches.length, 1);
    assert.equal(summary.dispatches[0].reviewFailureClass, 'reviewer-timeout');
    assert.equal(summary.dispatches[0].reviewFailureExhausted, true);
    assert.equal(summary.dispatches[0].latestFollowUpReReviewRequested, true);
    assert.equal(summary.dispatches[0].orchestrationMode, 'agentos');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce parks reviewer-timeout exhaustion when AMA is enabled without a fresh fallback request', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-handoff-ama-await-'));
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
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
          FIXTURE_AMA_ENABLED: '1',
          FIXTURE_AMA_REASON: 'not-eligible',
        },
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.reviewStatus, 'pending-upstream');
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.dispatches.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce recovers reviewer-timeout exhaustion when AMA dispatch fails', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-handoff-ama-recover-'));
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
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
          FIXTURE_AMA_ENABLED: '1',
          FIXTURE_AMA_REASON: 'dispatch-failed',
        },
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.reviewStatus, 'pending-upstream');
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.dispatches.length, 1);
    assert.equal(summary.dispatches[0].env.AMA_OPERATOR_MERGE_AGENT_OVERRIDE, 'true');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce uses the AMA operator-fallback env on reviewer-timeout exhaustion', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-handoff-ama-fallback-'));
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
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
          FIXTURE_AMA_ENABLED: '1',
          FIXTURE_AMA_REASON: 'not-eligible',
          FIXTURE_MERGE_AGENT_REQUESTED: '1',
          FIXTURE_MERGE_AGENT_ACTOR: 'codex-worker',
          FIXTURE_MERGE_AGENT_CREATED_AT: '2026-05-27T04:00:01.000Z',
        },
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.reviewStatus, 'pending-upstream');
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.dispatches.length, 1);
    assert.equal(summary.dispatches[0].env.AMA_OPERATOR_MERGE_AGENT_OVERRIDE, 'true');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
