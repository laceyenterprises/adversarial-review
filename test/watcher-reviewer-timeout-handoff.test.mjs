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
  const headCloserUrl = fileUrl('src', 'head-closer-commit-suppression.mjs');
  const headCloserActualUrl = `${headCloserUrl}?actual`;
  const ciRegressionUrl = fileUrl('src', 'remediation-ci-regression.mjs');
  const ciRegressionActualUrl = `${ciRegressionUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');

  const stubs = {
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [headCloserUrl]: 'fixture:head-closer-commit-suppression',
    [fileUrl('src', 'adapters', 'operator', 'index.mjs')]: 'fixture:operator-surface',
    [fileUrl('src', 'adapters', 'reviewer-runtime', 'index.mjs')]: 'fixture:reviewer-runtime',
    [fileUrl('src', 'branch-protection.mjs')]: 'fixture:branch-protection',
    [fileUrl('src', 'adversarial-gate-status.mjs')]: 'fixture:adversarial-gate-status',
    [fileUrl('src', 'adversarial-gate-context.mjs')]: 'fixture:adversarial-gate-context',
    [fileUrl('src', 'follow-up-jobs.mjs')]: 'fixture:follow-up-jobs',
    [fileUrl('src', 'remediation-prompt.mjs')]: 'fixture:remediation-prompt',
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
    [fileUrl('src', 'gh-cli.mjs')]: 'fixture:gh-cli',
    [fileUrl('src', 'ama', 'ham-provenance.mjs')]: 'fixture:ama-ham-provenance',
  };

  return `
const stubs = new Map(${JSON.stringify(Object.entries(stubs))});
if (process.env.FIXTURE_CAP_SCENARIO === 'ham') {
  stubs.delete(${JSON.stringify(fileUrl('src', 'ama', 'ham-provenance.mjs'))});
}
if (process.env.FIXTURE_CI_MULTI_TICK || process.env.FIXTURE_CI_PRE_PUSH) {
  stubs.set(${JSON.stringify(fileUrl('src', 'alert-delivery.mjs'))}, 'fixture:ci-hammer-alert');
}
if (process.env.FIXTURE_CI_BLOCKED === '1') {
  stubs.set(${JSON.stringify(ciRegressionUrl)}, 'fixture:remediation-ci-regression');
}

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
  if (url === 'fixture:adversarial-gate-status' && process.env.FIXTURE_CI_BLOCKED === '1') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
      export * from ${JSON.stringify(fileUrl('src', 'adversarial-gate-status.mjs') + '?actual')};
      import { buildAdversarialGateSnapshot as actual } from ${JSON.stringify(fileUrl('src', 'adversarial-gate-status.mjs') + '?actual')};
      export async function buildAdversarialGateSnapshot(rootDir, options) {
        const snapshot = await actual(process.env.FIXTURE_JOB_ROOT, options);
        (globalThis.__ciGateOwnership ||= []).push(snapshot.settledReview?.remediationPending);
        return snapshot;
      }
      export async function projectAdversarialGateStatus() { return { decision: { state: 'pending' } }; }
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
        export function openReviewStateDb(rootDir) {
          if (rootDir && rootDir !== process.cwd()) return actual.openReviewStateDb(rootDir);
          if (!db) {
            db = new Database(':memory:');
            db.close = () => {}; // Fixture singleton is owned by this subprocess.
            actual.ensureReviewStateSchema(db);
            globalThis.__timeoutHandoffDb = db;
          }
          return db;
        }
      `)}
    };
  }

  if (url === 'fixture:head-closer-commit-suppression') {
    // The fixture heads are not real commits: never probe a host checkout or gh.
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        export * from ${JSON.stringify(headCloserActualUrl)};
        import { isTerminalCloserCommitIdentity } from ${JSON.stringify(headCloserActualUrl)};
        const ham = isTerminalCloserCommitIdentity({ message: 'HAM close\\nClosed-By: hammer (adversarial-pipe-mode)' });
        if (process.env.FIXTURE_CAP_SCENARIO === 'ham') {
          if (!ham.suppressed) throw new Error('fixture HAM must suppress reviewers');
        }
        const none = { suppressed: false, reason: 'fixture-no-closer-commit' };
        export async function getHeadCloserCommitSuppression() { return (process.env.FIXTURE_CAP_SCENARIO === 'ham' || globalThis.__ciHammerPushed) ? ham : none; }
        export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return (process.env.FIXTURE_CAP_SCENARIO === 'ham' || globalThis.__ciHammerPushed) ? ham : none; }
        export function createHeadCloserCommitSuppressionResolver() { return async () => (process.env.FIXTURE_CAP_SCENARIO === 'ham' || globalThis.__ciHammerPushed) ? ham : none; }
        export async function fetchHeadCloserVerifiedCommit({ headSha }) {
          return { sha: headSha, parentSha: 'cap-head-5', parentCount: 1,
            message: 'HAM close\\nClosed-By: hammer (adversarial-pipe-mode)' };
        }
      `)}
    };
  }

  if (url === 'fixture:remediation-ci-regression') {
    // CIBLOCKHAM-01: repo-guards failed on the parked head; never call gh.
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        export * from ${JSON.stringify(ciRegressionActualUrl)};
        export async function inspectRemediationCiRegression() {
          globalThis.__ciInspections = (globalThis.__ciInspections || 0) + 1;
          return { state: globalThis.__ciGreen ? 'green' : 'failed', conclusion: globalThis.__ciGreen ? 'SUCCESS' : 'FAILURE', headSha: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164'), totalExternalChecks: 3,
            failedChecks: globalThis.__ciGreen ? [] : [{ name: 'repo-guards', state: 'FAILURE', workflowName: 'repo-guards', detailsUrl: null }],
            pendingChecks: [] };
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
              return [{ domainId: 'code-pr', subjectExternalId: REPO + '#164', revisionRef: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164') }];
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
                  ...(process.env.FIXTURE_CI_RETRIGGER ? ['retrigger-remediation'] : []),
                  ...(process.env.FIXTURE_CAP_LABEL === '1' ? ['reviewer-cycle-cap-reached'] : []),
                  ...(
                    process.env.FIXTURE_MERGE_AGENT_LABEL_PRESENT === '1' ||
                    (
                      process.env.FIXTURE_MERGE_AGENT_LABEL_PRESENT !== '0' &&
                      process.env.FIXTURE_MERGE_AGENT_REQUESTED === '1'
                    )
                      ? ['merge-agent-requested']
                      : []
                  ),
                ],
                updatedAt: '2026-05-27T04:00:00.000Z',
                headSha: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164'),
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
    'fixture:ci-hammer-alert': "export * from '${fileUrl('src', 'alert-delivery.mjs')}?actual'; export async function deliverAlert(text, options) { (globalThis.__ciHammerPages ||= []).push(options); return { status: 'queued' }; }",
    'fixture:operator-surface': "globalThis.__timeoutHandoffOperatorWrites = []; export function createCompositeOperatorSurface() { return { extractLinearTicketId() { return null; }, syncTriageStatus: async (...args) => globalThis.__timeoutHandoffOperatorWrites.push(args), observeOperatorApproved: async () => null, observeMergeAgentOverride: async () => process.env.FIXTURE_MERGE_AGENT_REQUESTED === '1' ? { applied: true, observedRevisionRef: 'timeout-head-164', actor: process.env.FIXTURE_MERGE_AGENT_ACTOR || 'operator-bot', eventId: 'evt-merge-agent-requested', observedAt: process.env.FIXTURE_MERGE_AGENT_CREATED_AT || '2026-05-27T04:00:01.000Z' } : null, observeLabelControl: async () => process.env.FIXTURE_CI_RETRIGGER ? { applied: true, actor: 'VirtualPaul', eventId: 'evt-retrigger', observedAt: new Date().toISOString() } : null }; }",
    'fixture:reviewer-runtime': "globalThis.__timeoutHandoffReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__timeoutHandoffReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
    'fixture:branch-protection': "export * from '${fileUrl('src', 'branch-protection.mjs')}?actual'; export function createBranchProtectionChecker() { return {}; } export async function fetchAdversarialGateBranchProtection() {} export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; } export function deleteGateRecordsForPR() {} export function pickAdversarialGateStatus() { return { state: 'success', reason: 'reviewer-timeout', context: 'agent-os/adversarial-gate' }; } export async function projectAdversarialGateStatus() { return { decision: { state: 'success', reason: 'reviewer-timeout' } }; } export async function publishAdversarialGateStatus() { return { posted: true }; }",
    'fixture:adversarial-gate-context': "export * from '${fileUrl('src', 'adversarial-gate-context.mjs')}?actual'; export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export * from '${fileUrl('src', 'follow-up-jobs.mjs')}?actual'; import * as actual from '${fileUrl('src', 'follow-up-jobs.mjs')}?actual'; export const FOLLOW_UP_JOB_DIRS = { pending: 'pending', inProgress: 'in-progress', completed: 'completed', failed: 'failed', stopped: 'stopped', workspaces: 'workspaces', stoppedArchived: 'stopped-archived' }; export function classifyFollowUpCriticality() { return { critical: false, blockingFindingCount: 0, blockingFindingState: 'known', verdict: 'comment-only' }; } export function createFollowUpJob() { return { jobPath: '/tmp/watcher-timeout-follow-up.json' }; } export function listFollowUpJobsInDir(rootDir, dir) { return process.env.FIXTURE_JOB_ROOT ? actual.listFollowUpJobsInDir(process.env.FIXTURE_JOB_ROOT, dir) : []; } export function listInProgressFollowUpJobs() { return []; } export function resolveRoundBudgetForJob() { return { roundBudget: 2, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 1, latestRiskClass: 'medium', latestMaxRounds: 2 }; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); } export function isSettledReviewJob() { return false; } export function markFollowUpJobStopped() { return { status: 'stopped' }; } export function requeueFollowUpJobForNextRound(options) { return process.env.FIXTURE_CI_RETRIGGER ? actual.requeueFollowUpJobForNextRound(options) : { requeued: false }; } export function markFollowUpJobFailed() { return { status: 'failed' }; } export function requeueInProgressFollowUpJobForRetry() { return { requeued: false }; } export function stopPendingNoRemediationJobs() { return []; } export function writeFollowUpJob() {} export function voidSingleReviewCredit() { return { voided: false }; }",
    'fixture:remediation-prompt': "export function followUpJobRepoPrKey(job) { return String(job?.repo || '').toLowerCase() + '#' + (job?.prNumber || ''); }",
    'fixture:follow-up-merge-agent': "export * from '${fileUrl('src', 'follow-up-merge-agent.mjs')}?actual'; globalThis.__timeoutHandoffDispatches = []; export const MERGE_AGENT_DISPATCHED_LABEL = 'merge-agent-dispatched'; export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; function fixtureMergeAgentRequest() { return process.env.FIXTURE_MERGE_AGENT_REQUESTED === '1' ? { id: 'evt-merge-agent-requested', label: 'merge-agent-requested', actor: process.env.FIXTURE_MERGE_AGENT_ACTOR || 'operator-bot', createdAt: process.env.FIXTURE_MERGE_AGENT_CREATED_AT || '2026-05-27T04:00:01.000Z', headSha: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164') } : null; } export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob(rootDir, candidate = {}) { return { ...candidate, repo: 'laceyenterprises/adversarial-review', prNumber: 164, branch: 'codex/timeout-handoff', baseBranch: 'main', headSha: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164'), lastVerdict: 'Request changes', latestFollowUpJobStatus: 'completed', latestFollowUpReReviewRequested: true, reviewFailureClass: 'reviewer-timeout', reviewFailureExhausted: true, mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS', labels: candidate.labels || [], mergeAgentRequest: candidate.mergeAgentRequestEvent ? { kind: 'merge-agent-requested', actor: candidate.mergeAgentRequestEvent.actor, labelEventId: candidate.mergeAgentRequestEvent.id, createdAt: candidate.mergeAgentRequestEvent.createdAt, headSha: candidate.mergeAgentRequestEvent.headSha, prUpdatedAt: candidate.prUpdatedAt } : null }; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export async function dispatchMergeAgentForPR(payload) { globalThis.__timeoutHandoffDispatches.push(payload); return { decision: 'dispatch', trigger: 'reviewer-timeout-exhausted' }; } export function fetchMergeAgentCandidate(repo, prNumber, options) { if (options?.rootDir !== process.cwd()) throw new Error('watcher root must be passed to candidate recovery'); const mergeAgentRequestEvent = fixtureMergeAgentRequest(); return { repo, prNumber, branch: 'codex/timeout-handoff', baseBranch: 'main', headSha: globalThis.__ciHammerPushed ? 'ham-pushed-head-164' : (globalThis.__ciNonHamPushed ? 'non-ham-head-164' : 'timeout-head-164'), mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS', labels: [...(mergeAgentRequestEvent && process.env.FIXTURE_LIVE_REQUEST_REMOVED !== '1' ? ['merge-agent-requested'] : []), ...(process.env.FIXTURE_LIVE_HARD_SKIP ? [process.env.FIXTURE_LIVE_HARD_SKIP] : [])].map(name => ({ name })), operatorNotes: null, prState: 'open', merged: false, prUpdatedAt: '2026-05-27T04:00:01.000Z', mergeAgentRequestEvent }; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export function isScopedMergeAgentRequest(job) { const request = job?.mergeAgentRequest; if (!request) return false; if (!request.actor || String(request.actor).trim().toLowerCase() === 'unknown') return false; if (!request.labelEventId && !request.labelEventNodeId) return false; if (!request.createdAt) return false; if (String(request.headSha || '') !== String(job?.headSha || '')) return false; const prUpdatedAt = request.prUpdatedAt || job?.prUpdatedAt || null; if (prUpdatedAt && Date.parse(request.createdAt) < Date.parse(prUpdatedAt)) return false; return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export function resolveFastMergePerPollCap() { return 5; } export function scanStuckMergeAgentDispatches() { return []; } export function shouldUseReviewerTimeoutExhaustedMergeGate(job) { return job.reviewFailureClass === 'reviewer-timeout' && job.reviewFailureExhausted === true && job.latestFollowUpJobStatus === 'completed' && job.latestFollowUpReReviewRequested === true; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {}",
    'fixture:follow-up-retrigger-label': "import * as actual from '${fileUrl('src', 'follow-up-retrigger-label.mjs')}?actual'; export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function reportStalledRetriggerOutcomes() { return { checked: 0, spawned: 0, reported: 0 }; } export async function tryRetriggerRemediationFromLabel(options) { if (!process.env.FIXTURE_CI_RETRIGGER) return { outcome: 'noop' }; const result = await actual.tryRetriggerRemediationFromLabel({ ...options, rootDir: process.env.FIXTURE_JOB_ROOT, appendAuditRow() {}, execFileImpl: async () => ({ stdout: '', stderr: '' }) }); globalThis.__ciRetriggerOutcome ||= result.outcome; return result; }",
    'fixture:follow-up-retrigger-review-label': "export const RETRIGGER_REVIEW_LABEL = 'retrigger-review'; export async function retryPendingRetriggerReviewAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerReviewFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export * from '${fileUrl('src', 'operator-retrigger-helpers.mjs')}?actual'; import * as actual from '${fileUrl('src', 'operator-retrigger-helpers.mjs')}?actual'; export function findLatestFollowUpJob(rootDir, query) { return process.env.FIXTURE_JOB_ROOT ? actual.findLatestFollowUpJob(process.env.FIXTURE_JOB_ROOT, query) : null; }",
    'fixture:reviewer-cascade': "export * from '${fileUrl('src', 'reviewer-cascade.mjs')}?actual'; export const CASCADE_FAILURE_CAP = 5; export function classifyReviewerFailure() { return 'unknown'; } export function clearCascadeState() {} export function clearReviewerCredentialOutage() { return null; } export function formatTransientFailureBreakdown() { return ''; } export function hasOperatorDecisionRequiredAlerted() { return false; } export function markCascadeCapExhaustedAlerted() { return { marked: true, state: {} }; } export function markOperatorDecisionRequiredAlerted() { return { marked: true, state: {} }; } export function readCascadeState() { return { transientFailureBreakdown: { 'reviewer-timeout': 5 }, lastFailureClass: 'reviewer-timeout', nextRetryAfter: '2026-05-27T03:00:00.000Z' }; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function recordReviewerCredentialFailure() { return { active: false }; } export function recordTokenRefreshHold() { return { tokenRefreshHold: {} }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; } export function releaseReviewerCredentialProbe() { return false; } export function shouldPauseReviewerModel() { return { paused: false }; }",
    'fixture:reviewer-reattach': "export function makeReviewPostedProbe() { return async () => null; } export function reviewerBotLogin(reviewer) { return reviewer ? 'codex-reviewer-lacey' : null; } export function probeReviewerSession() { return { alive: false, matched: false }; } export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; } export function resolveAgyReviewerSubprocessTimeoutMs() { return 300000; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed-title path'); }",
    'fixture:watcher-memory-pressure': "export async function checkReviewerMemoryAdmission() { return { admit: true, reason: null, sample: { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }, projectedHeadroomMb: 999999, availableMb: 999999, swapUsedPct: 0, estimatedReviewerRssMb: 0, reservedMb: 0 }; } export function peakReviewerMemoryMbFor() { return 0; } export async function readMemoryPressureSample() { return { pressureLevel: 'nominal', availableMb: 999999, swapUsedPct: 0 }; }",
    'fixture:github-api': "export * from '${fileUrl('src', 'github-api.mjs')}?actual'; export async function fetchPullRequestRollup() { throw new Error('unexpected github rollup call'); } export async function fetchPullRequestHeadAndState() { return { state: 'open', mergedAt: null, closedAt: null, headRefOid: 'timeout-head-164', labels: [] }; } export async function fetchPullRequestMergeability() { return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }; } export async function fetchReviewBodiesForHead() { return []; } export async function fetchSubmittedReviewsForHead() { return []; } export async function dismissStandingChangesRequestedReviewsForHead() { return { attempted: 0, dismissed: [], standing: [] }; } export async function fetchPullRequestCommitSubjects() { return []; }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
    'fixture:ama-dispatch-closer': "export * from '${fileUrl('src', 'ama', 'dispatch-closer.mjs')}?actual'; import { maybeDispatchAmaCloser as actual } from '${fileUrl('src', 'ama', 'dispatch-closer.mjs')}?actual'; import { primaryChangeFixture } from '${fileUrl('test', 'helpers', 'primary-change.mjs')}'; export const AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = 0; export const AMA_CLOSER_REDISPATCH_BOUND = 2; export function isAmaCloserLaunchInProgress() { return false; } export function isInterruptedInFlightAmaCloserDispatch() { return false; } export function isTransientHqDispatchError() { return false; } export function readAmaCloserDispatchRecord() { return null; } export function updateAmaCloserDispatchRecord() { return null; } export function namedAmaNoDispatchReason(reason, reasons = []) { if (reason === 'not-eligible') { const why = Array.isArray(reasons) && reasons.length ? String(reasons[0] || '').trim() : ''; return 'not-eligible:' + (why || 'unknown'); } return reason; } export async function maybeDispatchAmaCloser(args) { if (args?.reviewState?.remediationPending === true) { const result = await actual({ ...args, fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha), execFileImpl: async () => { throw new Error('remediation owner must prevent external dispatch'); } }); if (result.dispatched) throw new Error('competing hammer launched'); (globalThis.__ciRemediationDeferrals ||= []).push(result.reason); return result; } if (args?.dispatchContext?.ciBlockedHammerOwner === true) (globalThis.__ciBlockedCloserCalls ||= []).push({ reviewCycleExhausted: args?.reviewState?.reviewCycleExhausted === true, failedChecks: (args?.dispatchContext?.ciFailedChecks || []).map((check) => check.name) }); (globalThis.__timeoutHandoffCloserCalls ||= []).push({ reviewCycleCapReached: args?.dispatchContext?.reviewCycleCapReached === true, reviewCycleExhausted: args?.reviewState?.reviewCycleExhausted === true, reviewCycleCap: args?.dispatchContext?.reviewCycleCap ?? null, historyHeads: (args?.dispatchContext?.reviewCycleHistory || []).map((row) => row.head_sha) }); if ((process.env.FIXTURE_CI_MULTI_TICK || process.env.FIXTURE_CI_PRE_PUSH) && args?.dispatchContext?.ciBlockedHammerOwner === true) { const tick = globalThis.__ciBlockedCloserCalls.length; if (tick === 2 && process.env.FIXTURE_CI_PRE_PUSH) return { dispatched: false, skipMergeAgent: true, launchRequestId: 'lrq_first_hammer', reason: 'existing-dispatch-unknown', workerClass: 'hammer' }; if (tick === 3 && process.env.FIXTURE_CI_MULTI_TICK !== 'retry') return { dispatched: false, skipMergeAgent: true, needsOperator: true, reason: process.env.FIXTURE_CI_MULTI_TICK === 'cap' ? 'hammer-retry-cap-exhausted' : 'ci-blocked-hammer-final-no-merge' }; return { dispatched: true, launchRequestId: tick < 3 ? 'lrq_first_hammer' : 'lrq_retry_hammer', reason: tick === 2 ? 'already-dispatched' : 'dispatched', workerClass: 'hammer' }; } const reason = process.env.FIXTURE_AMA_REASON || 'not-eligible'; if (reason === 'dispatched') return { dispatched: true, launchRequestId: 'lrq_fixture_hammer', workerClass: 'hammer' }; return { dispatched: false, reason, ...(reason === 'primary-change-repair-required' ? { skipMergeAgent: true, needsOperator: true } : {}), ...(reason === 'not-eligible' ? { reasons: ['risk-class-blocked'] } : {}) }; }",
    'fixture:config-loader': "export * from '${fileUrl('src', 'config-loader.mjs')}?actual'; export class AgentOSConfigError extends Error {} function buildConfig() { return { get() { return undefined; }, getMergeAuthorityConfig() { return { enabled: process.env.FIXTURE_AMA_ENABLED === '1' }; }, getOrchestrationMode() { return process.env.FIXTURE_ORCHESTRATION_MODE || 'native'; } }; } export function getConfig() { return undefined; } export function loadConfig() { return buildConfig(); } export function loadConfigCached() { return buildConfig(); } export function resetConfigCache() {} export function loadConfigRuntime() { return buildConfig(); }",
    'fixture:gh-cli': "export * from '${fileUrl('src', 'gh-cli.mjs')}?actual'; export const GH_LOOKUP_MAX_BUFFER = 26214400; export const GH_LOOKUP_TIMEOUT_MS = 30000; export function buildAllowlistedGhEnv(env = process.env) { return { ...env }; } export async function execGhWithRetry({ execFileImpl, args } = {}) { return execFileImpl('gh', args); } export function isTransientGhError() { return false; } export function parseDate(value) { return value ? new Date(value) : null; } export function parseJsonLines(stdout) { return String(stdout || '').split('\\\\n').filter(Boolean).map((line) => JSON.parse(line)); }",
    'fixture:ama-ham-provenance': "export * from '${fileUrl('src', 'ama', 'ham-provenance.mjs')}?actual'; export const HAM_AUDIT_COMMENT_AUTHOR_LOGINS = new Set(); export function hamAuditCommentAuthorMatches() { return false; } export function hamCommitIdentityMatches() { return false; } export function parseCommitTrailers() { return {}; } export function parseCommitTrailerValues() { return {}; } export function parseRemediatedFindingsTrailer() { return null; } export function isHamWorkerTicket() { return false; }",
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
const capScenario = process.env.FIXTURE_CAP_SCENARIO || '';
const insertRow = db.prepare(
  \`INSERT INTO reviewed_prs
     (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message, reviewer_head_sha)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`
);
if (capScenario) {
  // CYCLECAPHAM-01: five counted Changes Requested verdicts on five heads.
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const at = new Date(Date.now() - (6 - cycle) * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO review_cycle_verdicts (pr_url, head_sha, verdict_count, verdict_at, verdict_summary) VALUES (?, ?, ?, ?, ?)')
      .run('https://github.com/laceyenterprises/adversarial-review/pull/164', 'cap-head-' + cycle, cycle, at, 'Cycle ' + cycle + ': Changes Requested');
    db.prepare('INSERT INTO review_cycle_counters (pr_url, head_sha, verdict_count, last_verdict_at, escalated_at) VALUES (?, ?, ?, ?, ?)')
      .run('https://github.com/laceyenterprises/adversarial-review/pull/164', 'cap-head-' + cycle, cycle, at,
        capScenario !== 'escalate' && cycle === 5 ? at : null);
  }
  if (capScenario !== 'escalate') {
    insertRow.run('laceyenterprises/adversarial-review', 164, '2026-05-27T04:00:00.000Z', 'claude', 'open', 'failed', 1,
      '2026-05-27T04:00:00.000Z', '[review-cycle-cap] 5 successive review/remediation cycles without converging; routed to the hammer for final adjudication', 'cap-head-5');
  } else {
    // The last remediation pushed a new head and asked for its re-review.
    insertRow.run('laceyenterprises/adversarial-review', 164, '2026-05-27T04:00:00.000Z', 'claude', 'open', 'pending', 0,
      null, null, 'cap-head-5');
  }
} else if (process.env.FIXTURE_CI_BLOCKED === '1') {
  // CIBLOCKHAM-01: the review posted on reviewed-head-164; the remediation
  // head timeout-head-164 failed repo-guards and the re-review is parked.
  db.prepare(\`INSERT INTO reviewer_passes
    (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status,
     head_sha, gh_comment_id, body_md, body_captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`)
    .run('laceyenterprises/adversarial-review', 164, 1, 'claude', 'first-pass', '2026-05-27T03:00:00.000Z',
      '2026-05-27T03:10:00.000Z', 'completed', 'reviewed-head-164', 'IC_164', '## Verdict\\nComment only',
      '2026-05-27T03:10:00.000Z');
  insertRow.run('laceyenterprises/adversarial-review', 164, '2026-05-27T03:10:00.000Z', 'claude', 'open', 'ci-blocked', 1,
    null, '[ci-regression-no-job] Re-review is parked', 'timeout-head-164');
} else {
  insertRow.run(
    'laceyenterprises/adversarial-review',
    164,
    '2026-05-27T04:00:00.000Z',
    'claude',
    'open',
    'pending-upstream',
    0,
    '2026-05-27T04:00:00.000Z',
    '[reviewer-timeout] Reviewer command timed out before posting; watcher backoff engaged.',
    null
  );
}
if (process.env.FIXTURE_CI_RETRIGGER) {
  const { createFollowUpJob, markFollowUpJobStopped } = await import(${JSON.stringify(fileUrl('src', 'follow-up-jobs.mjs') + '?actual')});
  const created = createFollowUpJob({ rootDir: process.env.FIXTURE_JOB_ROOT,
    repo: 'laceyenterprises/adversarial-review', prNumber: 164, reviewerModel: 'claude',
    reviewBody: '## Blocking issues\\n- **Repair CI**\\n## Verdict\\nRequest changes',
    reviewPostedAt: new Date().toISOString(), revisionRef: 'timeout-head-164', maxRemediationRounds: 2 });
  markFollowUpJobStopped({ rootDir: process.env.FIXTURE_JOB_ROOT, jobPath: created.jobPath,
    stopCode: 'max-rounds-reached', stopReason: 'Budget spent' });
}
globalThis.__capComments = [];
globalThis.__capLabels = [];

const octokit = {
  paginate: async () => [{ name: 'adversarial-review', archived: false }],
  rest: {
    issues: {
      listComments: async () => ({ data: [] }),
      createComment: async ({ body }) => { globalThis.__capComments.push(body); return { data: { body } }; },
      addLabels: async ({ labels }) => { globalThis.__capLabels.push(...labels); return { data: [] }; },
      removeLabel: async () => ({ data: [] }),
    },
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

const ciSnapshots = [];
if (process.env.FIXTURE_CI_PRE_PUSH) {
  const snapshot = () => db.prepare('SELECT review_status, reviewer_head_sha FROM reviewed_prs WHERE pr_number = 164').get();
  ciSnapshots.push(snapshot());
  globalThis.__ciGreen = process.env.FIXTURE_CI_PRE_PUSH === 'green';
  globalThis.__ciNonHamPushed = process.env.FIXTURE_CI_PRE_PUSH === 'non-ham';
  await pollOnce(octokit);
  ciSnapshots.push(snapshot());
  // Only after these transitions does the hammer produce its first push.
  globalThis.__ciHammerPushed = true;
  await pollOnce(octokit);
  ciSnapshots.push(snapshot());
}
if (process.env.FIXTURE_CI_RETRIGGER) {
  assert.equal(globalThis.__ciRetriggerOutcome, 'bumped-and-requeued');
  globalThis.__ciNonHamPushed = true;
  await pollOnce(octokit);
}

if (process.env.FIXTURE_CI_MULTI_TICK) {
  const snapshot = () => db.prepare('SELECT review_status, reviewer_head_sha FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 164);
  ciSnapshots.push(snapshot());
  assert.equal(globalThis.__ciBlockedCloserCalls.length, 1, 'initial dispatch');
  globalThis.__ciHammerPushed = true;
  db.prepare('UPDATE reviewed_prs SET last_attempted_at = ? WHERE pr_number = 164').run(new Date().toISOString());
  await pollOnce(octokit);
  ciSnapshots.push(snapshot());
  assert.equal(globalThis.__ciBlockedCloserCalls.length, 2, 'live hammer reconciled despite new HAM head and CI backoff');
  // External dispatch status now reports that the first process exited. The
  // closer returns either a retry launch or its recorded final no-merge/cap.
  await pollOnce(octokit);
  ciSnapshots.push(snapshot());
  assert.equal(globalThis.__ciBlockedCloserCalls.length, 3, 'terminal worker reconciliation remains reachable');
}

const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
  .get('laceyenterprises/adversarial-review', 164);
console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
  reviewStatus: row.review_status,
  failureMessage: row.failure_message,
  closerCalls: globalThis.__timeoutHandoffCloserCalls || [],
  ciBlockedCloserCalls: globalThis.__ciBlockedCloserCalls || [],
  ciInspections: globalThis.__ciInspections || 0,
  ciGateOwnership: globalThis.__ciGateOwnership || [],
  ciRetriggerOutcome: globalThis.__ciRetriggerOutcome,
  ciRemediationDeferrals: globalThis.__ciRemediationDeferrals || [],
  ciSnapshots,
  ciHammerPages: globalThis.__ciHammerPages || [],
  capComments: globalThis.__capComments,
  capLabels: globalThis.__capLabels,
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
          AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
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
          AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
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
          AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
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
          AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
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

for (const { name, liveEnv, expectedDispatches } of [
  { name: 'honors a fresh request', liveEnv: {}, expectedDispatches: 1 },
  { name: 'ignores a removed request', liveEnv: { FIXTURE_LIVE_REQUEST_REMOVED: '1' }, expectedDispatches: 0 },
  { name: 'recovers a settled primary-change refusal', liveEnv: { FIXTURE_AMA_REASON: 'primary-change-repair-required' }, expectedDispatches: 1 },
  ...['no-merge-hold', 'do-not-merge', 'merge-agent-skip', 'adversarial-merge-blocked',
    'merge-agent-stuck', 'duplicate-family-hold'].map((label) => ({
    name: `preserves a newly applied ${label}`,
    liveEnv: { FIXTURE_LIVE_HARD_SKIP: label }, expectedDispatches: 0,
  })),
]) {
  test(`watcher pollOnce ${name} on timeout fallback when the tick labels are stale`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-handoff-ama-stale-label-'));
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
            AGENT_OS_HQ_BIN: '/usr/bin/false',
            ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
            FIXTURE_AMA_ENABLED: '1',
            FIXTURE_AMA_REASON: 'not-eligible',
            FIXTURE_MERGE_AGENT_REQUESTED: '1',
            FIXTURE_MERGE_AGENT_LABEL_PRESENT: liveEnv.FIXTURE_LIVE_REQUEST_REMOVED ? '1' : '0',
            ...liveEnv,
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
      assert.equal(summary.dispatches.length, expectedDispatches, output);
      if (expectedDispatches) {
        assert.equal(summary.dispatches[0].env.AMA_OPERATOR_MERGE_AGENT_OVERRIDE, 'true');
        assert.equal(summary.dispatches[0].triggerOverride, 'merge-agent-requested');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// CYCLECAPHAM-01: a PR at the review cycle cap goes to the hammer through the
// real watcher tick: no reviewer spawn, no operator write, the closer sees the
// cap route with the cycle history.
for (const scenario of ['escalate', 'paused', 'ham']) {
  test(`watcher pollOnce routes a review-cycle-cap PR to the hammer (${scenario} tick)`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), `watcher-cycle-cap-hammer-${scenario}-`));
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
            AGENT_OS_HQ_BIN: '/usr/bin/false',
            ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
            FIXTURE_AMA_ENABLED: '1',
            FIXTURE_AMA_REASON: 'dispatched',
            FIXTURE_CAP_SCENARIO: scenario,
            FIXTURE_CAP_LABEL: scenario !== 'escalate' ? '1' : '0',
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

      assert.equal(summary.reviewerSpawns.length, 0, 'no review-remediate cycle starts after the cap');
      assert.equal(summary.operatorWrites.length, 0);
      assert.equal(summary.dispatches.length, 0, 'the legacy merge-agent lane is not used');
      if (scenario === 'escalate') {
        assert.equal(summary.reviewStatus, 'failed');
        assert.match(summary.failureMessage, /^\[review-cycle-cap\] .*routed to the hammer for final adjudication/);
      } else {
        // The head moved past the last reviewed head, so the existing re-arm
        // made the row `pending`; the cap label still holds the review.
        assert.equal(summary.reviewStatus, 'pending');
      }
      assert.equal(summary.closerCalls.length, 1, output);
      assert.deepEqual(summary.closerCalls[0], {
        reviewCycleCapReached: true,
        reviewCycleExhausted: true,
        reviewCycleCap: 5,
        historyHeads: ['cap-head-1', 'cap-head-2', 'cap-head-3', 'cap-head-4', 'cap-head-5'],
      });
      if (scenario === 'escalate') {
        assert.equal(summary.capComments.length, 1);
        assert.match(summary.capComments[0], /routed to the hammer for final adjudication/);
        assert.doesNotMatch(summary.capComments[0], /operator attention required/i);
        assert.deepEqual(summary.capLabels, ['reviewer-cycle-cap-reached']);
      } else {
        assert.equal(summary.capComments.length, 0, 'the cap comment is posted once per PR');
      }
      assert.match(output, /review-cycle-cap routed laceyenterprises\/adversarial-review#164 to the hammer for final adjudication: ama-dispatched/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// CIBLOCKHAM-01: a parked CI-blocked re-review with no remediation job left is
// handed to the hammer on the real watcher tick: the reviewer stays parked (it
// still requires green CI), no reviewer spawns, no operator write, and the
// closer sees the CI-blocked route with the failing check.
test('watcher pollOnce routes a CI-blocked PR with no remediation job left to the hammer', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-ci-blocked-hammer-'));
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
          AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false',
          FIXTURE_AMA_ENABLED: '1',
          FIXTURE_AMA_REASON: 'dispatched',
          FIXTURE_CI_BLOCKED: '1', FIXTURE_JOB_ROOT: tmp,
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

    assert.equal(summary.ciInspections, 0, output);
    assert.equal(summary.reviewStatus, 'ci-blocked', 'reviewer admission still requires green external CI');
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.operatorWrites.length, 0);
    assert.equal(summary.dispatches.length, 0, 'the legacy merge-agent lane is not used');
    assert.deepEqual(summary.ciBlockedCloserCalls, [{ reviewCycleExhausted: true, failedChecks: [] }], output);
    assert.match(output, /ci-blocked routed laceyenterprises\/adversarial-review#164 to the hammer for final adjudication: ama-dispatched/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const decision of ['retry', 'no-merge', 'cap']) {
  test(`CI-blocked ownership survives HAM push and process exit for ${decision} reconciliation`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-ci-hammer-ticks-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      writeFileSync(loaderPath, buildLoaderSource());
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource());
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, GITHUB_TOKEN: 'fixture-token', AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false', FIXTURE_AMA_ENABLED: '1',
          FIXTURE_CI_BLOCKED: '1', FIXTURE_JOB_ROOT: tmp, FIXTURE_CI_MULTI_TICK: decision },
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, output);
      const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
      assert.ok(line, output);
      const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
      assert.deepEqual(summary.ciSnapshots, Array(3).fill({ review_status: 'ci-blocked', reviewer_head_sha: 'timeout-head-164' }), output);
      assert.equal(summary.ciInspections, 0, 'hammer ownership retains the row without CI probes');
      assert.equal(summary.reviewerSpawns.length, 0);
      assert.equal(summary.dispatches.length, 0, 'legacy merge-agent cannot take over');
      assert.equal(summary.ciHammerPages.length, decision === 'retry' ? 0 : 1, output);
      if (decision !== 'retry') {
        assert.equal(summary.ciHammerPages[0].event, 'ama.ci_blocked.hammer_final');
        assert.equal(summary.ciHammerPages[0].payload.headSha, 'ham-pushed-head-164');
        assert.equal(summary.ciHammerPages[0].payload.outcome, decision === 'cap' ? 'hammer-cap-exhausted' : 'hammer-no-merge');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

for (const transition of ['green', 'non-ham', 'retrigger']) {
  test(`CI-blocked real gate ownership survives pre-push ${transition}`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-ci-pre-push-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      writeFileSync(loaderPath, buildLoaderSource());
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource());
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, GITHUB_TOKEN: 'fixture-token', AGENT_OS_HQ_BIN: '/usr/bin/false',
          ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false', FIXTURE_AMA_ENABLED: '1', FIXTURE_AMA_REASON: 'dispatched',
          FIXTURE_CI_BLOCKED: '1', FIXTURE_JOB_ROOT: tmp,
          ...(transition === 'retrigger' ? { FIXTURE_CI_RETRIGGER: '1' } : { FIXTURE_CI_PRE_PUSH: transition }) },
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, output);
      const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
      assert.ok(line, output);
      const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
      assert.equal(summary.reviewStatus, 'ci-blocked', output);
      assert.equal(summary.reviewerSpawns.length, 0, output);
      assert.equal(summary.dispatches.length, 0, output);
      assert.equal(summary.ciInspections, 0, 'ownership prevents CI rearming');
      if (transition === 'retrigger') {
        assert.equal(summary.ciRetriggerOutcome, 'bumped-and-requeued', output);
        assert.deepEqual(summary.ciGateOwnership, [true, true], output);
        assert.deepEqual(summary.ciRemediationDeferrals, ['not-eligible', 'not-eligible'], output);
        assert.equal(summary.ciBlockedCloserCalls.length, 0, 'no new hammer or retry while remediation owns the PR');
      } else {
        assert.deepEqual(summary.ciSnapshots, Array(3).fill({ review_status: 'ci-blocked', reviewer_head_sha: 'timeout-head-164' }), output);
        assert.equal(summary.ciBlockedCloserCalls.length, 3, 'unresolved hammer remains reachable until its final decision');
        assert.equal(summary.ciHammerPages.length, 1, output);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
