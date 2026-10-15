import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
    AGENT_OS_HQ_BIN: '/usr/bin/false',
    GH_CLAUDE_REVIEWER_TOKEN: '',
    GH_CODEX_REVIEWER_TOKEN: '',
    GH_GEMINI_REVIEWER_TOKEN: '',
    AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false',
    ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: '',
    AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '6',
    ADVERSARIAL_REVIEWER_DISPATCH_SINGLE_WAVE_SETTLE_GRACE_MS: '60000',
    ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
    WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '1',
    ...overrides,
  };
}

function installGhFixture(tmp) {
  const ghPath = path.join(tmp, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == api && "\${2:-}" == repos/laceyenterprises/adversarial-review/pulls/101 ]]; then
  printf '{"state":"open","draft":false,"labels":[],"changed_files":1,"head":{"sha":"%s"}}\\n' "\${WATCHER_CLAIM_LOOP_FIXTURE_HEAD_101:-}"
  exit 0
fi
if [[ "\${1:-}" == "api" && "\${2:-}" =~ ^repos/[^/]+/[^/]+/commits/(.+)$ ]]; then
  sha="\${BASH_REMATCH[1]}"
  printf '{"sha":"%s","message":"Fixture commit","committerLogin":null,"authorLogin":null,"committerName":"Fixture Worker","committerEmail":"fixture@example.com"}\\n' "$sha"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "view" ]]; then
  printf '{"headRefOid":null,"statusCheckRollup":[{"__typename":"CheckRun","name":"fixture-ci","conclusion":"SUCCESS"}]}\\n'
  exit 0
fi
echo "unexpected gh fixture call: $*" >&2
exit 1
`);
  chmodSync(ghPath, 0o755);
  return { PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}` };
}

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

const DEFAULT_FOLLOW_UP_JOBS_SOURCE = "export const FOLLOW_UP_JOB_DIRS = { pending: 'pending', inProgress: 'in-progress', completed: 'completed', failed: 'failed', stopped: 'stopped', workspaces: 'workspaces', stoppedArchived: 'stopped-archived' }; export function classifyFollowUpCriticality() { return { critical: false, blockingFindingCount: 0, blockingFindingState: 'known', verdict: 'comment-only' }; } export function createFollowUpJob() { return { jobPath: '/tmp/watcher-claim-loop-follow-up.json' }; } export function listFollowUpJobsInDir() { return []; } export function listInProgressFollowUpJobs() { return []; } export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; } export const PUBLIC_REPLY_MAX_CHARS = 1200; export function detectPublicReplyNoiseSignal() { return null; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); } export function isSettledReviewJob() { return false; } export function markFollowUpJobStopped() { return { status: 'stopped' }; } export function requeueFollowUpJobForNextRound() { return { requeued: false }; } export function markFollowUpJobFailed() { return { status: 'failed' }; } export function requeueInProgressFollowUpJobForRetry() { return { requeued: false }; } export function stopPendingNoRemediationJobs() { return []; } export function writeFollowUpJob() {} export function voidSingleReviewCredit() { return { voided: false }; }";

function buildLoaderSource({
  capRouteSource = null,
  discoveryHookSource = '',
  subjectHeads = {},
  subject101Overrides = {},
  subjectRevisionRefs = {},
  followUpJobsSource = DEFAULT_FOLLOW_UP_JOBS_SOURCE,
  reviewerRuntimeSource = "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
  followUpMergeAgentSource = "export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export async function applyMergeAgentStuckLabel() { return false; } export async function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export function resolveFastMergePerPollCap() { return 5; } export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export function scanStuckMergeAgentDispatches() { return []; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {} export function isScopedMergeAgentRequest() { return false; }",
} = {}) {
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const reviewStateActualUrl = `${reviewStateUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');

  const stubs = {
    ...(capRouteSource ? { [fileUrl('src', 'review-cycle-cap-hammer.mjs')]: 'fixture:cap-route' } : {}),
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [fileUrl('src', 'adapters', 'operator', 'index.mjs')]: 'fixture:operator-surface',
    [fileUrl('src', 'adapters', 'reviewer-runtime', 'index.mjs')]: 'fixture:reviewer-runtime',
    [fileUrl('src', 'branch-protection.mjs')]: 'fixture:branch-protection',
    [fileUrl('src', 'adversarial-gate-status.mjs')]: 'fixture:adversarial-gate-status',
    [fileUrl('src', 'adversarial-gate-context.mjs')]: 'fixture:adversarial-gate-context',
    [fileUrl('src', 'duplicate-family-state.mjs')]: 'fixture:duplicate-family-state',
    ...(process.env.FIXTURE_THROW_HELDHEAD_REQUEST === '1' ? { [fileUrl('src', 'comment-only-final-round.mjs')]: 'fixture:heldhead' } : {}),
    [fileUrl('src', 'follow-up-jobs.mjs')]: 'fixture:follow-up-jobs',
    [fileUrl('src', 'remediation-published-head.mjs')]: 'fixture:remediation-published-head',
    [fileUrl('src', 'remediation-prompt.mjs')]: 'fixture:remediation-prompt',
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
    [fileUrl('src', 'hcp-health.mjs')]: 'fixture:hcp-health',
    [fileUrl('src', 'gh-cli.mjs')]: 'fixture:gh-cli',
    [fileUrl('src', 'head-closer-commit-suppression.mjs')]: 'fixture:head-closer-commit-suppression',
    [fileUrl('src', 'ama', 'ham-provenance.mjs')]: 'fixture:ama-ham-provenance',
    [fileUrl('src', 'session-ledger-read-adapter.mjs')]: 'fixture:session-ledger-read-adapter',
  };

  return `
const capRouteSource = ${JSON.stringify(capRouteSource)};
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
  if (url === 'fixture:cap-route') return { format: 'module', shortCircuit: true, source: capRouteSource };
  if (url === 'fixture:heldhead') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
      export function hasInProgressCommentOnlyFinalRound() { return false; }
      export function hasCommentOnlyFinalRoundPush() { return false; }
      export function hasUnprovenCommentOnlyFinalRoundHead() { return false; }
      export function hasSettledCommentOnlyReviewHead() { return false; }
      export function scanArchivedStoppedFollowUpJobs() { return []; }
      export function findFinalRoundJobForProvenPush() { return null; }
      export function proveCommentOnlyFinalRoundHead() { return false; }
      export function suppressFinalRoundFollowUp() { return false; }
      export function withheldHeadRecoveryCandidates(root, options) { return options.prNumber === 101 ? [{ job: { completion: {} } }] : []; }
      export function recoverWithheldFinalRoundHead(options) { return options.request({ automaticWithheldHeadRecovery: true }); }
    `)} };
  }
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
        export function requestReviewRereview(options) {
          if (process.env.FIXTURE_THROW_HELDHEAD_REQUEST === '1' && options.automaticWithheldHeadRecovery) {
            throw new Error('fixture held-head request failure');
          }
          return actual.requestReviewRereview(options);
        }
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
        const subjectHeadOverrides = ${JSON.stringify(subjectHeads)};
        const subjectRevisionRefOverrides = ${JSON.stringify(subjectRevisionRefs)};
        const subjects = [
          {
            ref: {
              domainId: 'code-pr',
              subjectExternalId: REPO + '#101',
              revisionRef: subjectRevisionRefOverrides['101'] || subjectHeadOverrides['101'] || 'sha-happy-101',
            },
            lifecycle: 'pending-review',
            title: '[codex] LAC-636 happy path runtime claim',
            authorRef: 'codex-worker',
            builderClass: 'codex',
            labels: ['risk:medium'],
            updatedAt: '2026-05-15T12:00:00.000Z',
            headSha: subjectHeadOverrides['101'] || 'sha-happy-101',
            ...${JSON.stringify(subject101Overrides)},
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

        process.env.WATCHER_CLAIM_LOOP_FIXTURE_HEAD_101 = subjects[0].headSha;

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

        export function createGitHubPRSubjectAdapter({ octokit, repos } = {}) {
          return {
            async discoverSubjects() {
              ${discoveryHookSource}
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
              const nextHead = globalThis.__watcherClaimLoopSubjectHead;
              return nextHead && ref.subjectExternalId.endsWith('#101')
                ? { ...subject, headSha: nextHead, ref: { ...subject.ref, revisionRef: nextHead } }
                : { ...subject, ref: { ...subject.ref } };
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
    'fixture:remediation-published-head': "export function completeWorkerPublishedHead() { return null; } export function completeLiveWorkerPublishedHead() { return null; } export function completeKnownWorkerPublish() { return null; } export function findWorkerPublishedHead() { return null; } export function hasWorkerPublishArtifacts() { return false; } export function buildRereviewResult() { return {}; }",
    'fixture:session-ledger-read-adapter': ${JSON.stringify(`export * from '${fileUrl('src', 'session-ledger-read-adapter.mjs')}?actual'; export function readPrBuilderProvenance({ prNumber }) { return globalThis.__watcherClaimLoopProvenance?.(prNumber) || { ok: false, reason: 'missing-builder-provenance' }; }`)},
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function fetchAdversarialGateBranchProtection() {} export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function readGateRecord() { return globalThis.__budgetGateRecord || null; } export function resolveSettledReviewVerdict() { return globalThis.__holdReleaseSettled || { verdict: '', remediationPending: false }; } export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; } export function deleteGateRecordsForPR() {} export function pickAdversarialGateStatus() { return { state: 'pending', reason: 'fixture', context: 'agent-os/adversarial-gate' }; } export async function projectAdversarialGateStatus() { globalThis.__holdReleaseGateProjections = (globalThis.__holdReleaseGateProjections || 0) + 1; return { decision: { state: 'pending', reason: 'fixture' } }; } export async function publishAdversarialGateStatus() { return { posted: true }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:duplicate-family-state': "export function duplicateFamilySchemaTableNames() { return []; } export function ensureDuplicateFamilySchema() {} export async function runDuplicateFamilyCensusForWatcher() { return { families: [], familyIds: [] }; } export async function reconcileDuplicateFamilyLabels() { return { inspected: 0, changed: 0 }; }",
    'fixture:follow-up-jobs': ${JSON.stringify(followUpJobsSource)},
    'fixture:remediation-prompt': "export function followUpJobRepoPrKey(job) { return String(job?.repo || '').toLowerCase() + '#' + (job?.prNumber || ''); }",
    'fixture:follow-up-merge-agent': ${JSON.stringify(followUpMergeAgentSource)},
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function reportStalledRetriggerOutcomes() { return { checked: 0, spawned: 0, reported: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 3; export function classifyReviewerFailure() { return 'unknown'; } export function clearCascadeState() {} export function clearReviewerCredentialOutage() { return null; } export function formatTransientFailureBreakdown() { return ''; } export function hasOperatorDecisionRequiredAlerted() { return false; } export function isReviewerSubprocessTimeout() { return false; } export function markCascadeCapExhaustedAlerted() { return { marked: true, state: {} }; } export function markOperatorDecisionRequiredAlerted() { return { marked: true, state: {} }; } export function readCascadeState() { return null; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function recordReviewerCredentialFailure() { return { active: false }; } export function recordTokenRefreshHold() { return { tokenRefreshHold: {} }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; } export function releaseReviewerCredentialProbe() { return false; } export function shouldPauseReviewerModel() { return { paused: false }; }",
    'fixture:reviewer-reattach': "export function makeReviewPostedProbe() { return async () => null; } export function reviewerBotLogin(reviewer) { return reviewer ? 'codex-reviewer-lacey' : null; } export function probeReviewerSession() { return { alive: false, matched: false }; } export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export const REVIEWER_PROCESS_SLACK_MS = 300000; export function resolveReviewerTimeoutMs() { return 300000; } export function resolveProgressTimeoutMs() { return 300000; } export function resolveAgyReviewerSubprocessTimeoutMs() { return 300000; } export function resolveGeminiReviewerProcessTimeoutMs() { return 300000; }",
    'fixture:reviewer-broker-refresh': "globalThis.__watcherClaimLoopBrokerRefreshes = 0; export async function refreshReviewerBrokerTokens() { globalThis.__watcherClaimLoopBrokerRefreshes += 1; return { refreshed: 0, failed: 0, skipped: 3 }; } export async function refreshWatcherGithubToken() { return { refreshed: false, reason: 'fixture' }; } export function resolveWatcherGhBrokerRole() { return 'merge-agent'; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed-title path'); }",
    'fixture:watcher-memory-pressure': "export async function checkReviewerMemoryAdmission() { return { admit: true, reason: null, sample: { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }, projectedHeadroomMb: 999999, availableMb: 999999, swapUsedPct: 0, estimatedReviewerRssMb: 0, reservedMb: 0 }; } export function peakReviewerMemoryMbFor() { return 0; } export async function readMemoryPressureSample() { return { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }; }",
    'fixture:github-api': "export async function fetchPullRequestRollup() { throw new Error('unexpected github rollup call'); } export async function fetchPullRequestHeadAndState(_repo, prNumber) { const overrides = globalThis.__watcherClaimLoopFreshHeads || {}; const headRefOid = Object.prototype.hasOwnProperty.call(overrides, String(prNumber)) ? overrides[String(prNumber)] : ('sha-happy-' + prNumber); return { state: 'open', mergedAt: null, closedAt: null, headRefOid, labels: [] }; } export async function fetchPullRequestMergeability() { return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }; } export async function fetchReviewBodiesForHead() { return []; } export async function fetchSubmittedReviewsForHead() { return []; } export async function dismissStandingChangesRequestedReviewsForHead() { return { attempted: 0, dismissed: [], standing: [] }; } export async function fetchPullRequestCommitSubjects() { return []; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
    'fixture:hcp-health': "export async function checkHcpHealthz() { return { ready: true, reason: 'fixture' }; }",
    'fixture:gh-cli': "export const GH_LOOKUP_MAX_BUFFER = 26214400; export const GH_LOOKUP_TIMEOUT_MS = 30000; export function buildAllowlistedGhEnv(env = process.env) { return { ...env }; } export async function execGhWithRetry({ execFileImpl, args } = {}) { return execFileImpl('gh', args); } export function isTransientGhError() { return false; } export function parseDate(value) { return value ? new Date(value) : null; } export function parseJsonLines(stdout) { return String(stdout || '').split('\\\\n').filter(Boolean).map((line) => JSON.parse(line)); }",
    'fixture:head-closer-commit-suppression': "import { existsSync } from 'node:fs'; import path from 'node:path'; export function createHeadCloserCommitSuppressionResolver() { return async () => ({ suppressed: false, reason: 'fixture' }); } export async function getHeadCloserCommitSuppression() { return { suppressed: false, reason: 'fixture' }; } export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: false, reason: 'fixture' }; } export async function fetchHeadCloserVerifiedCommit() { return null; } export async function proveCloserOnlyHeadDelta() { return false; } export async function fetchVerifiedCommitFromLocalGit({ repoPath, headSha, hqRoot } = {}) { const checkout = await resolveLocalRepoCheckout(repoPath, hqRoot); return checkout ? { sha: headSha, message: 'Fixture commit' } : null; } export function buildNonReviewableHeadDeltaEvidence() { return { status: 'not-applicable', reason: 'fixture' }; } export function isTerminalCloserCommitIdentity() { return false; } export function isTransientLocalGitError() { return false; } export async function resolveLocalRepoCheckout(repoPath, hqRoot) { const repoName = String(repoPath || '').split('/').pop(); const root = String(hqRoot || '').trim(); if (!repoName || !root) return null; const checkout = path.join(root, 'repos', repoName); return existsSync(path.join(checkout, '.git')) ? checkout : null; }",
    'fixture:ama-ham-provenance': "export const HAM_AUDIT_COMMENT_AUTHOR_LOGINS = new Set(); export function hamAuditCommentAuthorMatches() { return false; } export function hamCommitIdentityMatches() { return false; } export function parseCommitTrailers() { return {}; } export function parseCommitTrailerValues() { return {}; } export function parseRemediatedFindingsTrailer() { return null; } export function isHamWorkerTicket() { return false; }",
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

function buildRunnerSource({
  expectPollError = false,
  freshHeads = {},
  prePollSetup = '',
  afterFirstPoll = '',
  healthProbeSetup = '',
} = {}) {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';

const githubCalls = [];
const githubWrites = [];
const fetchCalls = [];
const claims = [];
globalThis.__watcherClaimLoopFreshHeads = ${JSON.stringify(freshHeads)};
globalThis.fetch = async (...args) => {
  fetchCalls.push(args.map(String));
  throw new Error('unexpected fetch call from watcher claim-loop test');
};
function readRows(db) {
  const rows = db.prepare(
    'SELECT repo, pr_number, domain_id, subject_external_id, revision_ref, review_status, reviewer_head_sha, codex_broker_provider FROM reviewed_prs ORDER BY pr_number'
  ).all();
  return Object.fromEntries(rows.map((row) => [String(row.pr_number), row]));
}

function readPassRows(db) {
  return db.prepare(
    'SELECT repo, pr_number, attempt_number, pass_kind, status, workspace_path, token_input, token_output, token_cache_read, token_cache_write, token_total, token_source, metadata_json FROM reviewer_passes ORDER BY pr_number, pass_id'
  ).all();
}

try {
  const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
  const db = globalThis.__watcherClaimLoopDb;
  assert.ok(db, 'watcher should have opened the synthetic in-memory DB');
  ${prePollSetup}
  const insert = db.prepare(
    \`INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?)\`
  );
  for (const [prNumber, reviewer] of [[102, 'claude']]) {
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
          if (property === 'listLabelsOnIssue') {
            return async (params) => {
              githubCalls.push({ kind: 'issues.listLabelsOnIssue', params });
              return { data: [] };
            };
          }
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
    const pollOptions = {
      healthProbe: {
        beginTick() { return {}; },
        recordOpenPending() {},
        recordSpawn() {},
        async finishTick() {},
      },
      afterClaim(payload) {
        claims.push(payload);
      },
    };
    ${healthProbeSetup}
    await pollOnce(octokit, pollOptions);
    ${afterFirstPoll}
  } catch (err) {
    pollError = err;
  }

  if (${expectPollError ? 'pollError === null' : 'pollError !== null'}) {
    throw pollError || new Error('expected watcher pollOnce to throw');
  }

  console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
    rows: readRows(db),
    fsrRows: db.prepare(
      'SELECT pr_number, review_status, reviewer_head_sha, revision_ref, rereview_requested_at, rereview_reason FROM reviewed_prs ORDER BY pr_number'
    ).all(),
    reviewerPassRows: readPassRows(db),
    claims,
    githubCalls,
    githubWrites,
    fetchCalls,
    operatorWrites: globalThis.__watcherClaimLoopOperatorWrites || [],
    reviewerSpawns: globalThis.__watcherClaimLoopReviewerSpawns || [],
    brokerRefreshes: globalThis.__watcherClaimLoopBrokerRefreshes || 0,
    pollError: pollError ? String(pollError.message || pollError) : null,
    depthDiagnostics: globalThis.__watcherDepthDiagnostics || null,
  }));
} catch (err) {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
}
`;
}

function buildSameHeadRepeatRunnerSource() {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';

const githubCalls = [];
globalThis.fetch = async (...args) => {
  throw new Error('unexpected fetch call from watcher same-head repeat test: ' + args.map(String).join(' '));
};

try {
  const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
  const db = globalThis.__watcherClaimLoopDb;
  assert.ok(db, 'watcher should have opened the synthetic in-memory DB');
  db.prepare(
    \`INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?)\`
  ).run(
    'laceyenterprises/adversarial-review',
    101,
    '2026-07-12T18:00:00.000Z',
    'claude',
    'open',
    'pending',
    0
  );

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
          return {
            data: {
              number: params.pull_number,
              state: 'open',
              merged_at: null,
              closed_at: null,
              head: { sha: 'sha-happy-' + params.pull_number },
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
          return async () => {
            throw new Error('unexpected GitHub issues write: ' + String(property));
          };
        },
      }),
    },
    request: async (...args) => {
      throw new Error('unexpected octokit.request call: ' + args.map(String).join(' '));
    },
  };

  const pollOptions = {
    healthProbe: {
      beginTick() { return {}; },
      recordOpenPending() {},
      recordSpawn() {},
      async finishTick() {},
    },
  };

  await pollOnce(octokit, pollOptions);
  const afterFirst = db.prepare(
    'SELECT review_status, reviewer_head_sha FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
  ).get('laceyenterprises/adversarial-review', 101);
  assert.equal(afterFirst.review_status, 'posted');
  assert.equal(afterFirst.reviewer_head_sha, 'sha-happy-101');

  db.prepare(
    \`UPDATE reviewed_prs
        SET review_status = 'pending',
            rereview_requested_at = NULL,
            rereview_reason = NULL
      WHERE repo = ? AND pr_number = ?\`
  ).run('laceyenterprises/adversarial-review', 101);

  await pollOnce(octokit, pollOptions);

  const spawns = globalThis.__watcherClaimLoopReviewerSpawns || [];
  console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
    spawns101: spawns.filter((spawn) => spawn?.subjectContext?.prNumber === 101),
    allSpawns: spawns.map((spawn) => ({
      prNumber: spawn?.subjectContext?.prNumber,
      reviewerHeadSha: spawn?.subjectContext?.reviewerHeadSha,
    })),
    row101: db.prepare(
      'SELECT review_status, reviewer_head_sha FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 101),
    passRows101: db.prepare(
      'SELECT pr_number, attempt_number, pass_kind, status FROM reviewer_passes WHERE repo = ? AND pr_number = ? ORDER BY pass_id'
    ).all('laceyenterprises/adversarial-review', 101),
    githubCalls,
  }));
} catch (err) {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
}

`;
}

test('queued bounce retry loses the claim when reconciliation observes a newer failed bounce session', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-bounce-race-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    const bounceUrl = fileUrl('src', 'daemon-bounce-recovery.mjs');
    const recoverySource = `
      import { reconcileDaemonBounceBeforeRetry as actual } from ${JSON.stringify(`${bounceUrl}?actual`)};
      export * from ${JSON.stringify(`${bounceUrl}?actual`)};
      export async function reconcileDaemonBounceBeforeRetry(args) {
        const result = await actual({ ...args, isAlive: () => false, sleep: async () => {},
          findPostedReview: async () => {
            globalThis.__watcherClaimLoopDb.prepare(\`UPDATE reviewed_prs
              SET review_status = 'failed', reviewer_session_uuid = 'bounce-B',
                  reviewer_started_at = '2026-10-10T16:50:00.000Z',
                  failed_at = '2026-10-10T16:51:00.000Z', reviewer_pgid = 8181
              WHERE pr_number = 101\`).run();
            return null;
          },
        });
        globalThis.__bounceRecoveryResult = result;
        return result;
      }
    `;
    const loader = buildLoaderSource().replace('  return nextLoad(url, context);', `
      if (url === ${JSON.stringify(bounceUrl)}) {
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(recoverySource)} };
      }
      return nextLoad(url, context);
    `);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      prePollSetup: `
        db.prepare(\`INSERT INTO reviewed_prs
          (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
           reviewer_head_sha, reviewer_session_uuid, reviewer_started_at,
           reviewer_pgid, failed_at, failure_message)
          VALUES ('laceyenterprises/adversarial-review', 101, '2026-10-10',
            'claude', 'open', 'failed', 'sha-happy-101', 'bounce-A',
            '2026-10-10T16:40:00.000Z', 7171, '2026-10-10T16:41:00.000Z',
            '[daemon-bounce] Reviewer interrupted')\`).run();
      `,
      afterFirstPoll: `
        assert.equal(globalThis.__bounceRecoveryResult.handled, false);
        assert.equal(globalThis.__bounceRecoveryResult.reason, 'dead-no-posted-review');
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
        assert.equal(row.review_status, 'failed');
        assert.equal(row.reviewer_session_uuid, 'bounce-B');
        assert.equal(row.reviewer_pgid, 8181);
        assert.equal(row.reviewer_started_at, '2026-10-10T16:50:00.000Z');
        assert.equal(row.failed_at, '2026-10-10T16:51:00.000Z');
        assert.equal(row.infra_auto_recover_attempts, 0);
        assert.ok(!claims.some(claim => claim.prNumber === 101));
        assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || [])
          .some(spawn => spawn.subjectContext?.prNumber === 101));
      `,
    }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

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
  resolveReviewerRuntimeAdapterForDomainId,
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

const secondaryCreates = [];
let secondaryMtime = 10;
const secondaryOptions = {
  rootDir: '/tmp/secondary-adapter-cache-test',
  logger,
  loadDomainConfigImpl: (_rootDir, domainId) => ({ id: domainId }),
  createAdapterImpl: ({ domainId, domainConfig }) => {
    const adapter = { domainId, domainConfig, sequence: secondaryCreates.length + 1 };
    secondaryCreates.push(adapter);
    return adapter;
  },
  domainMtimeImpl: () => secondaryMtime,
};
const secondaryFirst = resolveReviewerRuntimeAdapterForDomainId('secondary-domain', secondaryOptions);
const secondarySecond = resolveReviewerRuntimeAdapterForDomainId('secondary-domain', secondaryOptions);
assert.equal(secondarySecond, secondaryFirst);
assert.equal(secondaryCreates.length, 1);

secondaryMtime = 11;
const secondaryRefreshed = resolveReviewerRuntimeAdapterForDomainId('secondary-domain', secondaryOptions);
assert.notEqual(secondaryRefreshed, secondaryFirst);
assert.equal(secondaryCreates.length, 2);

mode = 'native';
refreshReviewerRuntimeAdapter({
  logger,
  loadConfigImpl,
  createAdapterImpl,
  domainMtimeImpl: () => mtime,
});
const secondaryModeRefreshed = resolveReviewerRuntimeAdapterForDomainId('secondary-domain', secondaryOptions);
assert.notEqual(secondaryModeRefreshed, secondaryRefreshed);
assert.equal(secondaryCreates.length, 3);

const secondaryRecordAdapter = {
  describe: () => ({ id: 'secondary-record-runtime' }),
};
assert.equal(
  reviewerRuntimeAdapterForRunRecord(
    { runtime: 'secondary-record-runtime', domain: 'secondary-record-domain' },
    { resolveDomainAdapterImpl: () => secondaryRecordAdapter }
  ),
  secondaryRecordAdapter,
);

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

test('REVIEWMODEL-02: watcher never reclaims a terminal model refusal on the same head', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-model-refusal-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      prePollSetup: `
        db.prepare(\`INSERT INTO reviewed_prs
          (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
           reviewer_head_sha, revision_ref, review_attempts, failed_at, failure_message)
          VALUES ('laceyenterprises/adversarial-review', 101, '2026-10-12',
            'gemini', 'open', 'failed', 'sha-happy-101', 'sha-happy-101', 1,
            '2026-10-12T00:00:00Z', '[reviewer-model-unavailable] invalid model selection')\`).run();
      `,
      afterFirstPoll: `
        await pollOnce(octokit, pollOptions);
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
        assert.equal(row.review_status, 'failed');
        assert.equal(row.review_attempts, 1);
        assert.equal(row.infra_auto_recover_attempts, 0);
        assert.ok(!claims.some(claim => claim.prNumber === 101));
        assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || [])
          .some(spawn => spawn.subjectContext.prNumber === 101));
      `,
    }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 20_000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

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
        env: fixtureEnv(installGhFixture(tmp)),
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
    assert.equal(summary.rows['101'].domain_id, 'code-pr');
    assert.equal(summary.rows['101'].subject_external_id, 'laceyenterprises/adversarial-review#101');
    assert.equal(summary.rows['101'].revision_ref, 'sha-happy-101');
    assert.equal(summary.rows['101'].reviewer_head_sha, 'sha-happy-101');
    assert.equal(summary.rows['102'].review_status, 'posted');
    assert.equal(summary.rows['102'].reviewer_head_sha, null);
    assert.equal(summary.rows['101'].codex_broker_provider, null);
    assert.equal(summary.rows['102'].codex_broker_provider, null);
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

for (const [name, failureSource] of [
  ['exhausted transient query', "return { ok: false, reason: 'ledger-read-failed', transient: true, deferClaim: true };"],
  ['permanent missing psql', "return { ok: false, reason: 'psql-not-installed', deferClaim: true };"],
  ['unexpected read exception', "throw new Error('fixture ledger unavailable');"],
]) {
  test(`watcher defers ${name} without claiming and retries provenance on the next tick`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-provenance-defer-'));
    const loaderPath = path.join(tmp, 'fixture-loader.mjs');
    const registerPath = path.join(tmp, 'fixture-register.mjs');
    const runnerPath = path.join(tmp, 'fixture-runner.mjs');
    try {
      writeFileSync(loaderPath, buildLoaderSource());
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({
        prePollSetup: `
          globalThis.__watcherClaimLoopProvenance = prNumber => {
            if (prNumber === 101) { ${failureSource} }
            return { ok: false, reason: 'missing-builder-provenance' };
          };
          db.prepare(\`INSERT INTO reviewed_prs
            (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?)\`).run(
              'laceyenterprises/adversarial-review', 101, '2026-05-15T12:00:00.000Z', 'claude', 'open', 'pending', 0);
        `,
        afterFirstPoll: `
          const parked = db.prepare('SELECT review_status, review_attempts, reviewer FROM reviewed_prs WHERE pr_number = 101').get();
          assert.equal(parked.review_status, 'pending');
          assert.equal(parked.review_attempts, 0);
          assert.equal(parked.reviewer, 'claude');
          assert.ok(!claims.some(claim => claim.prNumber === 101));
          assert.ok(!readPassRows(db).some(row => row.pr_number === 101));
          assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, 1,
            'unrelated PR should still spawn during the provenance outage');
          globalThis.__watcherClaimLoopProvenance = () => ({ ok: true, actualHarness: 'claude-code' });
          await pollOnce(octokit, pollOptions);
        `,
      }));
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)) });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, output);
      const summaryLine = result.stdout.split(/\r?\n/).find(line => line.startsWith(SUMMARY_MARKER));
      assert.ok(summaryLine, output);
      const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
      assert.equal(summary.rows['101'].review_status, 'posted');
      assert.equal(summary.claims.filter(claim => claim.prNumber === 101).length, 1);
      assert.equal(summary.reviewerPassRows.find(row => row.pr_number === 101).attempt_number, 1);
      assert.equal(summary.reviewerSpawns.length, 2);
      assert.equal(summary.reviewerSpawns[1].subjectContext.prNumber, 101);
      assert.equal(summary.reviewerSpawns[1].subjectContext.builderTag, 'claude-code');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('watcher pollOnce refreshes a stale pending revision_ref before reviewer claim', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-stale-pending-head-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      subjectHeads: { 101: 'head-current-1035' },
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      freshHeads: { 101: 'head-current-1035' },
      prePollSetup: `
        db.prepare(
          \`INSERT INTO reviewed_prs
             (repo, pr_number, domain_id, subject_external_id, revision_ref,
              reviewed_at, reviewer, pr_state, review_status, review_attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          'code-pr',
          'laceyenterprises/adversarial-review#101',
          'head-stale-1035',
          '2026-09-11T02:20:00.000Z',
          'gemini',
          'open',
          'pending',
          0
        );
      `,
    }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.rows['101'].revision_ref, 'head-current-1035');
    assert.equal(summary.rows['101'].reviewer_head_sha, 'head-current-1035');
    assert.ok(
      summary.reviewerSpawns.some(
        (spawn) => spawn.subjectContext?.reviewerHeadSha === 'head-current-1035',
      ),
      'reviewer spawn must target the refreshed current head',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher claim preserves canonical revision_ref when it differs from head SHA', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-canonical-revision-ref-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      subjectHeads: { 101: 'git-head-current-1035' },
      subjectRevisionRefs: { 101: 'canonical-review-ref-1035' },
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      freshHeads: { 101: 'git-head-current-1035' },
      prePollSetup: `
        db.prepare(
          \`INSERT INTO reviewed_prs
             (repo, pr_number, domain_id, subject_external_id, revision_ref,
              reviewed_at, reviewer, pr_state, review_status, review_attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          'code-pr',
          'laceyenterprises/adversarial-review#101',
          'canonical-review-ref-stale',
          '2026-09-11T02:20:00.000Z',
          'gemini',
          'open',
          'pending',
          0
        );
      `,
    }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.rows['101'].revision_ref, 'canonical-review-ref-1035');
    assert.equal(summary.rows['101'].reviewer_head_sha, 'git-head-current-1035');
    assert.ok(
      summary.reviewerSpawns.some(
        (spawn) => spawn.subjectContext?.reviewerHeadSha === 'git-head-current-1035',
      ),
      'reviewer spawn must still execute against the raw Git head',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce skips stale terminal rereview pass keys', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-rereview-attempt-key-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-rereview-attempt-key-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      prePollSetup: `
        db.prepare(
          \`INSERT INTO reviewed_prs
             (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
              review_attempts, rereview_requested_at, rereview_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          '2026-08-22T03:31:55.675Z',
          'gemini',
          'open',
          'pending',
          1,
          '2026-08-22T03:47:46.523Z',
          'operator recovery: current head needs re-review'
        );
        db.prepare(
          \`INSERT INTO reviewer_passes
             (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
              pass_kind, started_at, ended_at, status, head_sha, metadata_json, gh_comment_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          1,
          'gemini',
          'gemini',
          'first-pass',
          '2026-08-22T03:32:00.000Z',
          '2026-08-22T03:37:00.000Z',
          'completed',
          'reviewed-head',
          '{}',
          'review-101-1'
        );
        db.prepare(
          \`INSERT INTO reviewer_passes
             (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
              pass_kind, started_at, ended_at, status, head_sha, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          2,
          'gemini',
          'gemini',
          'rereview',
          '2026-08-22T03:38:32.716Z',
          '2026-08-22T03:59:13.357Z',
          'failed',
          'old-remediation-head',
          JSON.stringify({ error: 'refusing to reuse terminal reviewer_passes row' })
        );
      `,
    }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
    const spawn101 = summary.reviewerSpawns.find((spawn) => spawn?.subjectContext?.prNumber === 101);
    assert.ok(spawn101, JSON.stringify(summary, null, 2));
    assert.equal(spawn101?.subjectContext?.passKind, 'rereview');
    assert.equal(spawn101?.subjectContext?.reviewDbAttemptNumber, 3);
    assert.deepEqual(
      summary.reviewerPassRows
        .filter((row) => row.pr_number === 101)
        .map((row) => [row.attempt_number, row.pass_kind, row.status]),
      [
        [1, 'first-pass', 'completed'],
        [2, 'rereview', 'failed'],
        [3, 'rereview', 'completed'],
      ]
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher releases claim and skips reviewer spawn when fresh head moved after claim', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-stale-head-claim-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      freshHeads: { 101: 'sha-new-101' },
    }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.deepEqual(
      summary.claims
        .filter((claim) => claim.prNumber === 101)
        .map((claim) => claim.reviewerHeadSha),
      ['sha-happy-101']
    );
    assert.equal(summary.rows['101'].review_status, 'pending');
    assert.equal(summary.rows['101'].reviewer_head_sha, null);
    assert.deepEqual(
      summary.reviewerSpawns
        .filter((spawn) => spawn?.subjectContext?.prNumber === 101),
      []
    );
    assert.ok(
      summary.reviewerSpawns.some((spawn) => spawn?.subjectContext?.prNumber === 102),
      'other eligible PRs should keep moving'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce does not dispatch a same-head already-reviewed row on later ticks', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-same-head-repeat-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-same-head-repeat-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildSameHeadRepeatRunnerSource());

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(
      summary.spawns101.length,
      1,
      'fixed head should be reviewed at most once without an explicit retrigger'
    );
    assert.equal(summary.spawns101[0].subjectContext.reviewerHeadSha, 'sha-happy-101');
    assert.equal(summary.row101.review_status, 'posted');
    assert.equal(summary.row101.reviewer_head_sha, 'sha-happy-101');
    assert.equal(summary.passRows101.length, 1);
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
        env: fixtureEnv(installGhFixture(tmp)),
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
          ...installGhFixture(tmp),
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
        export async function applyMergeAgentStuckLabel() { return false; } export async function addMergeAgentDispatchedLabel() { return { added: true }; }
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
        env: fixtureEnv(installGhFixture(tmp)),
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
      reviewerRuntimeSource: "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { const row = globalThis.__watcherClaimLoopDb.prepare('SELECT codex_broker_provider FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(payload.subjectContext.repo, payload.subjectContext.prNumber); if (row?.codex_broker_provider !== payload.subjectContext.codexBrokerProvider) throw new Error('reviewer account was not persisted before spawn'); globalThis.__watcherClaimLoopReviewerSpawns.push(payload); throw new Error('fixture reviewer spawn failure'); }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    }).replaceAll("builderClass: 'codex'", "builderClass: 'claude-code'").replaceAll('[codex]', '[claude-code]'));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ expectPollError: true }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv(installGhFixture(tmp)),
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
    assert.equal(summary.reviewerSpawns.length, 2, output);
    assert.equal(summary.rows['101'].codex_broker_provider, 'codex');
    assert.equal(summary.rows['102'].codex_broker_provider, 'codex');
    assert.equal(summary.reviewerPassRows.length, 2);
    assert.ok(summary.reviewerPassRows.every((row) => row.status === 'failed'));
    assert.ok(summary.reviewerPassRows.every((row) => row.workspace_path === REPO_ROOT));
    assert.ok(summary.reviewerPassRows.every((row) => /fixture reviewer spawn failure/.test(row.metadata_json)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce records failed reviewer token usage in reviewer_passes', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: `
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return {
            spawnReviewer: async (payload) => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              return {
                ok: false,
                failureClass: 'timeout',
                stdoutTail: '{"type":"turn.completed"}',
                stderrTail: 'fixture timeout',
                tokenUsage: {
                  input: 12345,
                  output: 67,
                  cacheRead: 890,
                  cacheWrite: 0,
                  total: 12412,
                  source: 'codex-json',
                },
              };
            },
            cancel: async () => {},
            reattach: async () => ({}),
          };
        }
        export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
        export function loadDomainConfig() { return {}; }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
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
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.pollError, null);
    assert.equal(summary.reviewerPassRows.length, 2);
    assert.ok(summary.reviewerPassRows.every((row) => row.status === 'failed'));
    assert.ok(summary.reviewerPassRows.every((row) => row.token_input === 12345));
    assert.ok(summary.reviewerPassRows.every((row) => row.token_total === 12412));
    assert.ok(summary.reviewerPassRows.every((row) => row.token_source === 'codex-json'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher pollOnce records no-usage reason for failed reviewer without parseable usage', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: `
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return {
            spawnReviewer: async (payload) => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              return {
                ok: false,
                failureClass: 'timeout',
                stdoutTail: '{"type":"turn.completed","usage":',
                stderrTail: 'fixture timeout',
                tokenUsage: null,
                tokenUsageNoUsageReason: 'unparseable-stdout',
              };
            },
            cancel: async () => {},
            reattach: async () => ({}),
          };
        }
        export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
        export function loadDomainConfig() { return {}; }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
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
        env: fixtureEnv(installGhFixture(tmp)),
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.pollError, null);
    assert.equal(summary.reviewerPassRows.length, 2);
    assert.ok(summary.reviewerPassRows.every((row) => row.status === 'failed'));
    assert.ok(summary.reviewerPassRows.every((row) => row.token_input === null));
    assert.ok(summary.reviewerPassRows.every((row) => {
      const metadata = JSON.parse(row.metadata_json);
      return metadata.tokenUsageNoUsageReason === 'unparseable-stdout';
    }));
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
          ...installGhFixture(tmp),
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

// ---------------------------------------------------------------------------
// FSR-06B: a fleet-self-repair trailer-only re-review request on a PR whose
// review budget and hard review ceiling are both spent.
// ---------------------------------------------------------------------------

// Same ledger stub as the default harness but with the completed-round
// timestamp list the budget probe reads; the per-head exhaustion itself comes
// from the two completed reviewer passes inserted on the live head below.
const EXHAUSTED_FOLLOW_UP_JOBS_SOURCE = DEFAULT_FOLLOW_UP_JOBS_SOURCE
  .replace(
    "export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; }",
    "export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1, completedRoundTimestamps: [] }; }"
  );

function gitFixture(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
}

// A daemon-clone-shaped repo at `<hqRoot>/repos/adversarial-review` (the
// slug the claim-loop subject fixture uses) with a reviewed head and one
// commit on top: trailer-only (empty diff) or substantive.
function makeFsrDaemonClone(tmp, { substantiveMove = false } = {}) {
  const hqRoot = path.join(tmp, 'hq');
  const clone = path.join(hqRoot, 'repos', 'adversarial-review');
  mkdirSync(clone, { recursive: true });
  gitFixture(clone, 'init', '-q');
  gitFixture(clone, 'config', 'user.email', 'fixture@example.invalid');
  gitFixture(clone, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(clone, 'code.py'), 'reviewed\n');
  gitFixture(clone, 'add', 'code.py');
  gitFixture(clone, 'commit', '-q', '-m', 'Implement ticket');
  const reviewed = gitFixture(clone, 'rev-parse', 'HEAD');
  if (substantiveMove) {
    writeFileSync(path.join(clone, 'code.py'), 'changed\n');
    gitFixture(clone, 'add', 'code.py');
    gitFixture(clone, 'commit', '-q', '-m', 'Add provenance trailer\n\nReviewed-by: codex');
  } else {
    gitFixture(clone, 'commit', '-q', '--allow-empty', '-m', 'Add provenance trailer\n\nReviewed-by: codex');
  }
  const live = gitFixture(clone, 'rev-parse', 'HEAD');
  return { hqRoot, clone, reviewed, live };
}

function fsrPrePollSetup({ reviewed, live }) {
  return `
        db.prepare(
          \`INSERT INTO reviewed_prs
             (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
              review_attempts, revision_ref, reviewer_head_sha, posted_at,
              rereview_requested_at, rereview_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)\`
        ).run(
          'laceyenterprises/adversarial-review',
          101,
          '2026-09-02T12:00:00.000Z',
          'codex',
          'open',
          'pending',
          2,
          ${JSON.stringify(live)},
          '2026-09-03T12:00:00.000Z',
          ${JSON.stringify(`FSR-06B: trailer-only head move detected; request fresh adversarial review. reviewed=${reviewed} live=${live}`)}
        );
        // Two completed reviewer passes already recorded on the LIVE head: the
        // per-head re-review budget (1) and the hard review ceiling (2) are
        // both spent, so ordinary policy refuses this spawn.
        const insertPass = db.prepare(
          \`INSERT INTO reviewer_passes
             (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
              pass_kind, started_at, ended_at, status, head_sha, metadata_json, gh_comment_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
        );
        insertPass.run('laceyenterprises/adversarial-review', 101, 1, 'codex', 'codex', 'rereview',
          '2026-09-02T13:00:00.000Z', '2026-09-02T13:10:00.000Z', 'completed', ${JSON.stringify(live)}, '{}', 'review-101-1');
        insertPass.run('laceyenterprises/adversarial-review', 101, 2, 'codex', 'codex', 'rereview',
          '2026-09-02T14:00:00.000Z', '2026-09-02T14:10:00.000Z', 'completed', ${JSON.stringify(live)}, '{}', 'review-101-2');
  `;
}

function runFsrScenario({ substantiveMove }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-fsr-06b-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-fsr-runner.mjs');
  try {
    const clone = makeFsrDaemonClone(tmp, { substantiveMove });
    writeFileSync(loaderPath, buildLoaderSource({
      subjectHeads: { 101: clone.live },
      followUpJobsSource: EXHAUSTED_FOLLOW_UP_JOBS_SOURCE,
    }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      freshHeads: { 101: clone.live },
      prePollSetup: fsrPrePollSetup(clone),
    }));

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: fixtureEnv({ ...installGhFixture(tmp), HQ_ROOT: clone.hqRoot }),
      }
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));
    return { clone, summary, output };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('watcher spawns a re-review for a verified FSR-06B trailer-only request past a spent budget and ceiling', () => {
  const { clone, summary, output } = runFsrScenario({ substantiveMove: false });
  assert.match(
    output,
    /FSR-06B re-review request for laceyenterprises\/adversarial-review#101 verified: .* is an empty delta over 1 commit\(s\)/,
    output
  );
  assert.match(
    output,
    /reviewer spawn ALLOWED for laceyenterprises\/adversarial-review#101 past remediation-round-budget-exhausted: verified FSR-06B/,
    output
  );
  assert.match(
    output,
    /Allowing explicit re-review for laceyenterprises\/adversarial-review#101: hard review ceiling reached .* verified FSR-06B trailer-only re-review request/,
    output
  );
  const spawn101 = summary.reviewerSpawns.find((spawn) => spawn?.subjectContext?.prNumber === 101);
  assert.ok(spawn101, JSON.stringify(summary, null, 2));
  assert.equal(spawn101.subjectContext.passKind, 'rereview');
  assert.equal(spawn101.subjectContext.reviewerHeadSha, clone.live);
  const row101 = summary.fsrRows.find((row) => row.pr_number === 101);
  assert.equal(row101.review_status, 'posted');
  assert.equal(row101.reviewer_head_sha, clone.live);
  assert.doesNotMatch(output, /FSR-06B re-review request DECLINED/);
});

test('watcher declines an FSR-06B request it cannot verify instead of leaving the row pending', () => {
  const { clone, summary, output } = runFsrScenario({ substantiveMove: true });
  assert.match(
    output,
    /FSR-06B re-review request for laceyenterprises\/adversarial-review#101 NOT verified \(non-empty-delta\)/,
    output
  );
  assert.match(
    output,
    /reviewer spawn SUPPRESSED for laceyenterprises\/adversarial-review#101: remediation-round-budget-exhausted/,
    output
  );
  assert.match(
    output,
    /FSR-06B re-review request DECLINED for laceyenterprises\/adversarial-review#101: remediation-round-budget-exhausted/,
    output
  );
  const spawn101 = summary.reviewerSpawns.find((spawn) => spawn?.subjectContext?.prNumber === 101);
  assert.equal(spawn101, undefined, JSON.stringify(summary.reviewerSpawns, null, 2));
  const row101 = summary.fsrRows.find((row) => row.pr_number === 101);
  const debug = `${JSON.stringify(row101)}\n${output.split(/\r?\n/).filter((line) => /#101/.test(line)).join('\n')}`;
  assert.equal(row101.review_status, 'posted', debug);
  assert.equal(row101.reviewer_head_sha, clone.reviewed, debug);
  assert.equal(row101.rereview_requested_at, null, debug);
  assert.equal(
    row101.rereview_reason,
    `FSR-06B declined: remediation-round-budget-exhausted; reviewed=${clone.reviewed} live=${clone.live}`
  );
});

for (const suppressionReason of ['same-head-review-in-flight', 'other-suppression']) {
  test(`REVIEWSTALL-01: ${suppressionReason} does not consume attempts after new-head re-arm`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-reviewstall-suppression-'));
    const loaderPath = path.join(tmp, 'fixture-loader.mjs');
    const registerPath = path.join(tmp, 'fixture-register.mjs');
    const runnerPath = path.join(tmp, 'fixture-runner.mjs');
    try {
      const loader = buildLoaderSource().replace(
        "return async () => ({ suppressed: false, reason: 'fixture' });",
        `return async () => ({ suppressed: true, reason: '${suppressionReason}' });`,
      );
      writeFileSync(loaderPath, loader);
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({
        prePollSetup: `
          db.prepare(\`INSERT INTO reviewed_prs
            (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
             reviewer_head_sha, revision_ref, failed_at, failure_message)
            VALUES (?, 101, '2026-10-03', 'claude', 'open', 'failed', 3,
                    'old-head', 'old-head', '2026-10-03', 'Command failed with code 1')\`)
            .run('laceyenterprises/adversarial-review');
        `,
        afterFirstPoll: `
          const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
          assert.equal(row.review_status, 'pending');
          assert.equal(row.review_attempts, 0);
          assert.ok(!claims.some(claim => claim.prNumber === 101));
          const archived = db.prepare('SELECT row_json FROM review_failure_archive WHERE pr_number = 101').get();
          assert.equal(JSON.parse(archived.row_json).review_attempts, 3);
          assert.equal(JSON.parse(archived.row_json).failure_message, 'Command failed with code 1');
          await pollOnce(octokit, pollOptions);
          assert.equal(db.prepare('SELECT review_attempts FROM reviewed_prs WHERE pr_number = 101').get().review_attempts, 0);
        `,
      }));
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 60000 });
      assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['stale-subprocess', 'rearm-exception', 'rearm-refused', 'nonrecoverable-failure']) {
  test(`REVIEWSTALL-01 watcher settles ${scenario} without losing the claim loop`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-reviewstall-settle-'));
    const loaderPath = path.join(tmp, 'fixture-loader.mjs');
    const registerPath = path.join(tmp, 'fixture-register.mjs');
    const runnerPath = path.join(tmp, 'fixture-runner.mjs');
    try {
      let loader = buildLoaderSource(scenario === 'stale-subprocess' ? {
        reviewerRuntimeSource: `
          globalThis.__watcherClaimLoopReviewerSpawns = [];
          export function createReviewerRuntimeAdapterForDomain() {
            return { spawnReviewer: async (payload) => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              return { ok: false, exitCode: 75, failureClass: 'stale-review-head',
                stderrTail: '[stale-review-head] refusing obsolete post' };
            }, cancel: async () => {}, reattach: async () => ({}) };
          }
          export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
          export function loadDomainConfig() { return {}; }
          export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
        `,
      } : {});
      if (scenario === 'nonrecoverable-failure') {
        loader = loader.replace('  return nextLoad(url, context);', `
          if (url === ${JSON.stringify(fileUrl('src', 'review-retry-exhaustion.mjs'))}) {
            return { format: 'module', shortCircuit: true, source:
              'export async function parkExhaustedReview(args) { globalThis.__reviewstallParks = [args]; }' };
          }
          return nextLoad(url, context);
        `);
      }
      writeFileSync(loaderPath, loader);
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      const rearmScenario = scenario.startsWith('rearm-');
      writeFileSync(runnerPath, buildRunnerSource({
        prePollSetup: scenario === 'stale-subprocess' ? '' : `
          db.prepare(\`INSERT INTO reviewed_prs
            (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
             reviewer_head_sha, revision_ref, failed_at, failure_message)
            VALUES (?, 101, '2026-10-03', 'claude', 'open', 'failed', 3,
              ?, ?, '2026-10-03', ?)\`)
            .run('laceyenterprises/adversarial-review',
              ${JSON.stringify(rearmScenario ? 'old-head' : 'sha-happy-101')},
              ${JSON.stringify(rearmScenario ? 'old-head' : 'sha-happy-101')},
              ${JSON.stringify(rearmScenario ? 'Command failed with code 1' : '[bug] SyntaxError')});
          ${scenario === 'rearm-exception' ? `db.exec(\`CREATE TRIGGER reject_archive BEFORE INSERT ON review_failure_archive
            BEGIN SELECT RAISE(ABORT, 'fixture archive unavailable'); END\`);` : ''}
          ${scenario === 'rearm-refused' ? `db.exec(\`CREATE TRIGGER refuse_reset BEFORE UPDATE ON reviewed_prs
            WHEN OLD.pr_number = 101 AND OLD.review_status = 'failed'
            BEGIN SELECT RAISE(IGNORE); END\`);` : ''}
        `,
        afterFirstPoll: `
          const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
          assert.equal(row.review_status, ${JSON.stringify(scenario === 'stale-subprocess' ? 'pending' : 'failed')});
          assert.equal(row.review_attempts, ${scenario === 'stale-subprocess' ? 0 : 3});
          ${scenario === 'stale-subprocess' ? `
            assert.equal(row.reviewer_session_uuid, null);
            assert.equal(row.reviewer_lease_expires_at, null);
          ` : 'assert.ok(!claims.some(claim => claim.prNumber === 101));'}
          ${scenario === 'nonrecoverable-failure' ? `
            assert.equal(globalThis.__reviewstallParks.length, 1);
            assert.equal(globalThis.__reviewstallParks[0].headSha, 'sha-happy-101');
            assert.match(globalThis.__reviewstallParks[0].reason, /not infrastructure-recoverable/);
          ` : ''}
        `,
      }));
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 60000 });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, output);
      if (scenario === 'rearm-exception') assert.match(output, /Failed review re-arm failed.*fixture archive unavailable/);
      if (scenario === 'rearm-refused') assert.match(output, /Failed review re-arm blocked.*: \S+/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('HELDHEAD request exceptions preserve later subjects in the same watcher tick', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-heldhead-'));
  const loaderPath = path.join(tmp, 'loader.mjs');
  const registerPath = path.join(tmp, 'register.mjs');
  const runnerPath = path.join(tmp, 'runner.mjs');
  const old = process.env.FIXTURE_THROW_HELDHEAD_REQUEST;
  try {
    process.env.FIXTURE_THROW_HELDHEAD_REQUEST = '1';
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', env: { ...fixtureEnv(installGhFixture(tmp)), FIXTURE_THROW_HELDHEAD_REQUEST: '1' }, timeout: 30000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /Withheld-head recovery deferred.*fixture held-head request failure/);
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
    const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
    assert.equal(summary.pollError, null);
    assert.equal(summary.rows['102'].review_status, 'posted');
  } finally {
    if (old === undefined) delete process.env.FIXTURE_THROW_HELDHEAD_REQUEST;
    else process.env.FIXTURE_THROW_HELDHEAD_REQUEST = old;
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const exact of [true, false]) test(`REMORPHAN exact-head recovery ${exact ? 'spawns' : 'cannot follow a moved head'} on a closer commit`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-orphan-head-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource()
      .replace("return async () => ({ suppressed: false, reason: 'fixture' });", "return async () => ({ suppressed: true, reason: 'closer-commit-trailer' });")
      .replace("export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: false, reason: 'fixture' }; }", "export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: true, reason: 'closer-commit-trailer' }; }"));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ prePollSetup: `
      db.prepare(\`INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         review_attempts, revision_ref, rereview_requested_at, rereview_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).run(
        'laceyenterprises/adversarial-review', 101, '2026-10-04T00:00:00Z', 'gemini',
        'open', 'pending', 0, 'sha-happy-101', '2026-10-04T01:00:00Z',
        'system-orphan-head-review:${exact ? 'sha-happy-101' : 'old-head'}');
    ` }));
    const run = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
      env: fixtureEnv(installGhFixture(tmp)),
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, output);
    const line = run.stdout.split(/\r?\n/).find(line => line.startsWith(SUMMARY_MARKER));
    assert.ok(line, output);
    const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
    assert.equal(summary.reviewerSpawns.some(spawn => spawn.subjectContext?.reviewerHeadSha === 'sha-happy-101'), exact, output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


// NOOWNER-01 (agent-os PR 8022): AMA automated recovery re-armed the row for an
// exact-head review of a hammer-rebased closer head. Every poll then logged
// "Retrying PR ... previous status=pending" and "reviewer spawn SUPPRESSED ...
// closer-commit-trailer" and returned, so nothing owned the PR. One tick now
// declines the request back to the posted review, where the closer owns it.
test('NOOWNER-01: a suppressed AMA-recovery re-review on a closer head returns the row to posted instead of looping', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-noowner-closer-head-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource()
      .replace("return async () => ({ suppressed: false, reason: 'fixture' });", "return async () => ({ suppressed: true, reason: 'closer-commit-trailer' });")
      .replace("export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: false, reason: 'fixture' }; }", "export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: true, reason: 'closer-commit-trailer' }; }"));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ prePollSetup: `
      db.prepare(\`INSERT INTO reviewer_passes
        (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status,
         head_sha, gh_comment_id, body_md, body_captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).run(
        'laceyenterprises/adversarial-review', 101, 1, 'gemini', 'first-pass', '2026-10-10T18:00:00Z',
        '2026-10-10T18:10:00Z', 'completed', 'sha-reviewed-101', 'IC_101', '## Verdict\\nComment only',
        '2026-10-10T18:10:00Z');
      db.prepare(\`INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         review_attempts, revision_ref, rereview_requested_at, rereview_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).run(
        'laceyenterprises/adversarial-review', 101, '2026-10-10T18:10:00Z', 'gemini',
        'open', 'pending', 0, 'sha-happy-101', '2026-10-10T18:36:00Z',
        'AMA automated recovery: stale-review-head');
    ` }));
    const run = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
      env: fixtureEnv(installGhFixture(tmp)),
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, output);
    const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
    assert.ok(line, output);
    const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
    assert.match(output, /reviewer spawn SUPPRESSED for laceyenterprises\/adversarial-review#101: closer-commit-trailer/);
    assert.equal(summary.reviewerSpawns.some((spawn) => spawn.subjectContext?.reviewerHeadSha === 'sha-happy-101'), false, output);
    assert.equal(summary.rows['101'].review_status, 'posted', output);
    assert.equal(summary.rows['101'].reviewer_head_sha, 'sha-reviewed-101', output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

function runDepthDiscoveryScenario({ burst = false, depthEngaged = true, drainOutcome = null, stalePriority = false } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-depth-discovery-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    const routeUrl = fileUrl('src', 'reviewer-route-selection.mjs');
    const fallbackUrl = fileUrl('src', 'review-worker-class-fallback.mjs');
    const depthUrl = fileUrl('src', 'review-queue-depth.mjs');
    const burstUrl = fileUrl('src', 'reviewer-burst-lease.mjs');
    const poolUrl = fileUrl('src', 'watcher-reviewer-pool.mjs');
    const sources = {
      [routeUrl]: `
        import * as actual from '${routeUrl}?actual';
        import { REVIEWER_ROUTE_BY_MODEL } from '${fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')}';
        export * from '${routeUrl}?actual';
        export function selectReviewerRouteForAttempt(args) {
          return { ...actual.selectReviewerRouteForAttempt(args), ...REVIEWER_ROUTE_BY_MODEL.gemini,
            timeoutFallback: { fromReviewerModel: 'codex', toReviewerModel: 'gemini',
              timeoutFailures: 2, sameModelAsBuilder: false, builderClass: 'codex' } };
        }
      `,
      // Keep the production resolver and precedence rules; stub only live quota I/O.
      [fallbackUrl]: `
        import * as actual from '${fallbackUrl}?actual';
        export * from '${fallbackUrl}?actual';
        export async function resolveReviewerWorkerClassWithFallback(args) {
          return actual.resolveReviewerWorkerClassWithFallback({ ...args,
            execFileImpl: async () => ({ stdout: JSON.stringify({ providerStatuses: [
              { provider: 'google', authPath: 'oauth', state: 'ok' },
              { provider: 'anthropic', authPath: 'oauth', state: 'ok' }
            ] }) }) });
        }
      `,
      [depthUrl]: `
        import * as actual from '${depthUrl}?actual';
        export * from '${depthUrl}?actual';
        globalThis.__watcherDepthDiagnostics = {};
        export function createFirstPassSpilloverController(args) {
          return actual.createFirstPassSpilloverController({ ...args, rootDir: ${JSON.stringify(tmp)},
            writeFileImpl: (_path, contents) => {
              globalThis.__watcherDepthDiagnostics.report = JSON.parse(contents);
            } });
        }
      `,
      [burstUrl]: `
        import * as actual from '${burstUrl}?actual';
        export * from '${burstUrl}?actual';
        export function createReviewerBurstController(args) {
          const now = () => new Date('2026-10-05T03:00:00Z');
          const rootDir = ${JSON.stringify(tmp)};
          if (${burst}) actual.requestReviewerBurstLease({ rootDir,
            repos: ['laceyenterprises/adversarial-review'], reason: 'fixture precedence',
            requestedBy: 'fixture operator', slots: 1, ttlMs: 1800000, budgetUsd: 20,
            now, safety: {
              quota: { readable: true, availableClasses: ['claude-code'], groundedClasses: [] },
              posting: { readable: true, attempts: 20, failures: 0, failureRatio: 0, outageActive: false },
              reviewer: { readable: true, stuckSlots: 0, states: { active: 0, stale: 0, impossible: 0 } }
            } });
          const controller = actual.createReviewerBurstController({ ...args, rootDir, now, readSpendUsd: () => 0 });
          return { ...controller, recordBurstAdmission(subject) {
            const admitted = controller.recordBurstAdmission(subject);
            globalThis.__watcherDepthDiagnostics.burstAdmissions =
              (globalThis.__watcherDepthDiagnostics.burstAdmissions || 0) + Number(admitted);
            return admitted;
          } };
        }
      `,
    };
    if (stalePriority) {
      const storeUrl = fileUrl('src', 'watcher-retained-wakes.mjs');
      sources[storeUrl] = `
        import { createRetainedWatcherWakes as create } from '${storeUrl}?actual';
        export function createRetainedWatcherWakes() {
          const store = create({ rootDir: ${JSON.stringify(tmp)} });
          store.retain({ repoPath: 'laceyenterprises/adversarial-review', prNumber: 998, headSha: 'old-head' });
          globalThis.__retainedWakeStore = store;
          return store;
        }
      `;
    }
    if (drainOutcome) sources[poolUrl] = `
      import * as actual from '${poolUrl}?actual';
      export * from '${poolUrl}?actual';
      let drains = 0;
      export async function runBoundedReviewerDispatchQueue(candidates, options) {
        if (++drains !== 1) {
          globalThis.__watcherDepthDiagnostics.restoredModels = candidates.map(c => c.reviewerModel);
          return actual.runBoundedReviewerDispatchQueue(candidates, options);
        }
        // Force admission to yield or fail after real production spill preparation.
        // The closures that reserve, refund, restore and refresh waivers are untouched.
        const deferred = candidates[1];
        await deferred.prepareForGeminiSaturation();
        globalThis.__watcherDepthDiagnostics.reservedModel = deferred.reviewerModel;
        const result = await actual.runBoundedReviewerDispatchQueue([candidates[0]], options);
        if (${JSON.stringify(drainOutcome)} === 'throw') throw new Error('fixture drain failed after spill');
        return { ...result, deferred: 1, deferredCandidates: [deferred] };
      }
    `;
    if (drainOutcome === 'lease-held') {
      delete sources[poolUrl];
      const gateUrl = fileUrl('src', 'reviewed-head-dispatch-gate.mjs');
      sources[gateUrl] = `
        import * as actual from '${gateUrl}?actual';
        export * from '${gateUrl}?actual';
        export function createHeadDispatchLease() {
          const lease = actual.createHeadDispatchLease();
          return { ...lease, tryAcquire(key) { return key.includes('#102@') ? false : lease.tryAcquire(key); } };
        }
      `;
    }
    const loader = buildLoaderSource().replace('  return nextLoad(url, context);', `
      const source = new Map(${JSON.stringify(Object.entries(sources))}).get(url);
      if (source) return { format: 'module', shortCircuit: true, source };
      return nextLoad(url, context);
    `);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      expectPollError: drainOutcome === 'throw',
      freshHeads: stalePriority ? { 998: 'old-head' } : {},
      // Depth is memoized at discovery; model the already-queued production backlog.
      prePollSetup: `
        db.prepare("INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, 101, ?, 'gemini', 'open', 'pending', 0)").run('laceyenterprises/adversarial-review', '2026-05-15T12:00:00.000Z');
        if (${stalePriority}) {
          const insert = db.prepare("INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, 999, ?, 'gemini', 'open', 'failed', 1)");
          for (const repo of ['laceyenterprises/adversarial-review', 'example/not-polled']) {
            insert.run(repo, '2026-05-15T12:00:00.000Z');
          }
        }
      `,
      afterFirstPoll: stalePriority ? `
        assert.equal(globalThis.__retainedWakeStore.matches({ repoPath: 'laceyenterprises/adversarial-review',
          prNumber: 998, headSha: 'old-head' }), true, 'unconfirmed absence must not delete durable priority');
      ` : '',
    }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: fixtureEnv({ ...installGhFixture(tmp), GH_GEMINI_REVIEWER_TOKEN: 'fixture-gemini',
          GH_CLAUDE_REVIEWER_TOKEN: 'fixture-claude',
          ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: 'claude-code',
          AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: depthEngaged ? '1' : '100',
          AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: burst ? '1' : '2' }),
      });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
    assert.ok(line, output);
    return { summary: JSON.parse(line.slice(SUMMARY_MARKER.length)), output };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

for (const capacity of ['pool', 'memory', 'credential', 'quota', 'fallback-quota', 'overdue', 'spawn-throw', 'spawn-refusal', 'spawn-started-failure']) test(capacity === 'overdue'
  ? 'WAKESTARVE-01: production discovery admits overdue work before newer wakes'
  : capacity === 'spawn-started-failure' ? 'WAKESTARVE-01: a started process consumes its wake even when review fails'
  : `WAKESTARVE-01: production ${capacity} deferral retains a wake across polls`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-retained-wake-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    const poolUrl = fileUrl('src', 'watcher-reviewer-pool.mjs');
    const storeUrl = fileUrl('src', 'watcher-retained-wakes.mjs');
    const routeUrl = fileUrl('src', 'reviewer-route-selection.mjs');
    const sources = {
      [storeUrl]: `
        import { createRetainedWatcherWakes as create } from '${storeUrl}?actual';
        export function createRetainedWatcherWakes() {
          const store = create({ rootDir: ${JSON.stringify(tmp)} });
          globalThis.__retainedWakeStore = store;
          return store;
        }
      `,
      [routeUrl]: `
        import * as actual from '${routeUrl}?actual';
        import { REVIEWER_ROUTE_BY_MODEL } from '${fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')}';
        export * from '${routeUrl}?actual';
        export function selectReviewerRouteForAttempt(args) {
          return { ...actual.selectReviewerRouteForAttempt(args), ...REVIEWER_ROUTE_BY_MODEL.gemini,
            quotaBlocked: ${capacity === 'quota'} && !globalThis.__wakeTestSeats };
        }
      `,
      [poolUrl]: `
        import * as actual from '${poolUrl}?actual';
        export * from '${poolUrl}?actual';
        export async function runBoundedReviewerDispatchQueue(candidates, options) {
          return actual.runBoundedReviewerDispatchQueue(candidates, { ...options,
            maxConcurrent: 1, geminiCredentialConcurrency: ${capacity === 'pool' ? 'globalThis.__wakeTestSeats || 0' : '1'} });
        }
      `,
    };
    if (capacity === 'fallback-quota') {
      const fallbackUrl = fileUrl('src', 'review-worker-class-fallback.mjs');
      sources[fallbackUrl] = `
        export * from '${fallbackUrl}?actual';
        export async function resolveReviewerWorkerClassWithFallback() {
          return { fellBack: false, quotaBlocked: !globalThis.__wakeTestSeats };
        }
      `;
    }
    let loader = buildLoaderSource(capacity.startsWith('spawn-') ? {
      reviewerRuntimeSource: `
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return { spawnReviewer: async (payload) => {
            if (!globalThis.__wakeTestSeats) {
              if (${capacity === 'spawn-throw'}) throw new Error('synthetic spawn failure');
              if (${capacity === 'spawn-started-failure'}) {
                payload.onReviewerPgid({ pgid: 123456, spawnedAt: new Date().toISOString() });
              }
              return { ok: false, failureClass: 'fixture-failure', stderr: '' };
            }
            globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
            payload.onReviewerPgid({ pgid: 123456, spawnedAt: new Date().toISOString() });
            assertWakeConsumed(payload);
            return { ok: true, stdout: '', stderr: '' };
          }, cancel: async () => {}, reattach: async () => ({}) };
        }
        function assertWakeConsumed(payload) {
          if (globalThis.__retainedWakeStore.matches({ repoPath: payload.subjectContext.repo,
            prNumber: payload.subjectContext.prNumber, headSha: payload.subjectContext.reviewerHeadSha })) {
            throw new Error('wake must be consumed at confirmed process start');
          }
        }
        export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
        export function loadDomainConfig() { return {}; }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
      `,
    } : {});
    if (capacity === 'credential') loader = loader.replace(
      'export function shouldPauseReviewerModel() { return { paused: false }; }',
      'export function shouldPauseReviewerModel() { return { paused: !globalThis.__wakeTestSeats }; }');
    if (capacity === 'memory') loader = loader.replace(
      'admit: true, reason: null', 'admit: Boolean(globalThis.__wakeTestSeats), reason: null');
    writeFileSync(loaderPath, loader.replace('  return nextLoad(url, context);', `
      const source = new Map(${JSON.stringify(Object.entries(sources))}).get(url);
      if (source) return { format: 'module', shortCircuit: true, source };
      return nextLoad(url, context);
    `));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      healthProbeSetup: `
        const repoPath = db.prepare('SELECT repo FROM reviewed_prs LIMIT 1').get().repo;
        db.prepare('UPDATE reviewed_prs SET reviewed_at = ?').run(new Date().toISOString());
        pollOptions.wakePayload = { repo: repoPath, pr_number: 101, head_sha: 'sha-happy-101' };
        if (${capacity === 'overdue'}) {
          const queuedAt = new Date(Date.now() - 900_001).toISOString();
          db.prepare(\`INSERT INTO reviewed_prs
            (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
            VALUES (?, 101, ?, 'gemini', 'open', 'pending', 0)\`).run(repoPath, queuedAt);
          db.prepare('DELETE FROM reviewed_prs WHERE pr_number = 102').run();
          pollOptions.wakePayload = { repo: repoPath, pr_number: 102 };
        }
      `,
      afterFirstPoll: capacity === 'spawn-started-failure' ? `
        assert.equal(globalThis.__retainedWakeStore.matches({ repoPath, prNumber: 101, headSha: 'sha-happy-101' }), false);
      ` : capacity === 'overdue' ? `
        assert.equal(globalThis.__watcherClaimLoopReviewerSpawns[0].subjectContext.prNumber, 101);
      ` : `
        const retained = globalThis.__retainedWakeStore;
        assert.equal(retained.matches({ repoPath, prNumber: 101, headSha: 'sha-happy-101' }), true);
        assert.equal((globalThis.__watcherClaimLoopReviewerSpawns || []).length, 0);
        globalThis.__wakeTestSeats = 1;
        if (${capacity.startsWith('spawn-')}) {
          // Model the existing retry lane admitting this failed head again.
          db.prepare("UPDATE reviewed_prs SET review_status = 'pending', review_attempts = 0, failed_at = NULL, reviewer_session_uuid = NULL WHERE pr_number = 101").run();
        }
        pollOptions.wakePayload = { repo: repoPath, pr_number: 102 };
        await pollOnce(octokit, pollOptions);
        assert.equal(globalThis.__watcherClaimLoopReviewerSpawns[0].subjectContext.prNumber, 101);
        assert.equal(retained.matches({ repoPath, prNumber: 101, headSha: 'sha-happy-101' }), false);
      `,
    }).replace('await pollOnce(octokit, pollOptions);', capacity === 'spawn-throw'
      ? "await assert.rejects(pollOnce(octokit, pollOptions), /synthetic spawn failure/);"
      : 'await pollOnce(octokit, pollOptions);'));
    const run = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
      env: fixtureEnv({ ...installGhFixture(tmp),
        AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '1' }),
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, output);
    if (capacity !== 'spawn-started-failure') assert.match(output, capacity === 'overdue'
      ? /reviewer priority dispatch .*retained_wake=false wait_threshold_exceeded=true/
      : /reviewer priority dispatch .*retained_wake=true/);
    if (capacity === 'quota' || capacity === 'fallback-quota') {
      assert.match(output, /reviewer-route DEFERRED .*pr=101/);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const burst of [false, true]) test(`engaged discovery depth keeps priority over burst=${burst} and refreshes spawn waivers`, () => {
  const { summary, output } = runDepthDiscoveryScenario({ burst });
  assert.match(output, /Draining 2 reviewer dispatch candidate\(s\) before continuing reviewer discovery/);
  assert.match(output, /review-queue-depth-route .*from=gemini to=claude reason=queue-depth-pressure/);
  const preferred = summary.reviewerSpawns.find((spawn) => spawn.subjectContext.reviewerModel === 'gemini');
  const spill = summary.reviewerSpawns.find((spawn) => spawn.subjectContext.reviewerModel === 'claude');
  assert.ok(preferred, output);
  assert.ok(spill, output);
  assert.match(preferred.subjectContext.crossModelReviewWaiverReason, /to reviewer=gemini/);
  assert.equal(spill.subjectContext.crossModelReviewWaived, false);
  assert.equal(spill.subjectContext.crossModelReviewWaiverReason, null);
  assert.equal(summary.depthDiagnostics.burstAdmissions || 0, 0);
  assert.equal(summary.depthDiagnostics.report.engagementSpilloverReviews, 1);
  assert.equal(summary.depthDiagnostics.report.cost.byWorkerClass['claude-code'], 1);
});

test('stale retained wakes and failed rows cannot strand the intermediate discovery drain', () => {
  const { summary, output } = runDepthDiscoveryScenario({ stalePriority: true });
  assert.match(output, /Draining 2 reviewer dispatch candidate\(s\) before continuing reviewer discovery/);
  assert.equal(summary.reviewerSpawns.length, 2);
});

test('disengaged depth still permits burst admission at discovery', () => {
  const { summary } = runDepthDiscoveryScenario({ burst: true, depthEngaged: false });
  assert.equal(summary.depthDiagnostics.burstAdmissions, 2);
  assert.ok(summary.reviewerSpawns.every(spawn => spawn.subjectContext.reviewerModel === 'claude'));
  assert.equal(summary.depthDiagnostics.report?.engagementSpilloverReviews || 0, 0);
});

test('deferred production spill restores Gemini route and waiver before the next drain', () => {
  const { summary, output } = runDepthDiscoveryScenario({ drainOutcome: 'defer' });
  assert.equal(summary.depthDiagnostics.reservedModel, 'claude');
  assert.deepEqual(summary.depthDiagnostics.restoredModels, ['gemini']);
  assert.equal(summary.depthDiagnostics.report.engagementSpilloverReviews, 0);
  assert.match(output, /from=claude to=gemini reason=pool-admission-deferred/);
  assert.equal(summary.reviewerSpawns.length, 2);
  for (const spawn of summary.reviewerSpawns) {
    assert.equal(spawn.subjectContext.reviewerModel, 'gemini');
    assert.equal(spawn.subjectContext.crossModelReviewWaived, true);
    assert.match(spawn.subjectContext.crossModelReviewWaiverReason, /to reviewer=gemini/);
  }
});

test('failed drain refunds unstarted production spill reservations', () => {
  const { summary, output } = runDepthDiscoveryScenario({ drainOutcome: 'throw' });
  assert.equal(summary.pollError, 'fixture drain failed after spill');
  assert.equal(summary.depthDiagnostics.reservedModel, 'claude');
  assert.equal(summary.depthDiagnostics.report.engagementSpilloverReviews, 0);
  assert.equal(summary.depthDiagnostics.report.cost.spilloverReviewsTotal, 0);
  assert.equal(summary.reviewerSpawns.length, 1);
  assert.match(output, /review-queue-depth-spillover-refund .*pr=102/);
});

test('head dispatch lease refusal refunds the production spill and restores its route', () => {
  const { summary, output } = runDepthDiscoveryScenario({ drainOutcome: 'lease-held' });
  assert.equal(summary.reviewerSpawns.length, 1);
  assert.equal(summary.depthDiagnostics.report.engagementSpilloverReviews, 0);
  assert.match(output, /dispatch lease already held/);
  assert.match(output, /from=claude to=gemini reason=pool-admission-deferred/);
});


test('REVIEWAGE-02 production saturation spills an overdue request below depth threshold', () => {
  const { summary, output } = runDepthDiscoveryScenario({ depthEngaged: false });
  assert.match(output, /review-wait-spill repo=.* pr=102 pass_kind=first-pass wait_seconds=[\d.]+ to=claude-code/);
  assert.equal((output.match(/review-wait-spill /g) || []).length, 1);
  assert.match(output, /review-queue-depth-route repo=.* pr=102 from=gemini to=claude reason=review-max-wait/);
  const spill = summary.reviewerSpawns.find(spawn => spawn.subjectContext.reviewerModel === 'claude');
  assert.ok(spill, output);
  assert.equal(spill.subjectContext.crossModelReviewWaived, false);
  assert.equal(summary.depthDiagnostics.report?.engagementSpilloverReviews || 0, 0);
});

test('CAPROUTE-01: failed capped row with an old revision reaches the hammer before retry admission on every new head', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'caproute-claim-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource({ capRouteSource: `
      globalThis.capRoutes = [];
      export async function maybeRouteReviewCycleCapToHammer(args) {
        if (!args.existing?.failure_message?.startsWith('[review-cycle-cap]')) return { handled: false };
        globalThis.capRoutes.push(args.currentRevisionRef);
        return { handled: true, outcome: 'ama-dispatched' };
      }` }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      prePollSetup: `db.prepare(\`INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
         reviewer_head_sha, revision_ref, failure_message)
        VALUES (?, 101, ?, 'codex', 'open', 'failed', 9, 'old-head', 'old-head', '[review-cycle-cap] capped')\`)
        .run('laceyenterprises/adversarial-review', '2026-05-15T12:00:00Z');`,
      afterFirstPoll: `
        assert.deepEqual(globalThis.capRoutes, ['sha-happy-101']);
        globalThis.__watcherClaimLoopSubjectHead = 'next-head';
        await pollOnce(octokit, pollOptions);
        assert.deepEqual(globalThis.capRoutes, ['sha-happy-101', 'next-head']);
        assert.ok(!claims.some((claim) => claim.prNumber === 101));`,
    }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const hadReview of [false, true]) test(`HOLDRELEASE-01: same-head release drives ${hadReview ? 're-review' : 'first review'} once through pollOnce`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hold-release-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ prePollSetup: `
      db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
        review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref)
        VALUES (?, 101, ?, 'claude', 'open', 'pending', 0, '["no-merge-hold"]', ?, ?)\`).run(
        'laceyenterprises/adversarial-review', '2026-10-11T16:00:00Z', ${hadReview ? "'old-head'" : 'null'}, 'sha-happy-101');
    `, afterFirstPoll: `
      const firstSpawns = globalThis.__watcherClaimLoopReviewerSpawns.length;
      await pollOnce(octokit, pollOptions);
      assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, firstSpawns);
      const releases = db.prepare('SELECT * FROM operator_hold_releases WHERE pr_number = 101').all();
      assert.equal(releases.length, 1);
      assert.equal(releases[0].stage, '${hadReview ? 'rereview' : 'first-review'}');
      assert.equal(releases[0].action, 'review');
      assert.ok(releases[0].routed_at);
    ` }));
    const env = fixtureEnv(installGhFixture(tmp));
    writeFileSync(path.join(tmp, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then
  printf '{"state":"OPEN","headRefOid":"sha-happy-%s","labels":[],"mergeable":"MERGEABLE","statusCheckRollup":[{"name":"fixture-ci","conclusion":"SUCCESS"}]}\\n' "$3"
else
  printf '{"sha":"fixture","message":"Fixture commit"}\\n'
fi
`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.equal(output.match(/\[watcher\] hold-released repo=.* pr=101 /g)?.length, 1, output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('HOLDRELEASE-01: hold re-applied after reviewer claim gives no spawn and refunds only that claim', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hold-reapply-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource().replace('headRefOid, labels: []',
      "headRefOid, labels: globalThis.__reappliedHold ? ['no-merge-hold'] : []"));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    let runner = buildRunnerSource({ prePollSetup: `
      db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
        review_status, review_attempts, labels_json, revision_ref)
        VALUES (?, 101, ?, 'claude', 'open', 'pending', 0, '["no-merge-hold"]', ?)\`).run(
        'laceyenterprises/adversarial-review', '2026-10-11T16:00:00Z', 'sha-happy-101');
    `, afterFirstPoll: `
      const row = db.prepare('SELECT review_status, review_attempts FROM reviewed_prs WHERE pr_number = 101').get();
      assert.equal(row.review_status, 'pending');
      assert.equal(row.review_attempts, 0);
      assert.equal((globalThis.__watcherClaimLoopReviewerSpawns || []).filter(s => s.prNumber === 101).length, 0);
      assert.ok(db.prepare('SELECT cancelled_at FROM operator_hold_releases WHERE pr_number = 101').get().cancelled_at);
    ` });
    runner = runner.replace('claims.push(payload);', 'claims.push(payload); if (payload.prNumber === 101) globalThis.__reappliedHold = true;');
    writeFileSync(runnerPath, runner);
    const env = fixtureEnv(installGhFixture(tmp));
    writeFileSync(path.join(tmp, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then
  printf '{"state":"OPEN","headRefOid":"sha-happy-%s","labels":[],"mergeable":"MERGEABLE","statusCheckRollup":[{"name":"fixture-ci","conclusion":"SUCCESS"}]}\\n' "$3"
else
  printf '{"sha":"fixture","message":"Fixture commit"}\\n'
fi
`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const scenario of ['missing-pass', 'null-body', 'budget-error', 'invalid-gh-json', 'gh-error', 'terminal']) {
  test(`HOLDRELEASE-01: ${scenario} does not wedge ordinary PR processing`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-release-failure-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      const bodyMissing = ['missing-pass', 'null-body'].includes(scenario);
      const followUpJobsSource = scenario === 'budget-error'
        ? DEFAULT_FOLLOW_UP_JOBS_SOURCE.replace("return { roundBudget: 1, riskClass: 'medium' };", "if (globalThis.__holdReleaseBudgetReadFail) { globalThis.__holdReleaseBudgetReadFail = false; throw new Error('fixture budget read failure'); } return { roundBudget: 1, riskClass: 'medium' };")
        : DEFAULT_FOLLOW_UP_JOBS_SOURCE;
      writeFileSync(loaderPath, buildLoaderSource({ followUpJobsSource }));
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({ prePollSetup: `
        globalThis.__holdReleaseBudgetReadFail = true;
        db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
          review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref, posted_at)
          VALUES (?, 101, ?, 'claude', 'open', ?, 0, '["no-merge-hold"]', ?, 'sha-happy-101', ?)\`).run(
          'laceyenterprises/adversarial-review', '2026-10-11T16:00:00Z',
          ${bodyMissing ? "'posted'" : "'pending'"}, ${bodyMissing ? "'sha-happy-101'" : 'null'},
          ${bodyMissing ? "'2026-10-11T16:01:00Z'" : 'null'});
        ${bodyMissing ? `globalThis.__holdReleaseSettled = { verdict: 'changes_requested',
          reviewedHeadSha: 'sha-happy-101', blockingFindingState: 'known',
          blockingFindingCount: 1, nonBlockingFindingCount: 0, remediationPending: false };` : ''}
        ${scenario === 'null-body' ? `db.prepare(\`INSERT INTO reviewer_passes
          (repo, pr_number, head_sha, attempt_number, reviewer_class, pass_kind, status, started_at, ended_at, body_md)
          VALUES (?, 101, 'sha-happy-101', 1, 'claude', 'first-pass', 'completed', ?, ?, NULL)\`).run(
          'laceyenterprises/adversarial-review', '2026-10-11T16:00:00Z', '2026-10-11T16:01:00Z');` : ''}
      `, afterFirstPoll: `
        const release = db.prepare('SELECT * FROM operator_hold_releases WHERE pr_number = 101').get();
        assert.ok(release);
        ${scenario === 'terminal' ? `
          assert.equal(release.stage, 'pr-terminal');
          assert.equal(release.action, 'none');
          assert.ok(release.routed_at);
          assert.ok(!claims.some(claim => claim.prNumber === 101));
        ` : `
          assert.ok(claims.some(claim => claim.prNumber === 101));
          assert.ok(globalThis.__holdReleaseGateProjections > 0);
          if (${bodyMissing}) {
            assert.equal(release.stage, 'rereview');
            assert.equal(release.action, 'review');
            assert.ok(release.routed_at);
          } else {
            assert.equal(release.routed_at, null);
          }
          const spawns = globalThis.__watcherClaimLoopReviewerSpawns.length;
          globalThis.__holdReleaseBudgetReadFail = true;
          await pollOnce(octokit, pollOptions);
          assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, spawns);
          assert.equal(db.prepare('SELECT count(*) n FROM operator_hold_releases WHERE pr_number = 101').get().n, 1);
        `}
      ` }));
      const env = fixtureEnv(installGhFixture(tmp));
      writeFileSync(path.join(tmp, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then
  ${scenario === 'gh-error' ? "echo 'fixture gh read failed' >&2; exit 1" : scenario === 'invalid-gh-json' ? "printf 'invalid-json\\n'" : `printf '{"state":"${scenario === 'terminal' ? 'CLOSED' : 'OPEN'}","headRefOid":"sha-happy-%s","labels":[],"mergeable":"MERGEABLE","statusCheckRollup":[{"name":"fixture-ci","conclusion":"SUCCESS"}]}\\n' "$3"`}
else
  printf '{"sha":"fixture","message":"Fixture commit"}\\n'
fi
`);
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60000 });
      assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

// Keep the real review-state CAS and pollOnce admission path; only external
// surfaces and operator paging are fixture stubs.
function runHoldReleaseRegression({ setup, verify, followUpJobsSource = DEFAULT_FOLLOW_UP_JOBS_SOURCE, held = false,
  transformLoader = source => source, transformRunner = source => source }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-release-regression-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    let loader = buildLoaderSource({ followUpJobsSource }).replace(
      ': { ...subject, ref: { ...subject.ref } };',
      ': { ...subject, labels: globalThis.__holdReleaseLabels || subject.labels, ref: { ...subject.ref } };',
    );
    loader = loader.replace('  return nextLoad(url, context);', `
      if (url === ${JSON.stringify(fileUrl('src', 'review-retry-exhaustion.mjs'))}) {
        return { format: 'module', shortCircuit: true, source:
          'export async function parkExhaustedReview(args) { (globalThis.__releaseParks ||= []).push(args); }' };
      }
      return nextLoad(url, context);
    `);
    writeFileSync(loaderPath, transformLoader(loader));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, transformRunner(buildRunnerSource({ prePollSetup: setup, afterFirstPoll: verify })));
    const env = fixtureEnv(installGhFixture(tmp));
    writeFileSync(path.join(tmp, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then
  printf '{"state":"OPEN","headRefOid":"sha-happy-%s","labels":${held ? '["no-merge-hold"]' : '[]'},"mergeable":"MERGEABLE","statusCheckRollup":[{"name":"fixture-ci","conclusion":"SUCCESS"}]}\\n' "$3"
else
  printf '{"sha":"fixture","message":"Fixture commit"}\\n'
fi
`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

for (const [name, message, status, infraAttempts] of [
  ['nonrecoverable failure', '[forbidden-fallback] denied', 'failed', 0],
  ['exhausted unknown failure', 'Command failed with code 1', 'failed', 0],
  ['lease-released exhausted failure', 'Command failed with code 1', 'pending', 0],
  ['exhausted infrastructure failure', '[unknown] Command failed with code 1', 'failed', 99],
]) test(`HOLDRELEASE-01: ${name} retains evidence and caps through repeated hold toggles`, () => {
  runHoldReleaseRegression({ setup: `
    db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
      review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref, failed_at,
      failure_message, infra_auto_recover_attempts)
      VALUES (?, 101, '2026-10-11T16:00:00Z', 'claude', 'open', ?, 99,
        '["no-merge-hold"]', 'sha-happy-101', 'sha-happy-101', '2026-10-11T16:01:00Z', ?, ?)\`).run(
        'laceyenterprises/adversarial-review', '${status}', '${message}', ${infraAttempts});
  `, verify: `
    const check = () => {
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
      assert.equal(row.review_status, 'failed');
      assert.equal(row.review_attempts, 99);
      assert.equal(row.failed_at, '2026-10-11T16:01:00Z');
      assert.equal(row.failure_message, '${message}');
      assert.equal(row.infra_auto_recover_attempts, ${infraAttempts});
      assert.equal(row.reviewer_head_sha, 'sha-happy-101');
      assert.ok(!claims.some(c => c.prNumber === 101));
      assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
    };
    check();
    globalThis.__holdReleaseLabels = ['no-merge-hold'];
    await pollOnce(octokit, pollOptions);
    check();
    globalThis.__holdReleaseLabels = [];
    await pollOnce(octokit, pollOptions);
    check();
    const releases = db.prepare('SELECT * FROM operator_hold_releases WHERE pr_number = 101').all();
    assert.equal(releases.length, 2);
    for (const release of releases) {
      assert.equal(release.stage, 'review-failed');
      assert.equal(release.action, 'none');
      assert.ok(release.routed_at);
    }
  ` });
});

test('HOLDRELEASE-01: active remediation owns the posted row without reset or duplicate enqueue', () => {
  runHoldReleaseRegression({
    followUpJobsSource: DEFAULT_FOLLOW_UP_JOBS_SOURCE.replace(
      "export function createFollowUpJob() { return { jobPath: '/tmp/watcher-claim-loop-follow-up.json' }; }",
      "export function createFollowUpJob() { throw new Error('active remediation must not be enqueued again'); }",
    ),
    setup: `
      globalThis.__holdReleaseSettled = { verdict: '', remediationPending: true };
      db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
        review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref, rereview_reason)
        VALUES (?, 101, '2026-10-11T16:00:00Z', 'claude', 'open', 'posted', 2,
          '["no-merge-hold"]', 'sha-happy-101', 'sha-happy-101', 'remediation owns head')\`).run(
          'laceyenterprises/adversarial-review');
    `, verify: `
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
      assert.equal(row.review_status, 'posted');
      assert.equal(row.review_attempts, 2);
      assert.equal(row.rereview_reason, 'remediation owns head');
      assert.ok(!claims.some(c => c.prNumber === 101));
      const release = db.prepare('SELECT * FROM operator_hold_releases WHERE pr_number = 101').get();
      assert.equal(release.stage, 'blocking-findings');
      assert.equal(release.action, 'remediation');
      assert.ok(release.routed_at);
    `,
  });
});

test('HOLDRELEASE-01: cancelled history does not fence an ordinary held first review', () => {
  runHoldReleaseRegression({ held: true, setup: `
    globalThis.__holdReleaseLabels = ['no-merge-hold'];
    db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
      review_status, review_attempts, labels_json, revision_ref)
      VALUES (?, 101, '2026-10-11T16:00:00Z', 'claude', 'open', 'pending', 0,
        '["no-merge-hold"]', 'sha-happy-101')\`).run('laceyenterprises/adversarial-review');
    const { observeHoldRelease } = await import(${JSON.stringify(fileUrl('src', 'operator-hold-release.mjs'))});
    observeHoldRelease({ db, repo: 'laceyenterprises/adversarial-review', prNumber: 101,
      headSha: 'sha-happy-101', liveLabels: [] });
    observeHoldRelease({ db, repo: 'laceyenterprises/adversarial-review', prNumber: 101,
      headSha: 'sha-happy-101', liveLabels: ['no-merge-hold'] });
  `, verify: `
    assert.ok(claims.some(c => c.prNumber === 101));
    assert.ok((globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
    assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number = 101').get().review_status, 'posted');
    assert.ok(db.prepare('SELECT cancelled_at FROM operator_hold_releases WHERE pr_number = 101').get().cancelled_at);
  ` });
});

for (const [name, status, message, chargedCounter] of [
  ['infra failure', 'failed', '[hcp-unavailable] offline fixture', 'infra_auto_recover_attempts'],
  ['lease-released infra failure', 'pending', '[hcp-unavailable] offline fixture', 'infra_auto_recover_attempts'],
  ['upstream hold', 'pending-upstream', '[cascade] upstream failure', null],
  ['population failure', 'failed', 'generated-but-not-posted: no GitHub review found', 'review_population_retry_attempts'],
  ['unknown failure', 'failed', 'Command failed with code 1', null],
]) for (const fence of ['read-error', 'reapplied-hold']) {
  test(`HOLDRELEASE-01: unexecuted ${name} claim restores its snapshot after ${fence}`, () => {
    runHoldReleaseRegression({
      transformLoader: source => source.replace('globalThis.__watcherClaimLoopDb = db;', JSON.stringify(`
          globalThis.__watcherClaimLoopDb = db;
          const prepare = db.prepare.bind(db);
          db.prepare = sql => {
            const stmt = prepare(sql);
            if (/SET review_status = 'reviewing'/.test(sql) || sql.startsWith('UPDATE reviewed_prs SET review_status = ?')) {
              const run = stmt.run.bind(stmt);
              stmt.run = (...args) => {
                if (args.includes(101) && /SET review_status = 'reviewing'/.test(sql)) (globalThis.__beforeClaimSnapshots ||= []).push(
                  prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get());
                const result = run(...args);
                if (sql.startsWith('UPDATE reviewed_prs SET review_status = ?')) globalThis.__restoredClaimSnapshot = prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
                return result;
              };
            }
            return stmt;
          };
        `).slice(1, -1)).replace(
        'const overrides = globalThis.__watcherClaimLoopFreshHeads || {};',
        "if (prNumber === 101 && globalThis.__claimFence === 'read-error') throw new Error('fixture transient gh error'); const overrides = globalThis.__watcherClaimLoopFreshHeads || {};",
      ).replace('headRefOid, labels: []',
        "headRefOid, labels: prNumber === 101 && globalThis.__claimFence === 'reapplied-hold' ? ['no-merge-hold'] : []"),
      transformRunner: source => source.replace('claims.push(payload);', `
        claims.push(payload);
        if (payload.prNumber === 101) {
          (globalThis.__claimSnapshots ||= []).push(db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get());
          if (globalThis.__claimSnapshots.length === 1) globalThis.__claimFence = '${fence}';
        }
      `),
      setup: `
        db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
          review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref, failed_at,
          failure_message, infra_auto_recover_attempts, quota_reset_at_utc, last_attempted_at,
          review_population_retry_attempts, review_population_retry_last_at, review_population_retry_head_sha,
          reviewer_session_uuid, reviewer_started_at, reviewer_timeout_ms, reviewer_lease_expires_at, reviewer_pgid)
          VALUES ('laceyenterprises/adversarial-review', 101, '2026-05-15T12:00:00Z', 'claude', 'open',
            ?, 1, '["no-merge-hold"]', 'sha-happy-101', 'prior-revision', '2026-05-15T12:01:00Z', ?, 1,
            '2026-05-15T12:02:00Z', '2026-05-15T12:00:00Z', 0, '2026-05-15T12:00:00Z', 'sha-happy-101',
            'prior-session', '2026-05-15T12:00:00Z', 1234, '2026-05-15T12:02:00Z', 12345)\`).run('${status}', '${message}');
      `,
      verify: `
        const beforeClaim = globalThis.__beforeClaimSnapshots[0];
        const restored = globalThis.__restoredClaimSnapshot || db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
        for (const column of ['review_status', 'reviewer_head_sha', 'failed_at', 'failure_message',
          'quota_reset_at_utc', 'last_attempted_at', 'revision_ref', 'review_population_retry_last_at',
          'review_population_retry_head_sha', 'review_attempts', 'infra_auto_recover_attempts',
          'review_population_retry_attempts', 'reviewer_session_uuid', 'reviewer_started_at',
          'reviewer_timeout_ms', 'reviewer_lease_expires_at', 'reviewer_pgid',
          'reviewer', 'linear_ticket', 'codex_broker_provider']) {
          assert.equal(restored[column], beforeClaim[column], 'restored ' + column);
        }
        const afterTick = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
        for (const column of ['review_status', 'failed_at', 'failure_message', 'reviewer_head_sha']) {
          assert.equal(afterTick[column], beforeClaim[column], 'failure survives tick: ' + column);
        }
        assert.equal(globalThis.__claimSnapshots.length, 1, 'first retry claimed');
        assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
        globalThis.__claimFence = null;
        await pollOnce(octokit, pollOptions);
        assert.equal(globalThis.__claimSnapshots.length, 2, 'next retry claimed');
        const nextClaim = globalThis.__claimSnapshots[1];
        assert.equal(nextClaim.review_status, 'reviewing');
        ${chargedCounter ? `assert.equal(nextClaim.${chargedCounter}, beforeClaim.${chargedCounter} + 1, 'next retry uses bounded CAS');` : ''}
        assert.ok((globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
      `,
    });
  });
}

test('HOLDRELEASE-01: rollback cannot overwrite a replacement session', () => {
  runHoldReleaseRegression({
    transformLoader: source => source.replace(
      'const overrides = globalThis.__watcherClaimLoopFreshHeads || {};',
      "if (prNumber === 101 && globalThis.__replacementSession) throw new Error('fixture transient gh error'); const overrides = globalThis.__watcherClaimLoopFreshHeads || {};",
    ),
    transformRunner: source => source.replace('claims.push(payload);', `
      claims.push(payload);
      if (payload.prNumber === 101) {
        db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = 'replacement-session' WHERE pr_number = 101").run();
        globalThis.__replacementSession = true;
      }
    `),
    setup: `
      db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
        review_status, review_attempts, labels_json, reviewer_head_sha, failed_at, failure_message,
        infra_auto_recover_attempts) VALUES ('laceyenterprises/adversarial-review', 101,
        '2026-05-15T12:00:00Z', 'claude', 'open', 'failed', 1, '["no-merge-hold"]',
        'sha-happy-101', '2026-05-15T12:01:00Z', '[hcp-unavailable] fixture', 1)\`).run();
    `,
    verify: `
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
      assert.equal(row.review_status, 'reviewing');
      assert.equal(row.reviewer_session_uuid, 'replacement-session');
      assert.equal(row.infra_auto_recover_attempts, 2);
      assert.equal(row.failed_at, null);
      assert.equal(row.failure_message, null);
      assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
    `,
  });
});

test('HOLDRELEASE-01: observation failure retains held snapshot and retries next tick', () => {
  runHoldReleaseRegression({ setup: `
    db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
      review_status, review_attempts, labels_json, revision_ref)
      VALUES (?, 101, '2026-10-11T16:00:00Z', 'claude', 'open', 'pending', 0,
        '["no-merge-hold"]', 'sha-happy-101')\`).run('laceyenterprises/adversarial-review');
    const { ensureHoldReleaseSchema } = await import(${JSON.stringify(fileUrl('src', 'operator-hold-release.mjs'))});
    ensureHoldReleaseSchema(db);
    db.exec("CREATE TRIGGER fail_release BEFORE INSERT ON operator_hold_releases BEGIN SELECT RAISE(ABORT, 'fixture observation failure'); END");
  `, verify: `
    assert.deepEqual(JSON.parse(db.prepare('SELECT labels_json FROM reviewed_prs WHERE pr_number = 101').get().labels_json), ['no-merge-hold']);
    assert.equal(db.prepare('SELECT count(*) n FROM operator_hold_releases').get().n, 0);
    db.exec('DROP TRIGGER fail_release');
    await pollOnce(octokit, pollOptions);
    assert.equal(db.prepare('SELECT count(*) n FROM operator_hold_releases WHERE pr_number = 101').get().n, 1);
  ` });
});
test('HOLDRELEASE-01: stale drift captures release without routing until cleared', () => {
  runHoldReleaseRegression({
    transformLoader: source => source.replace('export function shouldSkipReviewerForStaleDrift() { return null; }',
      "export function shouldSkipReviewerForStaleDrift() { return globalThis.__staleRelease ? { message: 'fixture stale drift' } : null; }"),
    setup: `
      globalThis.__staleRelease = true;
      db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
        review_status, review_attempts, labels_json, revision_ref)
        VALUES (?, 101, '2026-10-11T16:00:00Z', 'claude', 'open', 'pending', 0,
          '["no-merge-hold"]', 'sha-happy-101')\`).run('laceyenterprises/adversarial-review');
    `, verify: `
      assert.equal(db.prepare('SELECT routed_at FROM operator_hold_releases WHERE pr_number = 101').get().routed_at, null);
      assert.ok(!claims.some(c => c.prNumber === 101));
      globalThis.__staleRelease = false;
      await pollOnce(octokit, pollOptions);
      assert.ok(db.prepare('SELECT routed_at FROM operator_hold_releases WHERE pr_number = 101').get().routed_at);
    `,
  });
});

test('HAMCLOSE-02 budget resolution preserves only integer increases', async () => {
  const { resolveMaxRemediationRounds } = await import('../src/hamclose-review-admission.mjs');
  for (const [latestMaxRounds, expected] of [
    [4, 4], ['4', 4], [1, 2], [2, 2], [null, 2], [undefined, 2], ['', 2],
    [2.5, 2], [Infinity, 2], ['invalid', 2],
  ]) assert.equal(resolveMaxRemediationRounds({ roundBudget: 2, latestMaxRounds }), expected);
});

for (const postedCount of [3, 5]) test(`HAMCLOSE-02 raised maxRounds: ${postedCount} delivered reviews`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hamclose-raised-budget-'));
  try {
    const head = 'b'.repeat(40), reviewedHead = 'a'.repeat(40);
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    const followUpJobsSource = DEFAULT_FOLLOW_UP_JOBS_SOURCE.replace('latestMaxRounds: 1', 'latestMaxRounds: 4');
    // Automatic stale-head requests omit db in production. Bind this replay
    // to the fixture DB so its re-review reset and claim share the same state.
    writeFileSync(loaderPath, buildLoaderSource({ subjectHeads: { 101: head }, followUpJobsSource }).replace(
      'return actual.requestReviewRereview(options);',
      'return actual.requestReviewRereview({ ...options, db: options.db || db });',
    ));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ freshHeads: { 101: head }, prePollSetup: `
      db.prepare(\`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status,
        review_attempts,revision_ref,reviewer_head_sha,posted_at)
        VALUES ('laceyenterprises/adversarial-review',101,'2026-10-12T04:45:00Z','claude','open','posted',?,?,?,
        '2026-10-12T05:00:00Z')\`).run(${postedCount}, ${JSON.stringify(reviewedHead)}, ${JSON.stringify(reviewedHead)});
      for (let attempt = 1; attempt <= ${postedCount}; attempt++) db.prepare(\`INSERT INTO reviewer_passes(repo,pr_number,
        attempt_number,reviewer_class,pass_kind,started_at,ended_at,status,head_sha,gh_comment_id)
        VALUES ('laceyenterprises/adversarial-review',101,?,'claude','rereview','2026-10-12T04:45:00Z',
        '2026-10-12T05:00:00Z','completed',?,?)\`).run(attempt, ${JSON.stringify(reviewedHead)}, 'posted-' + attempt);
    `, afterFirstPoll: postedCount < 5 ? `
      const spawns = (globalThis.__watcherClaimLoopReviewerSpawns || []).filter(spawn => spawn.subjectContext?.prNumber === 101);
      assert.equal(spawns.length, 1, 'raised budget admits the moved head');
      assert.equal(spawns[0].subjectContext.reviewerHeadSha, ${JSON.stringify(head)});
      assert.equal(spawns[0].subjectContext.passKind, 'rereview');
      assert.equal(spawns[0].subjectContext.maxRemediationRounds, 4);
      assert.equal(claims.filter(claim => claim.prNumber === 101).length, 1);
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
      assert.equal(row.reviewer_head_sha, ${JSON.stringify(head)});
      assert.notEqual(row.rereview_reason, 'system-review-ceiling-closure');
      assert.match(row.rereview_reason, /auto-refresh: posted review on stale head/);
    ` : `
      assert.ok(!claims.some(claim => claim.prNumber === 101));
      assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(spawn => spawn.subjectContext?.prNumber === 101));
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
      assert.equal(row.review_status, 'posted');
      assert.equal(row.reviewer_head_sha, ${JSON.stringify(reviewedHead)});
      assert.equal(row.rereview_reason, 'system-review-ceiling-closure');
    ` }));
    const env = installGhFixture(tmp);
    const ghPath = path.join(tmp, 'gh');
    writeFileSync(ghPath, readFileSync(ghPath, 'utf8').replace('set -euo pipefail', `set -euo pipefail
if [[ "\${1:-}" == api && "\${2:-}" == repos/laceyenterprises/adversarial-review/pulls/101 ]]; then
  printf '{"state":"open","draft":false,"labels":[],"changed_files":1,"head":{"sha":"${head}"},"base":{"sha":"${reviewedHead}"}}\\n'
  exit 0
fi`));
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const [scenario, draft, hold, liveDraft = false, liveHold = null] of [
  ['eligible', false, null], ['draft', true, null],
  ['do-not-merge', false, 'do-not-merge'], ['no-merge-hold', false, 'no-merge-hold'],
  ['merge-agent-skip', false, 'merge-agent-skip'],
  ['live draft', false, null, true], ['live hold', false, null, false, 'do-not-merge'],
]) test(`HAMCLOSE-02 replay B pollOnce empty head: ${scenario}`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hamclose-empty-'));
  try {
    const head = 'b'.repeat(40);
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource({ subjectHeads: { 101: head },
      subject101Overrides: { isDraft: draft, labels: hold ? [hold] : ['risk:medium'] } }));
    writeFileSync(registerPath, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`);
    const closedPath = path.join(tmp, 'closed');
    const probePath = path.join(tmp, 'probe');
    const afterPoll = draft || hold ? `
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(${JSON.stringify(closedPath)}), false);
      assert.equal(existsSync(${JSON.stringify(probePath)}), false, 'draft/held subjects skip the probe');
    ` : liveDraft || liveHold ? `
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(${JSON.stringify(closedPath)}), false);
      assert.ok(existsSync(${JSON.stringify(probePath)}), 'eligible snapshot reaches the live recheck');
      assert.ok(claims.some(claim => claim.prNumber === 101), 'deferring empty closure does not break review dispatch');
    ` : `
      const { existsSync, readFileSync } = await import('node:fs');
      assert.ok(existsSync(${JSON.stringify(closedPath)}));
      await pollOnce(octokit, pollOptions);
      assert.equal(readFileSync(${JSON.stringify(closedPath)}, 'utf8'), 'one comment\\n');
      assert.ok(!claims.some(claim => claim.prNumber === 101));
      assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(spawn => spawn.subjectContext?.prNumber === 101));
    `;
    writeFileSync(runnerPath, buildRunnerSource({ freshHeads: { 101: head }, afterFirstPoll: afterPoll }));
    const env = installGhFixture(tmp);
    const ghPath = path.join(tmp, 'gh');
    writeFileSync(ghPath, readFileSync(ghPath, 'utf8').replace('set -euo pipefail', `set -euo pipefail
if [[ "\${1:-}" == api && "\${2:-}" == repos/laceyenterprises/adversarial-review/pulls/101 ]]; then
  printf 'probe\\n' >> '${probePath}'
  state=open
  [[ ! -f '${closedPath}' ]] || state=closed
  printf '{"state":"%s","draft":${liveDraft},"labels":${JSON.stringify(liveHold ? [{ name: liveHold }] : [])},"changed_files":0,"head":{"sha":"${head}"},"base":{"sha":"${'a'.repeat(40)}"}}\\n' "$state"
  exit 0
elif [[ "\${1:-}" == api && "\${2:-}" == *'/compare/'* ]]; then
  printf '{"files":[]}\\n'
  exit 0
elif [[ "\${1:-}" == pr && "\${2:-}" == close ]]; then
  touch '${closedPath}'
  exit 0
elif [[ "\${1:-}" == pr && "\${2:-}" == comment ]]; then
  printf 'one comment\\n' >> '${closedPath}'
  exit 0
fi
`));
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    assert.doesNotMatch(`${result.stdout || ''}${result.stderr || ''}`, /unexpected gh fixture call/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const phase of ['initial', 'compare', 'fresh', 'close']) {
  test(`empty PR ${phase} transport failure defers admission and retries next tick`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-empty-failure-'));
    try {
      const head = 'b'.repeat(40);
      const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
      const failedPath = path.join(tmp, 'failed'), closedPath = path.join(tmp, 'closed'), readsPath = path.join(tmp, 'reads');
      writeFileSync(loaderPath, buildLoaderSource({ subjectHeads: { 101: head }, subject101Overrides: { changedFiles: 0 } }));
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({ freshHeads: { 101: head }, prePollSetup: `
        db.prepare(\`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status,review_attempts)
          VALUES ('laceyenterprises/adversarial-review',101,'2026-10-12','claude','open','pending',0)\`).run();
      `, afterFirstPoll: `
        const { existsSync, readFileSync } = await import('node:fs');
        assert.ok(existsSync(${JSON.stringify(failedPath)}), 'the first tick encounters the failure');
        assert.equal(existsSync(${JSON.stringify(closedPath)}), false);
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
        assert.equal(row.review_status, 'pending');
        assert.equal(row.review_attempts, 0);
        assert.equal(db.prepare('SELECT head FROM nonempty_pr_heads WHERE pr_number=101').get(), undefined);
        assert.ok(!claims.some(claim => claim.prNumber === 101));
        await pollOnce(octokit, pollOptions);
        assert.equal(readFileSync(${JSON.stringify(closedPath)}, 'utf8'), 'one comment\\n');
        assert.ok(!claims.some(claim => claim.prNumber === 101));
        assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(spawn => spawn.subjectContext?.prNumber === 101));
      ` }));
      const env = installGhFixture(tmp), ghPath = path.join(tmp, 'gh');
      writeFileSync(ghPath, readFileSync(ghPath, 'utf8').replace('set -euo pipefail', `set -euo pipefail
phase=
if [[ "\${1:-}" == api && "\${2:-}" == repos/laceyenterprises/adversarial-review/pulls/101 ]]; then
  phase=initial
  [[ ! -f '${readsPath}' ]] || phase=fresh
  touch '${readsPath}'
elif [[ "\${1:-}" == api && "\${2:-}" == *'/compare/'* ]]; then phase=compare
elif [[ "\${1:-}" == pr && "\${2:-}" == close ]]; then phase=close
fi
if [[ "$phase" == '${phase}' && ! -f '${failedPath}' ]]; then
  touch '${failedPath}'
  echo 'Operation timed out' >&2
  exit 1
fi
if [[ "$phase" == initial || "$phase" == fresh ]]; then
  printf '{"state":"open","draft":false,"labels":[],"changed_files":0,"head":{"sha":"${head}"},"base":{"sha":"${'a'.repeat(40)}"}}\\n'
  exit 0
elif [[ "$phase" == compare ]]; then printf '{"files":[]}\\n'; exit 0
elif [[ "$phase" == close ]]; then touch '${closedPath}'; exit 0
elif [[ "\${1:-}" == pr && "\${2:-}" == comment ]]; then printf 'one comment\\n' >> '${closedPath}'; exit 0
fi
`));
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 60000 });
      assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

for (const stranded of [false, true]) test(`HAMCLOSE-04 real pollOnce admits a final-round handoff once, stranded=${stranded}`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hamclose-review-'));
  try {
    const head = 'b'.repeat(40);
    const probePath = path.join(tmp, 'nonempty-probes');
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    let loader = buildLoaderSource({ subjectHeads: { 101: head } });
    const leaseUrl = fileUrl('src', 'ama', 'closer-lease.mjs');
    const waitUrl = fileUrl('src', 'ama', 'closure-wait.mjs');
    loader = loader.replace('export async function resolve',
      `stubs.set(${JSON.stringify(leaseUrl)}, 'fixture:handoff-lease');\nstubs.set(${JSON.stringify(waitUrl)}, 'fixture:handoff-wait');\nexport async function resolve`);
    const leaseSource = `export * from ${JSON.stringify(leaseUrl + '?actual')};
      import { readAmaCloserLease as read } from ${JSON.stringify(leaseUrl + '?actual')};
      export function readAmaCloserLease(_root, identity) { return read(${JSON.stringify(tmp)}, identity); }`;
    const waitSource = `import { observeClosureWait as observe } from ${JSON.stringify(waitUrl + '?actual')};
      export function observeClosureWait(args) { return observe({ ...args, rootDir: ${JSON.stringify(tmp)}, pageImpl: async () => {} }); }`;
    loader = loader.replace('export async function load(url, context, nextLoad) {',
      `export async function load(url, context, nextLoad) {\nif (url === 'fixture:handoff-lease') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(leaseSource)} };\nif (url === 'fixture:handoff-wait') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(waitSource)} };`);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ freshHeads: { 101: head }, prePollSetup: `
      db.prepare(\`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status,
        review_attempts,revision_ref,rereview_requested_at,rereview_reason)
        VALUES ('laceyenterprises/adversarial-review',101,'2026-10-12T04:45:00Z','claude','open','pending',36,?,
        '2026-10-12T06:15:00Z',?)\`).run(${JSON.stringify(head)}, ${JSON.stringify('system-orphan-head-review:' + head)});
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const rootDir = ${JSON.stringify(tmp)};
      const repo = db.prepare('SELECT repo FROM reviewed_prs WHERE pr_number=101').get().repo;
      const identity = { rootDir, repo, prNumber: 101, headSha: ${JSON.stringify(head)} };
      const completed = rootDir + '/data/follow-up-jobs/completed';
      mkdirSync(completed, { recursive: true });
      writeFileSync(completed + '/' + repo.replace('/', '__') + '-pr-101-final.json', JSON.stringify({
        repo, prNumber: 101, status: 'completed', revisionRef: 'a'.repeat(40),
        reviewBody: ${JSON.stringify('## Blocking issues\n- None.\n## Non-blocking issues\n- **Cleanup**\n  - **File:** `src/fixture.mjs`\n  - **Lines:** `1`\n  - **Problem:** redundant branch\n  - **Recommended fix:** remove the branch\n## Verdict\nComment only')}, currentRound: 1, maxRounds: 2,
        finalRound: 'comment-only', reReview: { suppressed: 'comment-only-final-round' },
        completion: { workerPushedHeadSha: identity.headSha },
      }));
      db.prepare("UPDATE reviewed_prs SET review_status='posted', reviewer_head_sha=? WHERE pr_number=101").run('a'.repeat(40));
      const { acquireAmaCloserLease } = await import(${JSON.stringify(fileUrl('src', 'ama', 'closer-lease.mjs'))});
      const { handoffHammerReview } = await import(${JSON.stringify(fileUrl('bin', 'hammer-review-handoff.mjs'))});
      const { requestReviewRereview } = await import(${JSON.stringify(fileUrl('src', 'review-state.mjs') + '?actual')});
      assert.equal(requestReviewRereview({ ...identity, db, targetRevisionRef: identity.headSha }).reason, 'comment-only-final-round-completed');
      const { requestBoundedOrphanReview } = await import(${JSON.stringify(fileUrl('src', 'ama', 'orphan-review-request.mjs'))});
      const boundedRequest = args => requestBoundedOrphanReview({ ...args,
        requestRereviewImpl: options => requestReviewRereview({ ...options, db }),
      });
      if (${stranded}) await boundedRequest(identity);
      acquireAmaCloserLease(identity);
      await handoffHammerReview({ ...identity, requestBoundedReviewImpl: boundedRequest });
      db.prepare(\`INSERT INTO review_cycle_verdicts(pr_url,head_sha,verdict_count,verdict_at)
        VALUES (?, ?, 6, ?)\`).run('https://github.com/' + repo + '/pull/101', 'a'.repeat(40), new Date().toISOString());
      for (let attempt = 1; attempt <= 36; attempt++) db.prepare(\`INSERT INTO reviewer_passes(repo,pr_number,
        attempt_number,reviewer_class,pass_kind,started_at,ended_at,status,head_sha,metadata_json)
        VALUES ('laceyenterprises/adversarial-review',101,?,'claude','rereview','2026-10-12T05:12:10Z',
        '2026-10-12T05:12:13Z','failed',?,'{"failureClass":"reviewer-command-failed"}')\`).run(attempt, ${JSON.stringify(head)});
    `, afterFirstPoll: `
      assert.equal((globalThis.__watcherClaimLoopReviewerSpawns || []).filter(spawn => spawn.subjectContext?.prNumber === 101).length, 1);
      assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=101').get().review_status, 'posted');
      assert.equal(requestReviewRereview({ ...identity, db, targetRevisionRef: identity.headSha, reason: 'system-orphan-head-review:' + identity.headSha }).reason, 'comment-only-final-round-completed');
      await pollOnce(octokit, pollOptions);
      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(${JSON.stringify(probePath)}, 'utf8'), 'probe\\n', 'verified nonempty head is probed once across ticks');
      assert.equal((globalThis.__watcherClaimLoopReviewerSpawns || []).filter(spawn => spawn.subjectContext?.prNumber === 101).length, 1);
    ` }));
    const env = installGhFixture(tmp), ghPath = path.join(tmp, 'gh');
    writeFileSync(ghPath, readFileSync(ghPath, 'utf8').replace('set -euo pipefail', `set -euo pipefail
if [[ "\${1:-}" == api && "\${2:-}" == repos/laceyenterprises/adversarial-review/pulls/101 ]]; then
  printf 'probe\\n' >> '${probePath}'
  printf '{"state":"open","changed_files":1,"head":{"sha":"${head}"},"base":{"sha":"${'a'.repeat(40)}"}}\\n'
  exit 0
fi`));
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


test('REVIEWDELAY-01: pollOnce records process starts before detached reviewers return', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'reviewdelay-start-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource({
      reviewerRuntimeSource: `
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        globalThis.__reviewdelayReturns = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return { spawnReviewer: async (payload) => {
            globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
            for (let update = 0; update < 3; update += 1) {
              payload.onReviewerPgid({ pgid: 123456, spawnedAt: '2026-10-01T00:00:00.000Z' });
            }
            await new Promise(resolve => globalThis.__reviewdelayReturns.push(resolve));
            return { ok: false, failureClass: 'fixture-failure', stderr: '' };
          }, cancel: async () => {}, reattach: async () => ({}) };
        }
        export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
        export function loadDomainConfig() { return {}; }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
      `,
    }).replace('export async function resolve', `
      stubs.set(${JSON.stringify(fileUrl('src', 'watcher-reviewer-pool.mjs'))}, 'fixture:health-pool');
      export async function resolve
    `).replace('export async function load(url, context, nextLoad) {', `
      export async function load(url, context, nextLoad) {
        if (url === 'fixture:health-pool') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          export * from ${JSON.stringify(fileUrl('src', 'watcher-reviewer-pool.mjs') + '?actual')};
          import { createDetachedReviewerDispatchTracker as create } from ${JSON.stringify(fileUrl('src', 'watcher-reviewer-pool.mjs') + '?actual')};
          export function createDetachedReviewerDispatchTracker(options) {
            const tracker = create(options);
            const list = tracker.liveSpawnEntries;
            tracker.liveSpawnEntries = () => {
              globalThis.__reviewdelayHealthScans = (globalThis.__reviewdelayHealthScans || 0) + 1;
              return list();
            };
            return tracker;
          }
        `)} };
    `));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({
      healthProbeSetup: `
        const { createWatcherHealthProbe } = await import(${JSON.stringify(fileUrl('src', 'health-probe.mjs') + '?actual')});
        globalThis.__reviewdelayStarts = [];
        globalThis.__reviewdelayEvents = [];
        globalThis.__reviewdelayTicks = [];
        const probe = createWatcherHealthProbe({
          env: {}, now: () => new Date('2026-10-01T00:00:00.000Z'),
          stdout: { write: line => globalThis.__reviewdelayEvents.push(JSON.parse(line)) },
          deliverAlertFn: async () => { throw new Error('unexpected health page'); },
        });
        pollOptions.healthProbe = {
          ...probe,
          recordSpawn(tick, payload) {
            globalThis.__reviewdelayStarts.push(payload);
            probe.recordSpawn(tick, payload);
          },
          async finishTick(tick, options) {
            await probe.finishTick(tick, options);
            globalThis.__reviewdelayTicks.push(tick);
          },
        };
      `,
      afterFirstPoll: `
        assert.ok(globalThis.__reviewdelayReturns.length > 0);
        assert.equal(globalThis.__reviewdelayStarts.length, 3 * globalThis.__reviewdelayReturns.length);
        assert.ok(globalThis.__reviewdelayStarts.every(start => start.at === '2026-10-01T00:00:00.000Z'));
        assert.deepEqual(globalThis.__reviewdelayEvents, []);
        assert.equal(globalThis.__reviewdelayTicks[0].openPendingPRs, 0);
        assert.equal(globalThis.__reviewdelayTicks[0].openPendingRereviewPRs, 0);
        assert.deepEqual(globalThis.__reviewdelayTicks[0].samplePRs, []);
        assert.equal(globalThis.__reviewdelayTicks[0].spawnCount, globalThis.__reviewdelayReturns.length);
        assert.equal(globalThis.__reviewdelayHealthScans || 0, 0, 'started PRs need no extra persisted-record scan');
        const starts = globalThis.__reviewdelayStarts.length;
        for (const resolve of globalThis.__reviewdelayReturns) resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(globalThis.__reviewdelayStarts.length, starts, 'returning must not count another spawn');
      `,
    }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv({ ...installGhFixture(tmp),
        ADVERSARIAL_REVIEWER_DISPATCH_SINGLE_WAVE_SETTLE_GRACE_MS: '1' }), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test('GHSCOPE-01: a rate-limited first discovery still fetches other repository lists in pollOnce', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-scoped-budget-'));
  const loaderPath = path.join(tmp, 'loader.mjs');
  const registerPath = path.join(tmp, 'register.mjs');
  const runnerPath = path.join(tmp, 'runner.mjs');
  try {
    const loader = buildLoaderSource({
      discoveryHookSource: 'return globalThis.__scopeDiscovery(repos[0]);',
    }).replace('export async function load(url, context, nextLoad) {', `
      export async function load(url, context, nextLoad) {
        if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
          const result = await nextLoad(url, context);
          result.source = String(result.source).replace(
            "JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
            '({ org: "example", repos: [] })');
          return result;
        }
    `);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    let runner = buildRunnerSource({
      prePollSetup: `
        const { meteredExecFile } = await import(${JSON.stringify(fileUrl('src', 'metered-gh.mjs'))});
        const lists = [];
        globalThis.__scopeDiscovery = async repo => {
          if (!globalThis.__scopeFirstFailed) {
            globalThis.__scopeFirstFailed = true;
            await meteredExecFile(async () => { throw new Error('GraphQL: API rate limit exceeded'); },
              'gh', ['api', 'graphql'], { env: { GH_TOKEN: 'synthetic-installation-a' } });
          }
          await meteredExecFile(async () => { lists.push(repo); return { stdout: '[]', stderr: '' }; },
            'gh', ['api', 'repos/' + repo + '/pulls'], { env: { GH_TOKEN: 'synthetic-installation-a' } });
          return [];
        };
      `,
      afterFirstPoll: `
        assert.ok(globalThis.__scopeFirstFailed);
        assert.ok(lists.some(repo => repo.endsWith('/beta')), JSON.stringify(lists));
        assert.ok(lists.some(repo => repo.endsWith('/gamma')), JSON.stringify(lists));
      `,
    });
    runner = runner.replace("return [{ name: 'adversarial-review', archived: false }];",
      "return ['alpha', 'beta', 'gamma'].map(name => ({ name, archived: false }));");
    writeFileSync(runnerPath, runner.replaceAll('laceyenterprises', 'example'));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv({ AGENT_OS_CONFIG_PATH: path.join(tmp, 'config.yaml') }), timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
