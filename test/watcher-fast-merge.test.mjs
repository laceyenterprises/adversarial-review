import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  ensureReviewStateSchema,
  requestReviewRereview,
} from '../src/review-state.mjs';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SUMMARY_MARKER = '@@WATCHER_FAST_MERGE_SUMMARY@@';
const REPO = 'laceyenterprises/agent-os';

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

function buildLoaderSource(scenario) {
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const reviewStateActualUrl = `${reviewStateUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');
  const stubs = {
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')]: 'fixture:routing',
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
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
    [fileUrl('src', 'atomic-write.mjs')]: 'fixture:atomic-write',
    [fileUrl('src', 'github-api.mjs')]: 'fixture:github-api',
    [fileUrl('src', 'gh-cli.mjs')]: 'fixture:gh-cli',
    [fileUrl('src', 'ama', 'ham-provenance.mjs')]: 'fixture:ama-ham-provenance',
  };

  return `
const stubs = new Map(${JSON.stringify(Object.entries(stubs))});
const scenario = ${JSON.stringify(scenario)};

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
            globalThis.__fastMergeDb = db;
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
        const scenario = ${JSON.stringify(scenario)};
        export function parseSubjectExternalId(subjectExternalId) {
          const match = String(subjectExternalId || '').match(/^([^#/]+\\/[^#/]+)#(\\d+)$/);
          if (!match) throw new TypeError('Invalid GitHub PR subjectExternalId: ' + subjectExternalId);
          return { repo: match[1], prNumber: Number(match[2]) };
        }
        export function createGitHubPRSubjectAdapter() {
          return {
            async discoverSubjects() {
              return scenario.subjects.map((subject) => subject.ref);
            },
            async fetchState(ref) {
              const subject = scenario.subjects.find((candidate) => candidate.ref.subjectExternalId === ref.subjectExternalId);
              if (!subject) throw new Error('unknown subject ' + ref.subjectExternalId);
              return { ...subject, ref: { ...subject.ref } };
            },
          };
        }
      `)}
    };
  }

  const simpleStubs = {
    'fixture:routing': "export const REVIEWER_ROUTE_BY_MODEL = {}; export const ROUTE_BY_BUILDER_CLASS = {}; export function routeSubject(subject) { return String(subject.title || '').startsWith('[codex]') || String(subject.title || '').startsWith('[claude-code]') ? { reviewerModel: 'claude', botTokenEnv: 'CLAUDE_TOKEN', tag: 'codex' } : null; } export function defaultReviewerRouteFromEnv() { return null; } export function validateDefaultReviewerRouteConfig() {} export function describeCrossModelReviewWaiver() { return null; } export function isCrossModelReviewWaived() { return false; } export function applyGeminiReviewerRoute(opts) { return opts && opts.baseRoute; } export function applyEffectiveReviewerRoute(opts) { return opts && opts.baseRoute; }",
    'fixture:operator-surface': "export function createCompositeOperatorSurface() { return { extractLinearTicketId() { return null; }, syncTriageStatus: async () => {}, observeOperatorApproved: async () => null, observeLabelControl: async () => null }; }",
    'fixture:reviewer-runtime': "globalThis.__fastMergeSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__fastMergeSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; } export function deleteGateRecordsForPR() {} export function pickAdversarialGateStatus() { return { state: 'pending', reason: 'fixture', context: 'agent-os/adversarial-gate' }; } export async function projectAdversarialGateStatus() { return { decision: { state: 'pending', reason: 'fixture' } }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; } export const PUBLIC_REPLY_MAX_CHARS = 1200; export function detectPublicReplyNoiseSignal() { return null; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); }",
    'fixture:follow-up-merge-agent': "export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export async function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export function resolveFastMergePerPollCap() { return 5; } export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export function scanStuckMergeAgentDispatches() { return []; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {} export function isScopedMergeAgentRequest() { return false; }",
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:follow-up-retrigger-review-label': "export const RETRIGGER_REVIEW_LABEL = 'retrigger-review'; export async function retryPendingRetriggerReviewAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerReviewFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 3; export function clearCascadeState() {} export function formatTransientFailureBreakdown() { return ''; } export function readCascadeState() { return null; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; }",
    'fixture:reviewer-reattach': "export function makeReviewPostedProbe() { return async () => null; } export function reviewerBotLogin(reviewer) { return reviewer ? 'codex-reviewer-lacey' : null; } export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; } export function resolveAgyReviewerSubprocessTimeoutMs() { return 300000; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed title'); }",
    'fixture:watcher-memory-pressure': "export async function checkReviewerMemoryAdmission() { return { admit: true, reason: null, sample: { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }, projectedHeadroomMb: 999999, availableMb: 999999, swapUsedPct: 0, estimatedReviewerRssMb: 0, reservedMb: 0 }; } export function peakReviewerMemoryMbFor() { return 0; } export async function readMemoryPressureSample() { return { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
    'fixture:atomic-write': "globalThis.__fastMergeAuditWrites = []; export function writeFileAtomic(path, content, options) { if (globalThis.__fastMergeFailAuditWrites) { throw new Error('fixture audit write failed'); } globalThis.__fastMergeAuditWrites.push({ path, content, options }); }",
    'fixture:gh-cli': "export const GH_LOOKUP_MAX_BUFFER = 26214400; export const GH_LOOKUP_TIMEOUT_MS = 30000; export function buildAllowlistedGhEnv(env = process.env) { return { ...env }; } export async function execGhWithRetry() { throw new Error('unexpected gh-cli fixture call'); } export function isTransientGhError() { return false; } export function parseDate(value) { return value ? new Date(value) : null; } export function parseJsonLines(stdout) { return String(stdout || '').split('\\\\n').filter(Boolean).map((line) => JSON.parse(line)); }",
    'fixture:ama-ham-provenance': "export const HAM_AUDIT_COMMENT_AUTHOR_LOGINS = new Set(); export function hamAuditCommentAuthorMatches() { return false; } export function parseCommitTrailers() { return {}; } export function parseRemediatedFindingsTrailer() { return null; }",
    'fixture:github-api': ${JSON.stringify(`
      const scenario = ${JSON.stringify(scenario)};
      export async function fetchPullRequestRollup(repo, prNumber) {
        const key = String(prNumber);
        return {
          id: 'fixture-pr-' + key,
          number: Number(prNumber),
          title: '[codex] fast merge test',
          body: '',
          state: 'open',
          mergedAt: null,
          closedAt: null,
          createdAt: '2026-05-20T12:00:00.000Z',
          updatedAt: '2026-05-20T12:00:00.000Z',
          headRefName: 'fixture-branch-' + key,
          baseRefName: 'main',
          headRefOid: scenario.heads[String(prNumber)] || 'sha-live-' + key,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          author: { login: 'fixture-author' },
          labels: scenario.labels[String(prNumber)] || [],
          comments: [],
          reviews: [],
          checks: [],
        };
      }
      export async function fetchPullRequestHeadAndState(repo, prNumber) {
        const key = String(prNumber);
        return {
          state: 'open',
          mergedAt: null,
          closedAt: null,
          headRefOid: scenario.heads[String(prNumber)] || 'sha-live-' + key,
        };
      }
      export async function fetchReviewBodiesForHead() {
        return [];
      }
      export async function fetchPullRequestCommitSubjects() {
        return scenario.commitSubjects || [];
      }
      export async function fetchPullRequestMergeability(repo, prNumber) {
        return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
      }
    `)},
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

function buildRunnerSource(scenario) {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
const scenario = ${JSON.stringify(scenario)};
const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
const db = globalThis.__fastMergeDb;
globalThis.__fastMergeFailAuditWrites = Boolean(scenario.failAuditWrites);
for (const row of scenario.seedRows || []) {
  db.prepare(\`INSERT INTO reviewed_prs
    (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, labels_json, fast_merge_authorized_head_sha)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)\`
  ).run(row.repo, row.prNumber, row.reviewedAt, row.reviewer, row.prState, row.reviewStatus, JSON.stringify(row.labels || []), row.fastMergeAuthorizedHeadSha || null);
}
const octokit = {
  paginate: async (method, params) => {
    if (method === octokit.rest.issues.listEventsForTimeline) {
      return scenario.timelineEvents?.[String(params.issue_number)] || [];
    }
    return [{ name: 'agent-os', archived: false }];
  },
  rest: {
    repos: { listForOrg: async () => ({ data: [] }) },
    pulls: {
      list: async () => ({ data: [] }),
      get: async ({ pull_number }) => ({
        data: {
          number: pull_number,
          state: 'open',
          merged_at: null,
          head: { sha: scenario.heads[String(pull_number)] || 'sha-live-' + pull_number },
        },
      }),
      listFiles: async ({ pull_number }) => ({
        data: scenario.changedFiles?.[String(pull_number)] || [{ filename: 'docs/fast-merge.md', status: 'modified', additions: 1, deletions: 0 }],
      }),
    },
    issues: {
      listLabelsOnIssue: async ({ issue_number }) => ({
        data: scenario.labels[String(issue_number)] || [],
      }),
      listEventsForTimeline: async ({ issue_number }) => ({
        data: scenario.timelineEvents?.[String(issue_number)] || [],
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
const rows = db.prepare(
  'SELECT repo, pr_number, reviewed_at, pr_state, review_status, labels_json, fast_merge_authorized_head_sha, fast_merge_audit_status, fast_merge_audit_error, reviewer_head_sha FROM reviewed_prs ORDER BY pr_number'
).all();
console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
  rows,
  auditEntries: (globalThis.__fastMergeAuditWrites || [])
    .map((write) => JSON.parse(write.content))
    .filter((entry) => entry?.kind === 'fast-merge-audit'),
  spawns: globalThis.__fastMergeSpawns || [],
}));
`;
}

function subject(prNumber, { title = '[codex] fast merge test', headSha = `sha-subject-${prNumber}`, labels = [] } = {}) {
  return {
    ref: { domainId: 'code-pr', subjectExternalId: `${REPO}#${prNumber}`, revisionRef: headSha },
    lifecycle: 'pending-review',
    title,
    authorRef: 'codex-worker',
    builderClass: 'codex',
    labels,
    updatedAt: '2026-05-20T12:00:00.000Z',
    headSha,
    terminal: false,
    observedAt: '2026-05-20T12:00:01.000Z',
  };
}

function timelineLabel(label, createdAt, { actor = 'VirtualPaul' } = {}) {
  return {
    event: 'labeled',
    label: { name: label },
    actor: { login: actor },
    created_at: createdAt,
  };
}

function timelineCommitted(createdAt, sha = 'sha-live') {
  return {
    event: 'committed',
    commit_id: sha,
    committer: { date: createdAt },
  };
}

function timelineForcePush(createdAt, after = 'sha-live') {
  return {
    event: 'head_ref_force_pushed',
    after,
    created_at: createdAt,
  };
}

function runWatcherScenario(scenario, { skipEnabled = false } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-fast-merge-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource(scenario));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource(scenario));
    const ghPath = path.join(tmp, 'gh');
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "api" && "\${2:-}" =~ ^repos/[^/]+/[^/]+/commits/(.+)$ ]]; then
  sha="\${BASH_REMATCH[1]}"
  printf '{"sha":"%s","message":"Fixture commit","committerLogin":null,"authorLogin":null,"committerName":"Fixture Worker","committerEmail":"fixture@example.com"}\\n' "$sha"
  exit 0
fi
echo "unexpected gh fixture call: $*" >&2
exit 1
`);
    chmodSync(ghPath, 0o755);
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
          FML_WATCHER_SKIP_ENABLED: skipEnabled ? 'true' : 'false',
          PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}`,
          WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '1',
        },
      }
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    return JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('fast-merge watcher: no fast-merge label follows normal review path', () => {
  const summary = runWatcherScenario({
    subjects: [subject(801, { labels: [{ name: 'risk:medium' }] })],
    labels: { 801: [{ name: 'risk:medium' }] },
    heads: { 801: 'sha-live-801' },
  });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, null);
  assert.deepEqual(JSON.parse(summary.rows[0].labels_json), [{ name: 'risk:medium' }]);
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries.length, 0);
});

test('fast-merge watcher: single category skips when flag is enabled and records head SHA', () => {
  const summary = runWatcherScenario({
    subjects: [subject(802, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 802: [{ name: 'fast-merge:docs' }] },
    heads: { 802: 'sha-live-802' },
    timelineEvents: {
      802: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'fast_merge_skipped');
  assert.equal(summary.rows[0].review_status, 'fast_merge_skipped');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, 'sha-live-802');
  assert.notEqual(summary.rows[0].reviewed_at, '2026-05-20T12:00:05.000Z');
  assert.equal(summary.rows[0].fast_merge_audit_status, 'written');
  assert.deepEqual(JSON.parse(summary.rows[0].labels_json), [{ name: 'fast-merge:docs' }]);
  assert.equal(summary.spawns.length, 0);
  assert.equal(summary.auditEntries[0].action, 'skipped');
  assert.equal(summary.auditEntries[0].auditType, 'fast-merge-skip');
  assert.deepEqual(summary.auditEntries[0].categories, ['docs']);
  assert.equal(summary.auditEntries[0].fast_merge_authorized_head_sha, 'sha-live-802');
  assert.equal(summary.auditEntries[0].authorized_at, '2026-05-20T12:00:05.000Z');
  assert.match(summary.auditEntries[0].skipped_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(summary.auditEntries[0].authorized_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('fast-merge watcher: flag-off default audits would-have-skipped but reviews normally', () => {
  const summary = runWatcherScenario({
    subjects: [subject(803, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 803: [{ name: 'fast-merge:docs' }] },
    heads: { 803: 'sha-live-803' },
    timelineEvents: {
      803: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z')],
    },
  });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, null);
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries[0].action, 'would-have-skipped');
  assert.deepEqual(summary.auditEntries[0].categories, ['docs']);
  assert.equal(summary.auditEntries[0].fast_merge_authorized_head_sha, 'sha-live-803');
  assert.equal(typeof summary.auditEntries[0].authorized_at, 'string');
});

test('fast-merge watcher: multiple categories are captured in skip audit and labels_json', () => {
  const labels = [{ name: 'fast-merge:docs' }, { name: 'fast-merge:submodule-bump' }];
  const summary = runWatcherScenario({
    subjects: [subject(804, { labels })],
    labels: { 804: labels },
    heads: { 804: 'sha-live-804' },
    timelineEvents: {
      804: [
        timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z'),
        timelineLabel('fast-merge:submodule-bump', '2026-05-20T12:00:06.000Z'),
      ],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'fast_merge_skipped');
  assert.deepEqual(JSON.parse(summary.rows[0].labels_json), labels);
  assert.deepEqual(summary.auditEntries[0].categories, ['docs', 'submodule-bump']);
});

test('fast-merge watcher: post-label head advance falls back to normal review', () => {
  const summary = runWatcherScenario({
    subjects: [subject(809, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 809: [{ name: 'fast-merge:docs' }] },
    heads: { 809: 'sha-live-809' },
    timelineEvents: {
      809: [
        timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z'),
        timelineForcePush('2026-05-20T12:00:06.000Z', 'sha-live-809'),
      ],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, null);
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries.length, 0);
});

test('fast-merge watcher: same-timestamp head advance after label invalidates label', () => {
  const summary = runWatcherScenario({
    subjects: [subject(812, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 812: [{ name: 'fast-merge:docs' }] },
    heads: { 812: 'sha-live-812' },
    timelineEvents: {
      812: [
        timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z'),
        timelineCommitted('2026-05-20T12:00:05.000Z', 'sha-live-812'),
      ],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.spawns.length, 1);
});

test('fast-merge watcher: category shape mismatch audits and falls back to normal review', () => {
  const summary = runWatcherScenario({
    subjects: [subject(813, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 813: [{ name: 'fast-merge:docs' }] },
    heads: { 813: 'sha-live-813' },
    changedFiles: {
      813: [{ filename: 'src/watcher.mjs', status: 'modified', additions: 2, deletions: 0 }],
    },
    timelineEvents: {
      813: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries[0].action, 'would-have-skipped-shape-mismatch');
  assert.equal(summary.auditEntries[0].shape_check.ok, false);
  assert.match(summary.auditEntries[0].shape_check.reason, /src\/watcher\.mjs/);
});

test('fast-merge watcher: docs category rejects extensionless docs-path runtime files', () => {
  const summary = runWatcherScenario({
    subjects: [subject(818, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 818: [{ name: 'fast-merge:docs' }] },
    heads: { 818: 'sha-live-818' },
    changedFiles: {
      818: [{ filename: 'docs/render', status: 'modified', additions: 1, deletions: 0 }],
    },
    timelineEvents: {
      818: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries[0].action, 'would-have-skipped-shape-mismatch');
});

test('fast-merge watcher: submodule category only allows known gitlink paths', () => {
  const known = runWatcherScenario({
    subjects: [subject(819, { labels: [{ name: 'fast-merge:submodule-bump' }] })],
    labels: { 819: [{ name: 'fast-merge:submodule-bump' }] },
    heads: { 819: 'sha-live-819' },
    changedFiles: {
      819: [{ filename: 'tools/adversarial-review', status: 'modified', additions: 1, deletions: 1 }],
    },
    timelineEvents: {
      819: [timelineLabel('fast-merge:submodule-bump', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(known.rows[0].pr_state, 'fast_merge_skipped');
  assert.equal(known.rows[0].review_status, 'fast_merge_skipped');

  const unknown = runWatcherScenario({
    subjects: [subject(820, { labels: [{ name: 'fast-merge:submodule-bump' }] })],
    labels: { 820: [{ name: 'fast-merge:submodule-bump' }] },
    heads: { 820: 'sha-live-820' },
    changedFiles: {
      820: [{ filename: 'scripts/runtime', status: 'modified', additions: 1, deletions: 1 }],
    },
    timelineEvents: {
      820: [timelineLabel('fast-merge:submodule-bump', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(unknown.rows[0].pr_state, 'open');
  assert.equal(unknown.rows[0].review_status, 'posted');
  assert.equal(unknown.auditEntries[0].action, 'would-have-skipped-shape-mismatch');
});

test('fast-merge watcher: spec hash category allows small rebind deletions', () => {
  const summary = runWatcherScenario({
    subjects: [subject(821, { labels: [{ name: 'fast-merge:spec-hash-rebind' }] })],
    labels: { 821: [{ name: 'fast-merge:spec-hash-rebind' }] },
    heads: { 821: 'sha-live-821' },
    changedFiles: {
      821: [{ filename: 'SPEC.md', status: 'modified', additions: 2, deletions: 2 }],
    },
    timelineEvents: {
      821: [timelineLabel('fast-merge:spec-hash-rebind', '2026-05-20T12:00:05.000Z')],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'fast_merge_skipped');
  assert.equal(summary.rows[0].review_status, 'fast_merge_skipped');
});

test('fast-merge watcher: veto wins on open and veto-only is normal review', () => {
  const summary = runWatcherScenario({
    subjects: [
      subject(805, { labels: [{ name: 'fast-merge:docs' }, { name: 'fast-merge-veto' }] }),
      subject(806, { labels: [{ name: 'fast-merge-veto' }] }),
    ],
    labels: {
      805: [{ name: 'fast-merge:docs' }, { name: 'fast-merge-veto' }],
      806: [{ name: 'fast-merge-veto' }],
    },
    heads: { 805: 'sha-live-805', 806: 'sha-live-806' },
  }, { skipEnabled: true });
  assert.deepEqual(summary.rows.map((row) => row.pr_state), ['open', 'open']);
  assert.deepEqual(summary.rows.map((row) => row.review_status), ['posted', 'posted']);
  assert.equal(summary.spawns.length, 2);
  assert.equal(summary.auditEntries.length, 0);
});

test('fast-merge watcher: unknown label actor does not authorize a live head', () => {
  const summary = runWatcherScenario({
    subjects: [subject(810, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 810: [{ name: 'fast-merge:docs' }] },
    heads: { 810: 'sha-live-810' },
    timelineEvents: {
      810: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z', { actor: 'random-contributor' })],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, null);
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries.length, 0);
});

test('fast-merge watcher: real commit event before label does not block omitted commit_id', () => {
  const summary = runWatcherScenario({
    subjects: [subject(811, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 811: [{ name: 'fast-merge:docs' }] },
    heads: { 811: 'sha-live-811' },
    timelineEvents: {
      811: [
        timelineCommitted('2026-05-20T12:00:04.000Z', 'sha-live-811'),
        timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z'),
      ],
    },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'fast_merge_skipped');
  assert.equal(summary.rows[0].review_status, 'fast_merge_skipped');
  assert.equal(summary.rows[0].fast_merge_authorized_head_sha, 'sha-live-811');
  assert.equal(summary.spawns.length, 0);
  assert.equal(summary.auditEntries[0].fast_merge_authorized_head_sha, 'sha-live-811');
});

test('fast-merge watcher: veto added after skip requeues through pending and the normal CAS claims it', () => {
  const labels = [{ name: 'fast-merge:docs' }, { name: 'fast-merge-veto' }];
  const summary = runWatcherScenario({
    seedRows: [{
      repo: REPO,
      prNumber: 807,
      reviewedAt: '2026-05-20T11:00:00.000Z',
      reviewer: 'claude',
      prState: 'fast_merge_skipped',
      reviewStatus: 'fast_merge_skipped',
      labels: [{ name: 'fast-merge:docs' }],
      fastMergeAuthorizedHeadSha: 'sha-live-807',
    }],
    subjects: [subject(807, { labels })],
    labels: { 807: labels },
    heads: { 807: 'sha-live-807' },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.rows[0].reviewer_head_sha, 'sha-subject-807');
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries[0].action, 'veto-requeued');
  assert.equal(summary.auditEntries[0].requeue_result.status, 'pending');
});

test('fast-merge watcher: removed fast-merge label requeues skipped row', () => {
  const summary = runWatcherScenario({
    seedRows: [{
      repo: REPO,
      prNumber: 814,
      reviewedAt: '2026-05-20T11:00:00.000Z',
      reviewer: 'claude',
      prState: 'fast_merge_skipped',
      reviewStatus: 'fast_merge_skipped',
      labels: [{ name: 'fast-merge:docs' }],
      fastMergeAuthorizedHeadSha: 'sha-live-814',
    }],
    subjects: [subject(814, { labels: [] })],
    labels: { 814: [] },
    heads: { 814: 'sha-live-814' },
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'open');
  assert.equal(summary.rows[0].review_status, 'posted');
  assert.equal(summary.spawns.length, 1);
  assert.equal(summary.auditEntries[0].action, 'label-removed-requeued');
  assert.equal(summary.auditEntries[0].requeue_result.status, 'pending');
});

test('fast-merge watcher: skip audit failure leaves retry sentinel on row', () => {
  const summary = runWatcherScenario({
    subjects: [subject(815, { labels: [{ name: 'fast-merge:docs' }] })],
    labels: { 815: [{ name: 'fast-merge:docs' }] },
    heads: { 815: 'sha-live-815' },
    timelineEvents: {
      815: [timelineLabel('fast-merge:docs', '2026-05-20T12:00:05.000Z')],
    },
    failAuditWrites: true,
  }, { skipEnabled: true });
  assert.equal(summary.rows[0].pr_state, 'fast_merge_skipped');
  assert.equal(summary.rows[0].review_status, 'fast_merge_skipped');
  assert.equal(summary.rows[0].fast_merge_audit_status, 'pending');
  assert.match(summary.rows[0].fast_merge_audit_error, /fixture audit write failed/);
  assert.equal(summary.auditEntries.length, 0);
});

test('fast-merge label creation script is idempotent against create-then-edit gh behavior', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'fast-merge-labels-'));
  try {
    const ghPath = path.join(tmp, 'gh');
    const logPath = path.join(tmp, 'gh.log');
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${logPath}"
if [[ "$1 $2" == "label create" ]]; then
  exit 1
fi
exit 0
`);
    const chmod = spawnSync('chmod', ['+x', ghPath], { encoding: 'utf8' });
    assert.equal(chmod.status, 0, chmod.stderr);
    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync('bash', ['scripts/create-fast-merge-labels.sh', REPO], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}` },
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    }
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /label create fast-merge:docs --repo laceyenterprises\/agent-os/);
    assert.match(log, /label create ticket-pipeline-paused --repo laceyenterprises\/agent-os/);
    assert.match(log, /label create no-merge-hold --repo laceyenterprises\/agent-os/);
    assert.match(log, /label edit fast-merge:docs --repo laceyenterprises\/agent-os/);
    assert.doesNotMatch(log, /fast-merge:additive-sql/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fast-merge label creation script discovers all non-archived repos when no repo is provided', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'fast-merge-labels-all-'));
  try {
    const ghPath = path.join(tmp, 'gh');
    const logPath = path.join(tmp, 'gh.log');
    writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${logPath}"
if [[ "$1 $2" == "repo list" ]]; then
  printf '%s\\n' 'laceyenterprises/agent-os' 'laceyenterprises/adversarial-review'
fi
exit 0
`);
    const chmod = spawnSync('chmod', ['+x', ghPath], { encoding: 'utf8' });
    assert.equal(chmod.status, 0, chmod.stderr);
    const result = spawnSync('bash', ['scripts/create-fast-merge-labels.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /repo list laceyenterprises --limit 1000/);
    assert.match(log, /label create fast-merge:docs --repo laceyenterprises\/agent-os/);
    assert.match(log, /label create fast-merge:docs --repo laceyenterprises\/adversarial-review/);
    assert.match(log, /label create no-merge-hold --repo laceyenterprises\/agent-os/);
    assert.match(log, /label create no-merge-hold --repo laceyenterprises\/adversarial-review/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fast-merge migration adds authorization column and rereview helper requeues skipped rows idempotently', () => {
  const db = new Database(':memory:');
  try {
    ensureReviewStateSchema(db);
    ensureReviewStateSchema(db);
    const columns = db.prepare('PRAGMA table_info(reviewed_prs)').all().map((column) => column.name);
    assert.ok(columns.includes('fast_merge_authorized_head_sha'));
    assert.ok(columns.includes('fast_merge_audit_status'));
    assert.ok(columns.includes('fast_merge_audit_payload_json'));
    assert.ok(columns.includes('fast_merge_audit_error'));
    db.prepare(
      `INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, fast_merge_authorized_head_sha)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(REPO, 808, '2026-05-20T12:00:00.000Z', 'claude', 'fast_merge_skipped', 'fast_merge_skipped', 'sha-live-808');
    const result = requestReviewRereview({
      rootDir: REPO_ROOT,
      repo: REPO,
      prNumber: 808,
      reason: 'test fast-merge veto',
      allowFastMergeSkipped: true,
      db,
    });
    assert.equal(result.triggered, true);
    const row = db.prepare('SELECT pr_state, review_status, failed_at, posted_at FROM reviewed_prs WHERE pr_number = 808').get();
    assert.equal(row.pr_state, 'open');
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failed_at, null);
    assert.equal(row.posted_at, null);
  } finally {
    db.close();
  }
});
