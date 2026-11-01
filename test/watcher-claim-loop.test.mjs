import './helpers/rate-limit-state-isolation.mjs';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { claudeAccountFixture, fleetStatusWithClaudeAccountEvidence } from './helpers/claude-account-fixture.mjs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SUMMARY_MARKER = '@@WATCHER_CLAIM_LOOP_SUMMARY@@';

// Flush completed synchronous fixtures before the validation idle deadline.
test.beforeEach(() => setImmediate());

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
    // Legacy synchronous assertions explicitly exercise the rollback mode.
    ADVERSARIAL_REVIEW_ADMISSION_SETTLEMENT_SPLIT: 'false',
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
  const hqPath = path.join(tmp, 'fixture-quota-hq');
  writeFileSync(hqPath, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'fleet quota status --json') process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify({ ...claudeAccountFixture(),
  providerStatuses: [...claudeAccountFixture().providerStatuses.filter(row => row.provider !== 'openai'), ...codexAccountFixture().providerStatuses],
  reserveFloors: { ...claudeAccountFixture().reserveFloors, ...codexAccountFixture().reserveFloors },
  brokerAuth: { provider_states: { ...claudeAccountFixture().brokerAuth.provider_states, ...codexAccountFixture().brokerAuth.provider_states } },
}))});
`);
  chmodSync(hqPath, 0o755);
  // Raw hq fallbacks must also stay inside this synthetic service boundary.
  const cliBin = path.join(tmp, 'fixture-cli-bin');
  mkdirSync(cliBin, { recursive: true });
  const hqShim = path.join(cliBin, 'hq');
  writeFileSync(hqShim, `#!/bin/sh
if [ "$1" = dag ] && [ "$2" = autowalk-on-merge ]; then echo '{}'; exit 0; fi
exec "$AGENT_OS_HQ_BIN" "$@"
`, { mode: 0o755 });
  return { PATH: `${cliBin}${path.delimiter}${tmp}${path.delimiter}${process.env.PATH || ''}`, AGENT_OS_HQ_BIN: hqPath };
}

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

const DEFAULT_FOLLOW_UP_JOBS_SOURCE = "export const FOLLOW_UP_JOB_DIRS = { pending: 'pending', inProgress: 'in-progress', completed: 'completed', failed: 'failed', stopped: 'stopped', workspaces: 'workspaces', stoppedArchived: 'stopped-archived' }; export function classifyFollowUpCriticality() { return { critical: false, blockingFindingCount: 0, blockingFindingState: 'known', verdict: 'comment-only' }; } export function createFollowUpJob() { return { jobPath: '/tmp/watcher-claim-loop-follow-up.json' }; } export function listFollowUpJobsInDir() { return []; } export function listInProgressFollowUpJobs() { return []; } export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; } export const PUBLIC_REPLY_MAX_CHARS = 1200; export function detectPublicReplyNoiseSignal() { return null; } export function isActiveFollowUpJobStatus(status) { return ['pending','inProgress','in-progress','in_progress'].includes(status); } export function isSettledReviewJob() { return false; } export function markFollowUpJobStopped() { return { status: 'stopped' }; } export function requeueFollowUpJobForNextRound() { return { requeued: false }; } export function markFollowUpJobFailed() { return { status: 'failed' }; } export function requeueInProgressFollowUpJobForRetry() { return { requeued: false }; } export function stopPendingNoRemediationJobs() { return []; } export function writeFollowUpJob() {} export function voidSingleReviewCredit() { return { voided: false }; }"
  // The CI recovery module imports these store methods transitively. Claim-loop
  // fixtures own no persisted job, so an unexpected call must fail visibly.
  + " export function readFollowUpJob() { throw new Error('unexpected fixture job read'); } export function releaseInfrastructureCiStop() { throw new Error('unexpected fixture CI stop release'); }";

function buildLoaderSource({
  deadlineRecoverySource = null,
  capRouteSource = null,
  provenanceReaderSource = null,
  discoveryHookSource = '',
  cascadeRootDir = null,
  subjectHeads = {},
  subject101Overrides = {},
  subjectRevisionRefs = {},
  followUpJobsSource = DEFAULT_FOLLOW_UP_JOBS_SOURCE,
  reviewerRuntimeSource = "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {}, reattach: async () => ({}) }; } export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); } export function loadDomainConfig() { return {}; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }",
  followUpMergeAgentSource = "export const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add'; export function classifyBlockingFindings() { return { count: 0, state: 'known' }; } export async function applyMergeAgentStuckLabel() { return false; } export async function addMergeAgentDispatchedLabel() { return { added: true }; } export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; } export async function cancelMergeAgentDispatchOnMerge() { return { attempted: false, cancelled: false, labelRemoved: false }; } export function clearMergeAgentLifecycleCleanup() { return true; } export function listMergeAgentDispatches() { return []; } export function listMergeAgentLifecycleCleanups() { return []; } export async function isMergeAgentDispatchActiveForHead() { return { active: false, reason: 'fixture' }; } export async function pollFastMergeQueue() { return { processed: 0, merged: 0, blocked: 0, requeued_head_change: 0, requeued_veto: 0, skipped_still_pending: 0 }; } export function resolveFastMergePerPollCap() { return 5; } export function shouldUseReviewerTimeoutExhaustedMergeGate() { return false; } export function summarizeChecksConclusion() { return 'SUCCESS'; } export function updateMergeAgentLifecycleCleanup() { return {}; } export function upsertMergeAgentLifecycleCleanup() { return {}; } export function scanStuckMergeAgentDispatches() { return []; } export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; } export function validateStartupMergeAgentConfig() {} export function isScopedMergeAgentRequest() { return false; }",
} = {}) {
  const cascadeUrl = fileUrl('src', 'reviewer-cascade.mjs');
  const cascadeSource = cascadeRootDir ? `
    import * as actual from ${JSON.stringify(`${cascadeUrl}?actual`)};
    export * from ${JSON.stringify(`${cascadeUrl}?actual`)};
    ${['readCascadeState', 'recordCascadeFailure', 'clearCascadeState', 'shouldBackoffReviewerSpawn',
      'markCascadeCapExhaustedAlerted', 'markOperatorDecisionRequiredAlerted'].map(name =>
      `export function ${name}(_root, args) { return actual.${name}(${JSON.stringify(cascadeRootDir)}, args); }`).join('\n')}
  ` : null;
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const reviewStateActualUrl = `${reviewStateUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');

  const stubs = {
    [fileUrl('src', 'adapters', 'agent-runtime', 'local', 'remediation.mjs')]: 'fixture:worker-registry',
    ...(deadlineRecoverySource ? { [fileUrl('src', 'ownerproof-review-recovery.mjs')]: 'fixture:deadline-recovery' } : {}),
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
    [fileUrl('src', 'remediation-ci-infrastructure.mjs')]: 'fixture:remediation-ci-infrastructure',
    [fileUrl('src', 'remediation-prompt.mjs')]: 'fixture:remediation-prompt',
    [fileUrl('src', 'follow-up-merge-agent.mjs')]: 'fixture:follow-up-merge-agent',
    [fileUrl('src', 'follow-up-retrigger-label.mjs')]: 'fixture:follow-up-retrigger-label',
    [fileUrl('src', 'operator-retrigger-helpers.mjs')]: 'fixture:operator-retrigger-helpers',
    [fileUrl('src', 'reviewer-cascade.mjs')]: 'fixture:reviewer-cascade',
    [fileUrl('src', 'reviewer-reattach.mjs')]: 'fixture:reviewer-reattach',
    [fileUrl('src', 'reviewer-timeout.mjs')]: 'fixture:reviewer-timeout',
    [fileUrl('src', 'reviewer-broker-refresh.mjs')]: 'fixture:reviewer-broker-refresh',
    [fileUrl('src', 'reviewer-token-ledger-lookup.mjs')]: 'fixture:reviewer-token-ledger-lookup',
    [fileUrl('src', 'stale-drift.mjs')]: 'fixture:stale-drift',
    [fileUrl('src', 'watcher-fail-loud.mjs')]: 'fixture:watcher-fail-loud',
    [fileUrl('src', 'watcher-memory-pressure.mjs')]: 'fixture:watcher-memory-pressure',
    [fileUrl('src', 'github-api.mjs')]: 'fixture:github-api',
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
    [fileUrl('src', 'hcp-health.mjs')]: 'fixture:hcp-health',
    [fileUrl('src', 'gh-cli.mjs')]: 'fixture:gh-cli',
    [fileUrl('src', 'ama', 'closer-hold-records.mjs')]: 'fixture:closer-hold-records',
    [fileUrl('src', 'head-closer-commit-suppression.mjs')]: 'fixture:head-closer-commit-suppression',
    [fileUrl('src', 'ama', 'ham-provenance.mjs')]: 'fixture:ama-ham-provenance',
    [fileUrl('src', 'session-ledger-read-adapter.mjs')]: 'fixture:session-ledger-read-adapter',
  };

  return `
const deadlineRecoverySource = ${JSON.stringify(deadlineRecoverySource)};
const capRouteSource = ${JSON.stringify(capRouteSource)};
const cascadeSource = ${JSON.stringify(cascadeSource)};
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
  if (url === 'fixture:reviewer-cascade' && cascadeSource) return { format: 'module', shortCircuit: true, source: cascadeSource };
  if (url === 'fixture:deadline-recovery') return { format: 'module', shortCircuit: true, source: deadlineRecoverySource };
  if (url === 'fixture:cap-route') return { format: 'module', shortCircuit: true, source: capRouteSource };
  if (url === 'fixture:heldhead') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
      export function isCompletedCommentOnlyFinalRoundJob(job) {
        return job?.status === 'completed' && job.finalRound === 'comment-only' &&
          job.reReview?.suppressed === 'comment-only-final-round';
      }
      export function isCompletedFinalRemediationJob(job) { return isCompletedCommentOnlyFinalRoundJob(job); }
      export function hasInProgressCommentOnlyFinalRound() { return false; }
      export function hasCommentOnlyFinalRoundPush() { return false; }
      export function hasUnprovenCommentOnlyFinalRoundHead() { return false; }
      export function hasSettledCommentOnlyReviewHead() { return false; }
      export function scanArchivedStoppedFollowUpJobs() { return []; }
      export function findFinalRoundJobForProvenPush() { return null; }
      export function findCommentOnlyFinalRoundPushJob() { return null; }
      export function findFinalRemediationPushJob() { return null; }
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
            headSha: Object.hasOwn(subjectHeadOverrides, '102') ? subjectHeadOverrides['102'] : 'sha-happy-102',
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
    'fixture:worker-registry': ${JSON.stringify(`export * from '${fileUrl('src', 'adapters', 'agent-runtime', 'local', 'remediation.mjs')}?actual'; export async function ensureWorkerRegistryReady() { globalThis.__registryPrefetches = (globalThis.__registryPrefetches || 0) + 1; } export const prefetchWorkerRegistry = ensureWorkerRegistryReady; export function resolveRemediationModel(_className, {pin, fallbackModel} = {}) { return {resolvedModel: pin || fallbackModel || null, modelSource: 'producer', resolvedReasoningLevel: null}; }`)},
    // Claim-loop cases own adapter usage fixtures, not ledger subprocesses.
    // Keep the newer worker transport inside the same offline accounting seam.
    'fixture:closer-hold-records': 'export async function evaluateCloserHoldsForPoll(args) { globalThis.__closerHoldPolls = (globalThis.__closerHoldPolls || 0) + 1; globalThis.__closerHoldSubjects = args.subjects; }',
    'fixture:reviewer-token-ledger-lookup': 'export async function readReviewerEvidenceInWorker() { return null; }',
    'fixture:remediation-ci-infrastructure': "export async function recoverInfrastructureCiStops() { return []; } export function holdRemediationForCiInfrastructure() { return null; } export async function resumeCiInfrastructureRound() { return null; } export function deferCiInfrastructureProbe() {} export function clearCiInfrastructureWait() { return null; }",
    'fixture:remediation-published-head': "export function completeWorkerPublishedHead() { return null; } export function completeLiveWorkerPublishedHead() { return null; } export function completeKnownWorkerPublish() { return null; } export function findWorkerPublishedHead() { return null; } export function hasWorkerPublishArtifacts() { return false; } export function buildRereviewResult() { return {}; }",
    'fixture:session-ledger-read-adapter': ${JSON.stringify(provenanceReaderSource ?? `export * from '${fileUrl('src', 'session-ledger-read-adapter.mjs')}?actual'; export function readPrBuilderProvenanceAsync({ prNumber }) { return globalThis.__watcherClaimLoopProvenance?.(prNumber) || { ok: false, reason: 'missing-builder-provenance' }; }`)},
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
    'fixture:reviewer-timeout': "export const REVIEWER_PROCESS_SLACK_MS = 300000; export function resolveNominalReviewerTimeoutMs() { return 300000; } export function resolveReviewerTimeoutMs() { return 300000; } export function resolveProgressTimeoutMs() { return 300000; } export function resolveAgyReviewerSubprocessTimeoutMs() { return 300000; } export function resolveGeminiReviewerProcessTimeoutMs() { return 300000; }",
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
      return [{ id: 123, node_id: 'R_fixture123', name: 'adversarial-review', archived: false }];
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
      ensureWorkerRegistryReadyImpl: async () => { globalThis.__registryPrefetches = (globalThis.__registryPrefetches || 0) + 1; },
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
    deadlineRecoveries: globalThis.__deadlineRecoveries || [],
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
      return [{ id: 123, node_id: 'R_fixture123', name: 'adversarial-review', archived: false }];
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
    ensureWorkerRegistryReadyImpl: async () => { globalThis.__registryPrefetches = (globalThis.__registryPrefetches || 0) + 1; },
    healthProbe: {
      beginTick() { return {}; },
      recordOpenPending() {},
      recordSpawn() {},
      async finishTick() {},
    },
  };

  await pollOnce(octokit, pollOptions);
  assert.ok(globalThis.__registryPrefetches > 0, 'registry session warms before claim-loop work');
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
    writeFileSync(loaderPath, buildLoaderSource({ subjectHeads: { '102': null } }));
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
    assert.equal(summary.rows['102'].review_status, 'pending');
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
    assert.equal(summary.rows['101'].codex_broker_provider, 'codex-corp');
    assert.match(output, /codex_account=corporate/);
    assert.equal(summary.rows['102'].codex_broker_provider, 'codex-corp');
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
          const ownerObservation = db.prepare('SELECT * FROM ttm_owner_state WHERE pr_number = 101').get();
          assert.equal(ownerObservation.review_suppressed, 1);
          assert.equal(ownerObservation.review_reason, '${suppressionReason}');
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
    assert.match(output, /auto-refresh SUPPRESSED.*#101:.*closer-commit-trailer/);
    assert.equal(summary.reviewerSpawns.some((spawn) => spawn.subjectContext?.reviewerHeadSha === 'sha-happy-101'), false, output);
    assert.equal(summary.rows['101'].review_status, 'posted', output);
    assert.equal(summary.rows['101'].reviewer_head_sha, 'sha-reviewed-101', output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

function runDepthDiscoveryScenario({ burst = false, depthEngaged = true, drainOutcome = null, stalePriority = false, ageSpill = false, lateAccountHold = false, rereviewAge = null, primaryClaude = false, accountEvidence = 'ready', pooledAccountStale = null } = {}) {
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
          return { ...actual.selectReviewerRouteForAttempt(args), ...REVIEWER_ROUTE_BY_MODEL.${primaryClaude ? 'claude' : 'gemini'},
            timeoutFallback: { fromReviewerModel: 'codex', toReviewerModel: '${primaryClaude ? 'claude' : 'gemini'}',
              timeoutFailures: 2, sameModelAsBuilder: false, builderClass: 'codex' } };
        }
      `,
      // Keep the production resolver and precedence rules; stub only live quota I/O.
      [fallbackUrl]: `
        import * as actual from '${fallbackUrl}?actual';
        export * from '${fallbackUrl}?actual';
        export async function resolveReviewerWorkerClassWithFallback(args) {
          return actual.resolveReviewerWorkerClassWithFallback({ ...args,
            execFileImpl: async () => ({ stdout: ${JSON.stringify(JSON.stringify(primaryClaude
              ? accountEvidence === 'missing' ? {} : claudeAccountFixture({ corpReady: accountEvidence !== 'held', primaryReady: accountEvidence !== 'held' })
              : lateAccountHold ? claudeAccountFixture() : fleetStatusWithClaudeAccountEvidence([
              { provider: 'google', authPath: 'oauth', state: 'ok' },
              { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
            ])))} }) });
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
    if (pooledAccountStale !== null) {
      const quotaUrl = fileUrl('src', 'watcher-reviewer-quota.mjs');
      sources[quotaUrl] = `
        import * as actual from '${quotaUrl}?actual';
        export * from '${quotaUrl}?actual';
        export function createWatcherReviewerQuotaPollFactory(options) {
          const beginPoll = actual.createWatcherReviewerQuotaPollFactory(options);
          return (...args) => {
            const poll = beginPoll(...args);
            return { ...poll, async getGrounding(options) {
              return { ...await poll.getGrounding(options), staleIfError: ${pooledAccountStale},
                claudeAccountSelection: { pooled: true, hold: false, provider: 'claude-code-corp',
                  identity: 'claude-reviewer', reason: 'declared-preference' } };
            } };
          };
        }
      `;
    }
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
    if (lateAccountHold) {
      const accountUrl = fileUrl('src', 'claude-account-routing.mjs');
      const gateUrl = fileUrl('src', 'reviewed-head-dispatch-gate.mjs');
      sources[accountUrl] = `
        export * from '${accountUrl}?actual';
        export function readCorporateClaudeQuotaCooldown() {
          return globalThis.__lateClaudeHold ? { resetAt: '2099-01-01T00:00:00Z' } : null;
        }
      `;
      sources[gateUrl] = `
        import * as actual from '${gateUrl}?actual';
        export * from '${gateUrl}?actual';
        export function createHeadDispatchLease() {
          const lease = actual.createHeadDispatchLease();
          return { ...lease, tryAcquire(key) {
            if (key.includes('#101@')) globalThis.__lateClaudeHold = true;
            return lease.tryAcquire(key);
          } };
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
        if (${rereviewAge !== null}) {
          db.prepare("INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status, head_sha, gh_comment_id) VALUES (?, 101, 1, 'gemini', 'first-pass', ?, ?, 'completed', 'prior-reviewed-head', 'prior-review')")
            .run('laceyenterprises/adversarial-review', '2026-05-15T12:00:00Z', '2026-05-15T12:01:00Z');
          db.prepare("UPDATE reviewed_prs SET rereview_requested_at = ?, head_wait_started_at = ?, revision_ref = 'sha-happy-101' WHERE pr_number = 101")
            .run(new Date(Date.now() - ${rereviewAge} * 1000).toISOString(), new Date(Date.now() - ${rereviewAge} * 1000).toISOString());
        }
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
    const quotaFixtureEnv = installGhFixture(tmp);
    if (primaryClaude && accountEvidence !== 'ready') {
      const payload = accountEvidence === 'missing' ? {} : claudeAccountFixture({ corpReady: false, primaryReady: false });
      writeFileSync(quotaFixtureEnv.AGENT_OS_HQ_BIN, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload))});
`);
    }
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: fixtureEnv({ ...quotaFixtureEnv, GH_GEMINI_REVIEWER_TOKEN: 'fixture-gemini',
          GH_CLAUDE_REVIEWER_TOKEN: 'fixture-claude',
          ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: 'claude-code',
          // These scenarios pin depth/burst behavior independently of age.
          ADVERSARIAL_REVIEW_FIRST_PASS_REVIEW_MAX_WAIT_SECONDS: ageSpill ? '480' : '0',
          ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS: ageSpill ? '900' : '0',
          AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: depthEngaged ? '1' : '100',
          AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: burst || lateAccountHold ? '1' : '2' }),
      });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(SUMMARY_MARKER));
    assert.ok(line, output);
    return { summary: JSON.parse(line.slice(SUMMARY_MARKER.length)), output };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

for (const accountEvidence of ['ready', 'missing', 'held']) test(`primary Claude account admission in pollOnce: ${accountEvidence}`, () => {
  const { summary, output } = runDepthDiscoveryScenario({ primaryClaude: true, depthEngaged: false, accountEvidence });
  if (accountEvidence === 'ready') {
    assert.equal(summary.reviewerSpawns.length, 2, output);
    assert.ok(summary.reviewerSpawns.every(spawn => spawn.subjectContext.claudeBrokerProvider === 'claude-code-corp'), output);
  } else {
    assert.equal(summary.reviewerSpawns.length, 0, output);
    assert.equal(summary.claims.length, 2, output);
    assert.ok(Object.values(summary.rows).every(row => row.review_status === 'pending'), output);
    assert.equal(summary.reviewerPassRows.length, 0, output);
  }
});

for (const pooledAccountStale of [false, true]) test(`Claude pooled account admission rejects stale grounding without a cooldown: stale=${pooledAccountStale}`, () => {
  const { summary, output } = runDepthDiscoveryScenario({ primaryClaude: true, depthEngaged: false, pooledAccountStale });
  assert.equal(summary.reviewerSpawns.length, pooledAccountStale ? 0 : 2, output);
  if (pooledAccountStale) {
    assert.ok(Object.values(summary.rows).every(row => row.review_status === 'pending'), output);
    assert.equal(summary.reviewerPassRows.length, 0, output);
  }
});

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


test('REVIEWSPILL-01 production admission spills overdue requests before Gemini saturation', () => {
  const { summary, output } = runDepthDiscoveryScenario({ depthEngaged: false, ageSpill: true });
  assert.match(output, /review-wait-spill repo=.* pr=101 pass_kind=first-pass wait_seconds=[\d.]+ to=claude-code/);
  assert.equal((output.match(/review-wait-spill /g) || []).length, 2);
  assert.match(output, /review-queue-depth-route repo=.* pr=101 from=gemini to=claude reason=review-max-wait/);
  const spill = summary.reviewerSpawns.find(spawn => spawn.subjectContext.reviewerModel === 'claude');
  assert.ok(spill, output);
  assert.equal(spill.subjectContext.crossModelReviewWaived, false);
  assert.equal(summary.depthDiagnostics.report?.engagementSpilloverReviews, 2);
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
    const phaseSource = readFileSync(path.join(REPO_ROOT, 'src/pollonce-phases.mjs'), 'utf8').replace(
      'export async function processReviewSubject(entry, ctx) {',
      'export async function processReviewSubject(entry, ctx) { ctx = { ...ctx, ...globalThis.__ceilingLoggingContext };',
    );
    writeFileSync(loaderPath, buildLoaderSource({ subjectHeads: { 101: head }, followUpJobsSource }).replace(
      'return actual.requestReviewRereview(options);',
      'return actual.requestReviewRereview({ ...options, db: options.db || db });',
    ).replace('  return nextLoad(url, context);', `
      if (url === ${JSON.stringify(fileUrl('src', 'pollonce-phases.mjs'))}) {
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(phaseSource)} };
      }
      return nextLoad(url, context);
    `));
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
      const wakeModule = await import(${JSON.stringify(fileUrl('src', 'rereview-wake.mjs'))});
      const ceilingLog = { warn() {} }, ceilingWarnings = [];
      let ceilingDrainCount = 0;
      if (${postedCount} === 5) globalThis.__ceilingLoggingContext = {
        log: ceilingLog, warn: message => ceilingWarnings.push(message),
        consumeRereviewWakesImpl(payload) {
          assert.equal(payload.log, ceilingLog, 'closeout drain receives the configured sink');
          if (++ceilingDrainCount === 2) throw new Error('synthetic closeout drain failure');
          return wakeModule.consumeRereviewWakes({ ...payload, rootDir: ${JSON.stringify(tmp)} });
        },
      };
      const wakeRepo = db.prepare('SELECT repo FROM reviewed_prs WHERE pr_number=101').get().repo;
      if (${postedCount} === 5) {
        // Settled wakes suppress duplicate requests; keep this replay's queue
        // separate from prior runs as well as from the watcher's real queue.
        const wakeRequest = wakeModule.requestRereviewWake({
          rootDir: ${JSON.stringify(tmp)}, db, repo: wakeRepo, prNumber: 101,
          headSha: ${JSON.stringify(head)}, reason: 'remediation-closeout',
          requestWatcherWakeImpl: () => ({ requested: true }) });
        assert.equal(wakeRequest.requested, true, 'fixture enqueues a fresh closeout wake');
      }
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
      const pending = wakeModule.rereviewWakeBacklog({ rootDir: ${JSON.stringify(tmp)} });
      assert.equal(pending.pending, 0, 'CEILINGPUSH-01 posted lane drains the closeout wake');
      const events = db.prepare("SELECT reason FROM review_latency_events WHERE event_type='rereview_wake'").all();
      assert.ok(events.some(event => event.reason === 'review-ceiling-hammer-owned'));
      await pollOnce(octokit, pollOptions);
      assert.equal(ceilingDrainCount, 2);
      assert.equal(ceilingWarnings.length, 1);
      assert.match(ceilingWarnings[0], /ceiling closeout wake drain failed.*synthetic closeout drain failure/);
      assert.equal(db.prepare('SELECT rereview_reason FROM reviewed_prs WHERE pr_number=101').get().rereview_reason,
        'system-review-ceiling-closure');
      assert.ok(!claims.some(claim => claim.prNumber === 101));
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

for (const stranded of [false, true, 'shared-rule']) test(`HAMCLOSE-04/HAMATTEST-02 real pollOnce admits a bounded exact-head request once, stranded=${stranded}`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hamclose-review-'));
  try {
    const head = 'b'.repeat(40);
    const probePath = path.join(tmp, 'nonempty-probes');
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    let loader = buildLoaderSource({ subjectHeads: { 101: head } });
    if (stranded) loader = loader
      .replace("return async () => ({ suppressed: false, reason: 'fixture' });", "return async () => ({ suppressed: true, reason: 'closer-commit-trailer' });")
      .replace("export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: false, reason: 'fixture' }; }", "export async function getHeadCloserCommitSuppressionWithBoundedRetry() { return { suppressed: true, reason: 'closer-commit-trailer' }; }");
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
      const { acquireAmaCloserLease, updateAmaCloserLease } = await import(${JSON.stringify(fileUrl('src', 'ama', 'closer-lease.mjs'))});
      const { requestReviewRereview } = await import(${JSON.stringify(fileUrl('src', 'review-state.mjs') + '?actual')});
      assert.equal(requestReviewRereview({ ...identity, db, targetRevisionRef: identity.headSha }).reason, 'comment-only-final-round-completed');
      const { requestBoundedOrphanReview } = await import(${JSON.stringify(fileUrl('src', 'ama', 'orphan-review-request.mjs'))});
      const boundedRequest = args => requestBoundedOrphanReview({ ...args,
        requestRereviewImpl: options => requestReviewRereview({ ...options, db }),
      });
      if (${stranded === true}) await boundedRequest(identity);
      if (${stranded === 'shared-rule'}) {
        const { recoverOrphan } = await import(${JSON.stringify(fileUrl('src', 'ama', 'orphan-watchdog.mjs'))});
        const { proveCloserAuthoredStaleHead, closerAuthoredStaleEligible } = await import(${JSON.stringify(fileUrl('src', 'closer-authored-stale.mjs'))});
        const headProof = await proveCloserAuthoredStaleHead({ reviewedHead: 'a'.repeat(40),
          currentHead: identity.headSha, comments: [] });
        const decision = closerAuthoredStaleEligible({ headProof });
        assert.equal(decision.decision, 'rereview-exact-head');
        let requests = 0;
        const recover = () => recoverOrphan({ ...identity, candidate: { prState: 'open' },
          reviewStateRow: db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get(),
          result: { amaEnabled: true, closerAuthoredStale: decision, nextAction: {
            action: 'review', actor: 'reviewer', reason: 'exact-head-review', head: identity.headSha,
            queue: { intent: 'dispatch', deferredBy: null } } },
          hasOwnerImpl: async () => ({ owned: false }),
          requestRereviewImpl: options => { requests++; return requestReviewRereview({ ...options, db }); },
          pageImpl: () => assert.fail('synthetic review request must succeed') });
        await recover();
        await recover();
        assert.equal(requests, 1);
      } else {
        acquireAmaCloserLease(identity);
        updateAmaCloserLease({ ...identity, status: 'handed-to-review' }); // Legacy receipt fixture.
        await boundedRequest(identity);
      }
      if (${stranded === true}) db.prepare("UPDATE reviewed_prs SET review_status='pending', revision_ref=?, rereview_reason='auto-refresh: PR head moved', rereview_requested_at=? WHERE pr_number=101").run(identity.headSha, new Date().toISOString());
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
    runner = runner.replace("return [{ id: 123, node_id: 'R_fixture123', name: 'adversarial-review', archived: false }];",
      "return ['alpha', 'beta', 'gamma'].map((name, index) => ({ id: 123 + index, node_id: 'R_fixture' + index, name, archived: false }));");
    // Only rewrite fixture identities: the checkout path in import URLs may
    // itself contain the owner name (for example a remediation workspace).
    writeFileSync(runnerPath, runner.replaceAll("'laceyenterprises/adversarial-review'", "'example/adversarial-review'"));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv({ AGENT_OS_CONFIG_PATH: path.join(tmp, 'config.yaml') }), timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
for (const scenario of ['unchanged', 'pending-missing-failed-at', 'pending-upstream-missing-failed-at', 'new-head', 'new-build', 'operator-rearm', 'upstream-503']) {
  test(`CASCADECAP-01 pollOnce: ${scenario}`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-timeout-bound-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      const fixtureRepo = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8')).org + '/adversarial-review';
      const synthetic = source => source.replaceAll(fixtureRepo, 'example/adversarial-review');
      let loader = buildLoaderSource({ cascadeRootDir: tmp,
        ...(['new-build', 'operator-rearm'].includes(scenario) ? { reviewerRuntimeSource: `
          globalThis.__watcherClaimLoopReviewerSpawns = [];
          export function createReviewerRuntimeAdapterForDomain() { return {
            spawnReviewer: async payload => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              return payload.subjectContext?.prNumber === 101
                ? { ok: false, failureClass: 'reviewer-timeout', error: 'synthetic reviewer timeout' }
                : { ok: true, stdout: '', stderr: '' };
            }, cancel: async () => {}, reattach: async () => ({}) };
          }
          export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
          export function loadDomainConfig() { return {}; }
          export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
        ` } : {}),
      });
      // Run the real durable park/alert path against fixture storage and transport.
      const parkUrl = fileUrl('src', 'review-retry-exhaustion.mjs');
      loader = loader.replace('  return nextLoad(url, context);', `
        if (url === ${JSON.stringify(parkUrl)}) return { format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`
            import { parkExhaustedReview as actual } from ${JSON.stringify(`${parkUrl}?actual`)};
            export * from ${JSON.stringify(`${parkUrl}?actual`)};
            export function parkExhaustedReview(args) {
              globalThis.__timeoutParkCalls = (globalThis.__timeoutParkCalls || 0) + 1;
              return actual({ ...args, rootDir: ${JSON.stringify(tmp)}, deliverAlertFn: async () => {
                globalThis.__timeoutAlerts = (globalThis.__timeoutAlerts || 0) + 1;
                return { delivered: true };
              } });
            }
          `)} };
        if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
          const loaded = await nextLoad(url, context);
          return { ...loaded, source: loaded.source.toString().replace(
            "const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));",
            "const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')); config.org = 'example';"
          ) };
        }
        return nextLoad(url, context);
      `);
      writeFileSync(loaderPath, synthetic(loader));
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      const failureClass = scenario === 'upstream-503' ? 'cascade' : 'reviewer-timeout';
      const missingFailedAt = scenario.endsWith('-missing-failed-at');
      const parksWithoutRetry = scenario === 'unchanged' || missingFailedAt;
      writeFileSync(runnerPath, synthetic(buildRunnerSource({
        prePollSetup: `
          db.exec(\`
            CREATE TABLE timeout_park_writes (pr_number INTEGER);
            CREATE TRIGGER track_timeout_park AFTER UPDATE OF failure_message ON reviewed_prs
            WHEN NEW.pr_number = 101 AND NEW.failure_message LIKE '%[reviewer-timeout-repeated-same-head]%'
            BEGIN INSERT INTO timeout_park_writes VALUES (NEW.pr_number); END;
          \`);
          const { recordCascadeFailure } = await import(${JSON.stringify(fileUrl('src', 'reviewer-cascade.mjs'))});
          for (let index = 0; index < 2; index++) recordCascadeFailure('unused', {
            repo: 'example/adversarial-review', prNumber: 101,
            headSha: ${JSON.stringify(scenario === 'new-head' ? 'old-head' : 'sha-happy-101')},
            reviewerBuildId: ${JSON.stringify(scenario === 'new-build' ? 'build-old' : 'build-current')},
            failureClass: ${JSON.stringify(failureClass)}, failureReason: 'synthetic failure',
            failedAt: '2026-01-01T00:00:00Z', reviewerModel: 'claude',
          });
          db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
            review_status, review_attempts, infra_auto_recover_attempts, reviewer_head_sha,
            revision_ref, failed_at, failure_message, rereview_requested_at, rereview_reason)
            VALUES ('example/adversarial-review',101,'2026-01-01','claude','open',?,0,3,?,?,
              ?,?,?,?)\`).run(
              ${JSON.stringify(scenario === 'pending-upstream-missing-failed-at' ? 'pending-upstream'
                : missingFailedAt || scenario === 'operator-rearm' ? 'pending' : 'failed')},
              ${JSON.stringify(scenario === 'new-head' ? 'old-head' : 'sha-happy-101')},
              ${JSON.stringify(scenario === 'new-head' ? 'old-head' : 'sha-happy-101')},
              ${JSON.stringify(missingFailedAt ? null : '2026-01-01T00:00:00Z')},
              ${JSON.stringify(`[${failureClass}] synthetic failure`)},
              ${JSON.stringify(scenario === 'operator-rearm' ? '2026-01-02T00:00:00Z' : null)},
              ${JSON.stringify(scenario === 'operator-rearm' ? 'retrigger-review: synthetic re-arm' : null)});
        `,
        afterFirstPoll: parksWithoutRetry ? `
          await pollOnce(octokit, pollOptions);
          assert.equal(claims.filter(claim => claim.prNumber === 101).length, 0, 'no third claim');
          const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
          assert.equal(row.review_status, 'failed');
          ${missingFailedAt ? `assert.ok(Date.parse(row.failed_at) >= Date.now() - 60000,
            'newly parked row receives the current failure timestamp');` : `assert.equal(row.failed_at, '2026-01-01T00:00:00Z',
            'existing failure timestamp is preserved');`}
          assert.match(row.failure_message, /^\\[reviewer-timeout\\] \\[reviewer-timeout-repeated-same-head\\]/);
          assert.equal(globalThis.__timeoutAlerts, 1, 'operator alert fires once');
          assert.equal(globalThis.__timeoutParkCalls, 1, 'later polls do not rewrite the failure decision');
          assert.equal(db.prepare('SELECT COUNT(*) AS count FROM timeout_park_writes').get().count, 1,
            'later polls do not rewrite the parked row');
          assert.equal(claims[0].prNumber, 102, 'waiting first pass proceeds while timeout row is parked');
        ` : `
          assert.equal(claims.filter(claim => claim.prNumber === 101).length, 1, 'changed input or upstream outage allows retry');
          ${['new-build', 'operator-rearm'].includes(scenario) ? `
            await pollOnce(octokit, pollOptions);
            assert.equal(claims.filter(claim => claim.prNumber === 101).length, 1, 'failed probe parks again');
            const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
            assert.equal(row.review_status, 'failed');
            assert.match(row.failure_message, /^\\[reviewer-timeout\\] \\[reviewer-timeout-repeated-same-head\\]/);
            assert.ok(row.infra_auto_recover_attempts <= 3);
          ` : ''}

        `,
      })));
      const fixture = installGhFixture(tmp);
      const ghPath = path.join(tmp, 'gh');
      writeFileSync(ghPath, synthetic(readFileSync(ghPath, 'utf8')));
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv({ ...fixture,
          ADVERSARIAL_REVIEWER_BUILD_ID: 'build-current',
          AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: parksWithoutRetry ? '1' : '6' }), timeout: 60000 });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, output);
      if (scenario !== 'upstream-503') assert.doesNotMatch(output,
        /class=reviewer-timeout, infra attempt (?:[4-9]|\d{2,})\/3/,
        'same-head timeout recovery never logs an infra attempt beyond the cap');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

// Keep these fixtures synthetic even though the older shared harness uses
// the production repository as its default subject identity.
function seatIdleSynthetic(source) {
  const defaultOrg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8')).org;
  return source.replaceAll(`${defaultOrg}/adversarial-review`, 'example/review-fixture')
    .replaceAll("name: 'adversarial-review'", "name: 'review-fixture'");
}

for (const mode of ['dispatch', 'credential-hold', 'ceiling', 'expired', 'no-intent', 'spawn-throw', 'spawn-refused']) {
  test(`RETRIGGERDEDUP-01: real poll preserves same-head dedup and explicit intent (${mode})`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-explicit-intent-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      let loader = buildLoaderSource(mode.startsWith('spawn-') ? {
        reviewerRuntimeSource: `globalThis.__watcherClaimLoopReviewerSpawns = [];
          export function createReviewerRuntimeAdapterForDomain() { return {
            spawnReviewer: async payload => {
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              ${mode === 'spawn-throw' ? "throw new Error('synthetic spawn failure');" : "return { ok: false, stdout: '', stderr: 'synthetic spawn refusal' };"}
            }, cancel: async () => {}, reattach: async () => ({})
          }; }
          export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
          export function loadDomainConfig() { return {}; }
          export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }`,
      } : {})
        .replace('export async function fetchSubmittedReviewsForHead() { return []; }',
          "export async function fetchSubmittedReviewsForHead(_exec, _repo, prNumber, head) { return prNumber === 101 ? [{ id: 'synthetic-review', commitId: head, submittedAt: '2026-01-01T00:00:00Z' }] : []; }")
        .replace('export function shouldPauseReviewerModel() { return { paused: false }; }',
          "export function shouldPauseReviewerModel() { return { paused: Boolean(globalThis.explicitCredentialHold), reason: 'synthetic-credential-hold' }; }");
      loader = loader.replace('export async function load(url, context, nextLoad) {', `
        export async function load(url, context, nextLoad) {
          if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
            const result = await nextLoad(url, context);
            result.source = String(result.source).replace(
              "JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
              '({ org: "example", repos: ["example/review-fixture"] })');
            return result;
          }
      `);
      writeFileSync(loaderPath, seatIdleSynthetic(loader));
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      let runner = buildRunnerSource({
        prePollSetup: `
          const { requestReviewRereview } = await import(${JSON.stringify(fileUrl('src', 'review-state.mjs'))});
          const fixtureRepo = 'example/review-fixture', fixtureHead = 'sha-happy-101';
          db.prepare(\`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
            review_status,review_attempts,revision_ref,reviewer_head_sha,posted_at)
            VALUES (?,101,?,'claude','open','posted',1,?,?,?)\`)
            .run(fixtureRepo, new Date().toISOString(), fixtureHead, fixtureHead, new Date().toISOString());
          for (let n = 1; n <= ${mode === 'ceiling' ? 3 : 1}; n++) {
            db.prepare(\`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,
              pass_kind,started_at,ended_at,status,head_sha,gh_comment_id)
              VALUES (?,101,?,'claude',?, ?,?,'completed',?,?)\`)
              .run(fixtureRepo,n,n === 1 ? 'first-pass' : 'rereview','2026-01-01T00:00:00Z',
                '2026-01-01T00:01:00Z',fixtureHead,'synthetic-review-' + n);
          }
          if (${JSON.stringify(mode)} !== 'no-intent') {
            const accepted = requestReviewRereview({ rootDir: ${JSON.stringify(REPO_ROOT)}, db, repo: fixtureRepo, prNumber: 101,
              targetRevisionRef: fixtureHead, reason: 'retrigger-review: synthetic fixture',
              explicitReviewRequest: { requestId: 'synthetic-request', actor: 'fixture-operator' } });
            assert.equal(accepted.triggered,true,JSON.stringify(accepted));
          } else db.prepare("UPDATE reviewed_prs SET review_status='pending', posted_at=NULL WHERE pr_number=101").run();
          if (${JSON.stringify(mode)} === 'expired') db.prepare(
            "UPDATE explicit_review_intents SET expires_at='2026-01-01T00:00:00Z'").run();
          globalThis.explicitCredentialHold = ${mode === 'credential-hold'};
        `,
        afterFirstPoll: `
          const spawns = () => (globalThis.__watcherClaimLoopReviewerSpawns || [])
            .filter(payload => payload.subjectContext?.prNumber === 101);
          const receipt = () => db.prepare('SELECT * FROM explicit_review_intents WHERE pr_number=101').get();
          if (${JSON.stringify(mode)} === 'credential-hold') {
            assert.equal(spawns().length,0);
            assert.equal(receipt().state,'pending');
            assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=101').get().review_status,'pending');
            const { stmtRestoreReviewedHeadDedupSuppressedReviewPosted } =
              await import(${JSON.stringify(fileUrl('src', 'review-state-db.mjs'))});
            assert.equal(stmtRestoreReviewedHeadDedupSuppressedReviewPosted.run(
              new Date().toISOString(), 'sha-happy-101', 'example/review-fixture', 101, 'sha-happy-101').changes, 0,
              'a stale duplicate observation cannot restore posted over an accepted pending request');
            globalThis.explicitCredentialHold = false;
            await pollOnce(octokit,pollOptions);
          }
          if (${JSON.stringify(['dispatch', 'credential-hold'].includes(mode))}) {
            assert.equal(spawns().length,1);
            assert.equal(receipt().state,'consumed');
            assert.equal(db.prepare("SELECT pass_kind FROM reviewer_passes WHERE pr_number=101 ORDER BY pass_id DESC LIMIT 1").get().pass_kind,'rereview');
            db.prepare("UPDATE reviewed_prs SET review_status='pending',reviewer_session_uuid=NULL WHERE pr_number=101").run();
            await pollOnce(octokit,pollOptions);
            assert.equal(spawns().length,1,'consumed request must never authorize a second dispatch');
          } else {
            assert.equal(spawns().length,${mode.startsWith('spawn-') ? 1 : 0});
            if (${JSON.stringify(mode)} !== 'no-intent') {
              assert.equal(receipt().state,'refused');
              assert.ok(receipt().notified_at);
              assert.ok(githubWrites.some(write => write.args[0].body.includes('Re-review could not run')));
            }
          }
        `,
      });
      if (mode === 'spawn-throw') runner = runner.replace('await pollOnce(octokit, pollOptions);',
        "await assert.rejects(pollOnce(octokit, pollOptions), /synthetic spawn failure/);");
      runner = runner.replace("if (property === 'listLabelsOnIssue') {", `
        if (property === 'createComment') return async (params) => {
          githubWrites.push({ property, args: [params] });
          return { data: { id: 71 } };
        };
        if (property === 'listLabelsOnIssue') {`);
      writeFileSync(runnerPath, seatIdleSynthetic(runner));
      const env = installGhFixture(tmp);
      const ghPath = path.join(tmp, 'gh');
      writeFileSync(ghPath, seatIdleSynthetic(readFileSync(ghPath, 'utf8')));
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 30_000 });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('REPORENAME-01: the next watcher cycle keeps the existing review after a stable-id rename', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'repository-poll-'));
  const loaderPath = path.join(tmp, 'loader.mjs');
  const registerPath = path.join(tmp, 'register.mjs');
  const runnerPath = path.join(tmp, 'runner.mjs');
  const synthetic = source => seatIdleSynthetic(source).replaceAll('example/review-fixture', 'example-org/alpha');
  try {
    let loader = buildLoaderSource({ discoveryHookSource: `
      if (globalThis.__repositoryRenamed) {
        for (const subject of subjects) subject.ref.subjectExternalId =
          subject.ref.subjectExternalId.replace('example-org/alpha#', 'example-org/beta#');
      }
    ` });
    loader = loader.replace('  return nextLoad(url, context);', `
      if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
        const loaded = await nextLoad(url, context);
        return { ...loaded, source: loaded.source.toString().replace(
          "const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));",
          "const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')); config.org = null; config.repos = ['example-org/alpha'];"
        ) };
      }
      return nextLoad(url, context);
    `);
    writeFileSync(loaderPath, synthetic(loader));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, synthetic(buildRunnerSource({ afterFirstPoll: `
      const { observeRepositoryIdentity } = await import(${JSON.stringify(fileUrl('src', 'repository-identity.mjs'))});
      db.prepare("UPDATE reviewed_prs SET review_status='posted', posted_at='2026-10-30' WHERE pr_number=101").run();
      const before = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
      const passes = db.prepare('SELECT * FROM reviewer_passes WHERE pr_number=101').all();
      const spawns = (globalThis.__watcherClaimLoopReviewerSpawns || []).length;
      const identity = { db, rootDir: ${JSON.stringify(tmp)}, repository: { id: 123, full_name: 'example-org/alpha', node_id: 'R_fixture123' } };
      observeRepositoryIdentity(identity);
      observeRepositoryIdentity({ ...identity, repository: { ...identity.repository, full_name: 'example-org/beta' } });
      globalThis.__repositoryRenamed = true;
      await pollOnce(octokit, pollOptions);
      const after = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
      assert.equal(after.repo, 'example-org/beta');
      assert.equal(after.review_status, 'posted');
      assert.equal(after.review_attempts, before.review_attempts);
      assert.equal(db.prepare('SELECT count(*) AS n FROM reviewed_prs WHERE pr_number=101').get().n, 1);
      assert.deepEqual(db.prepare('SELECT pass_id FROM reviewer_passes WHERE pr_number=101').all(),
        passes.map(pass => ({ pass_id: pass.pass_id })));
      assert.equal((globalThis.__watcherClaimLoopReviewerSpawns || []).length, spawns);
    ` })));
    const env = installGhFixture(tmp);
    const ghPath = path.join(tmp, 'gh');
    writeFileSync(ghPath, synthetic(readFileSync(ghPath, 'utf8')));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(env), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const stale of ['none', 'release-order', 'head-moved', 'closed', 'merged', 'unreadable', 'slow-settlement', 'durable-refill']) {
  test(stale === 'slow-settlement'
    ? 'SEATIDLE-03: default admission hands off before slow runtime accounting finishes'
    : stale === 'durable-refill'
    ? 'SEATIDLE-04: real poll refills durable pending rows after the sole queued candidate refuses'
    : stale === 'release-order'
    ? 'SEATIDLE-02: real poll releases the credential reservation before an immediate handoff'
    : `SEATIDLE-01: real poll hands off retained candidates while posted work blocks (${stale})`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'seatidle-handoff-'));
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    try {
      let loader = buildLoaderSource({
        discoveryHookSource: `
          if (!globalThis.__seatIdleDiscovered) {
            globalThis.__seatIdleDiscovered = true;
            const template = subjects[0];
            subjects.splice(0, subjects.length, ...[201, 202, 203, 204].map(prNumber => ({
              ...template, headSha: 'sha-happy-' + prNumber,
              ref: { ...template.ref, subjectExternalId: REPO + '#' + prNumber, revisionRef: 'sha-happy-' + prNumber },
            })));
          }
        `,
        reviewerRuntimeSource: `
          globalThis.__watcherClaimLoopReviewerSpawns = [];
          globalThis.__seatIdleReturns = new Map();
          globalThis.__seatIdleWaiters = new Map();
          export function createReviewerRuntimeAdapterForDomain() {
            return { spawnReviewer: async payload => {
              const pr = payload.subjectContext.prNumber;
              globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
              payload.onReviewerPgid?.({ pgid: 123456, spawnedAt: new Date().toISOString() });
              globalThis.__seatIdleWaiters.get(pr)?.();
              await new Promise(resolve => globalThis.__seatIdleReturns.set(pr, resolve));
              // This runtime stub has no review-capture ledger; supply the
              // durable post evidence that the production spawn result carries.
              return { ok: true, stdout: '', stderr: '', durablePostedAt: Date.now() - 1000 };
            }, cancel: async () => {}, reattach: async () => ({}) };
          }
          export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
          export function loadDomainConfig() { return {}; }
          export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
        `,
      });
      const postedUrl = fileUrl('src', 'posted-review-row.mjs');
      const routeUrl = fileUrl('src', 'reviewer-route-selection.mjs');
      const capacityUrl = fileUrl('src', 'reviewer-runtime-support.mjs');
      const wakeUrl = fileUrl('src', 'watcher-wake.mjs');
      loader = loader.replace('export async function resolve', `
        if (${JSON.stringify(['release-order', 'durable-refill'].includes(stale))}) {
          stubs.set(${JSON.stringify(routeUrl)}, 'fixture:seatidle-route');
          stubs.set(${JSON.stringify(capacityUrl)}, 'fixture:seatidle-capacity');
        }
        stubs.set(${JSON.stringify(wakeUrl)}, 'fixture:seatidle-wake');
        stubs.set(${JSON.stringify(postedUrl)}, 'fixture:seatidle-posted');
        export async function resolve`);
      loader = loader.replace('export async function load(url, context, nextLoad) {', `
        export async function load(url, context, nextLoad) {
          if (${JSON.stringify(stale === 'slow-settlement')} && url === ${JSON.stringify(fileUrl('src', 'reviewer-spawn-settle.mjs'))}) {
            const result = await nextLoad(url, context);
            result.source = String(result.source).replace('if (result.stdoutTail)',
              'if (prNumber === 201) { globalThis.__seatIdleSettlementEntered = true; await globalThis.__seatIdleSettlementGate; globalThis.__seatIdleSettlementDone = true; } if (result.stdoutTail)');
            return result;
          }
          if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
            const result = await nextLoad(url, context);
            result.source = String(result.source).replace(
              "JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
              '({ org: "example", repos: ["example/review-fixture"] })');
            if (${JSON.stringify(stale === 'durable-refill')}) {
              result.source = result.source.replace('const reviewerRefillContexts =',
                'globalThis.__seatIdleAdmission = reviewerAdmission; const reviewerRefillContexts =');
            }
            if (${JSON.stringify(stale === 'release-order')}) {
              result.source = result.source.replace(
                'onCapacityFreed: async (',
                'onCapacityFreed: globalThis.__seatIdleCapacityFreed = async (');
              result.source = result.source.replace(
                'createReviewerAdmissionQueue({ candidates: reviewerDispatchCandidates, startedAt: Date.now() - Math.floor(process.uptime() * 1000) })',
                'createReviewerAdmissionQueue({ candidates: reviewerDispatchCandidates, schedule: callback => callback() })');
              result.source = result.source.replace(
                'const reviewerMemoryReservationState =',
                \`const notifyCapacityFreed = reviewerAdmission.capacityFreed;
                 globalThis.__seatIdleCapacityCounts = [];
                 reviewerAdmission.capacityFreed = () => {
                   globalThis.__seatIdleCapacityCounts.push(detachedReviewerDispatchTracker.activeCounts().get('gemini') || 0);
                   notifyCapacityFreed();
                 };
                 const reviewerMemoryReservationState =\`);
            }
            return result;
          }
          if (url === 'fixture:seatidle-wake') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
            import * as actual from '${wakeUrl}?actual';
            export * from '${wakeUrl}?actual';
            export function requestWatcherWake(args) {
              if (args.reason === 'reviewer-capacity-freed') {
                globalThis.__seatIdleDurableWakes = (globalThis.__seatIdleDurableWakes || 0) + 1;
              }
              return actual.requestWatcherWake(args);
            }
          `)} };
          if (url === 'fixture:seatidle-route') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
            import * as actual from '${routeUrl}?actual';
            import { REVIEWER_ROUTE_BY_MODEL } from '${fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')}';
            export * from '${routeUrl}?actual';
            export function selectReviewerRouteForAttempt(args) {
              return { ...actual.selectReviewerRouteForAttempt(args), ...REVIEWER_ROUTE_BY_MODEL.gemini, quotaBlocked: false };
            }
          `)} };
          if (url === 'fixture:seatidle-capacity') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
            export * from '${capacityUrl}?actual';
            export async function resolveGeminiCredentialConcurrencyForDispatchCandidates() { return 1; }
          `)} };
          if (url === 'fixture:seatidle-posted') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
            export * from ${JSON.stringify(postedUrl + '?actual')};
            export async function runQueuedReviewAdoptionPhase(args) {
              await args.drainReviewerDispatchCandidates('posted-review handlers');
              globalThis.__seatIdlePollEntered();
              await globalThis.__seatIdlePollGate;
            }
          `)} };
      `);
      // Hook the existing live-state port, rather than implementing a second
      // freshness rule in the admission controller.
      loader = loader.replace("return { state: 'open', mergedAt: null, closedAt: null, headRefOid, labels: [] };",
        "if (globalThis.__seatIdleLiveState) { const live = globalThis.__seatIdleLiveState(prNumber); if (live) return live; } return { state: 'open', mergedAt: null, closedAt: null, headRefOid, labels: [] };");
      // Replace only fixture literals; module URLs must keep their real names.
      loader = seatIdleSynthetic(loader);
      writeFileSync(loaderPath, loader);
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      let runner = buildRunnerSource({
        prePollSetup: `
          ${stale === 'release-order' ? `
            await globalThis.__seatIdleCapacityFreed();
            await globalThis.__seatIdleCapacityFreed({});
            await globalThis.__seatIdleCapacityFreed({ candidate: null });
            assert.deepEqual(globalThis.__seatIdleCapacityCounts, [0, 0, 0],
              'missing candidate metadata still wakes retained admission');
            assert.equal(globalThis.__seatIdleDurableWakes || 0, 0,
              'missing admission outcomes do not request discovery');
            globalThis.__seatIdleCapacityCounts.length = 0;
          ` : ''}
          globalThis.__seatIdleLiveState = pr => {
            if (!globalThis.__seatIdleStale || pr !== 202) return null;
            if (globalThis.__seatIdleStale === 'unreadable') throw new Error('synthetic unavailable state');
            return { state: globalThis.__seatIdleStale === 'head-moved' ? 'open' : 'closed',
              mergedAt: globalThis.__seatIdleStale === 'merged' ? '2026-10-15T01:00:00Z' : null,
              headRefOid: 'moved-head', labels: [] };
          };
          let releaseSettlement;
          globalThis.__seatIdleSettlementGate = new Promise(resolve => { releaseSettlement = resolve; });
          let enterPoll, releasePoll;
          const pollEntered = new Promise(resolve => { enterPoll = resolve; });
          globalThis.__seatIdlePollEntered = enterPoll;
          globalThis.__seatIdlePollGate = new Promise(resolve => { releasePoll = resolve; });
          let pollFinished = false;
          const starts = () => globalThis.__watcherClaimLoopReviewerSpawns.map(spawn => spawn.subjectContext.prNumber);
          async function waitForStart(pr) {
            if (starts().includes(pr)) return;
            let timer;
            try {
              await Promise.race([
                new Promise(resolve => globalThis.__seatIdleWaiters.set(pr, resolve)),
                // The unresolved poll gate pins ordering; allow accounting workers
                // time to settle under load without turning this into a latency test.
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('handoff waited for blocked poll: ' + pr)), 10000); }),
              ]);
            } finally { clearTimeout(timer); }
          }
        `,
        afterFirstPoll: `
          assert.equal(pollFinished, false);
          assert.deepEqual(starts(), [201]);
          ${stale === 'durable-refill' ? `
            const queue = globalThis.__seatIdleAdmission.candidates;
            queue.splice(0, queue.length, ...queue.filter(candidate => candidate.prNumber === 202));
            assert.deepEqual(queue.map(candidate => candidate.prNumber), [202]);
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reviewed_prs WHERE pr_number IN (203, 204) AND review_status = 'pending'").get().n, 2);
          ` : ''}
          globalThis.__seatIdleStale = ${JSON.stringify(stale === 'durable-refill' ? 'head-moved' : ['none', 'release-order', 'slow-settlement'].includes(stale) ? null : stale)};
          globalThis.__seatIdleReturns.get(201)();
          await waitForStart(${['none', 'release-order', 'slow-settlement'].includes(stale) ? 202 : 203});
          assert.equal(pollFinished, false, 'next spawn precedes the end of posted-review work');
          assert.equal(globalThis.__seatIdleDurableWakes, 1,
            'only the finished reviewer requests discovery; pre-spawn refusals do not repoll');
          assert.deepEqual(starts(), ${JSON.stringify(['none', 'release-order', 'slow-settlement'].includes(stale) ? [201, 202] : [201, 203])});
          ${stale === 'release-order' ? `
            assert.ok(globalThis.__seatIdleCapacityCounts.length > 0);
            assert.ok(globalThis.__seatIdleCapacityCounts.every(count => count === 0),
              'every capacity-freed signal follows credential reservation release');
          ` : ''}
          ${stale === 'slow-settlement' ? `
            assert.equal(globalThis.__seatIdleSettlementEntered, true);
            assert.equal(Boolean(globalThis.__seatIdleSettlementDone), false,
              'the next reviewer starts while the prior accounting is blocked');
          ` : ''}
          releaseSettlement();
          releasePoll(); await runningPoll;
          for (let turn = 0; turn < 5; turn++) {
            for (const resolve of globalThis.__seatIdleReturns.values()) resolve();
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        `,
      });
      runner = runner.replace('await pollOnce(octokit, pollOptions);', `
        const runningPoll = pollOnce(octokit, pollOptions).then(() => { pollFinished = true; });
        await pollEntered;`);
      runner = seatIdleSynthetic(runner);
      writeFileSync(runnerPath, runner);
      const result = spawnSync(process.execPath,
        ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
          cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
          env: fixtureEnv({ ...installGhFixture(tmp),
            AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '1',
            ADVERSARIAL_REVIEWER_DISPATCH_SINGLE_WAVE_SETTLE_GRACE_MS: '1',
            ADVERSARIAL_REVIEW_ADMISSION_SETTLEMENT_SPLIT: stale === 'slow-settlement' ? '' : 'false',
          }),
        });
      assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
      assert.match(result.stdout, /reviewer admission on capacity-freed: dispatched=1 idle_ms=\d+/);
      if (stale === 'durable-refill') assert.match(result.stdout, /reviewer admission refill: candidates=2 admitted=1 idle_ms=\d+/);
      if (['none', 'durable-refill'].includes(stale)) assert.match(result.stdout, /reviewer seat handoff: model=\S+ post_to_spawn_ms=\d+/);
      const freshnessEvidence = {
        'head-moved': /head moved since reviewer claim/,
        closed: /was closed since tick-start snapshot/,
        merged: /was merged since tick-start snapshot/,
        unreadable: /queued reviewer freshness read deferred/,
      };
      if (freshnessEvidence[stale]) assert.match(`${result.stdout}${result.stderr}`, freshnessEvidence[stale]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

for (const priorStatus of ['pending', 'failed']) test(`SEATIDLE-01: unreadable queued freshness refunds a ${priorStatus} claim and releases its same-head lease`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'seatidle-freshness-refund-'));
  const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
  try {
    let loader = buildLoaderSource().replace('const overrides = globalThis.__watcherClaimLoopFreshHeads || {};',
      "if (prNumber === 101 && globalThis.__seatIdleReadError) throw new Error('synthetic unavailable state'); const overrides = globalThis.__watcherClaimLoopFreshHeads || {};");
    const gateUrl = fileUrl('src', 'reviewed-head-dispatch-gate.mjs');
    loader = loader.replace('export async function resolve', `
      stubs.set(${JSON.stringify(gateUrl)}, 'fixture:seatidle-real-lease');
      export async function resolve`);
    loader = loader.replace('export async function load(url, context, nextLoad) {', `
      export async function load(url, context, nextLoad) {
        if (url === 'fixture:seatidle-real-lease') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          export * from ${JSON.stringify(gateUrl + '?actual')};
          import { createHeadDispatchLease as create } from ${JSON.stringify(gateUrl + '?actual')};
          export function createHeadDispatchLease() {
            return globalThis.__seatIdleRealLease = create();
          }
        `)} };
        if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
          const result = await nextLoad(url, context);
          result.source = String(result.source).replace(
            "JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
            '({ org: "example", repos: ["example/review-fixture"] })');
          return result;
        }
    `);
    writeFileSync(loaderPath, seatIdleSynthetic(loader));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    let runner = buildRunnerSource({
      prePollSetup: `
        db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
          review_status, review_attempts, labels_json, reviewer_head_sha, revision_ref, failed_at,
          failure_message, reviewer_session_uuid, reviewer_timeout_ms)
          VALUES ('example/review-fixture', 101, '2026-05-15T12:00:00Z', 'claude', 'open',
            '${priorStatus}', 1, '[]', 'sha-happy-101', 'prior-revision',
            ${priorStatus === 'failed' ? "'2026-05-15T12:01:00Z'" : 'NULL'},
            ${priorStatus === 'failed' ? "'Command failed with code 1'" : 'NULL'}, 'prior-session', 1234)\`).run();
        const before = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
      `,
      afterFirstPoll: `
        const refunded = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
        for (const key of ['review_status', 'review_attempts', 'reviewer_head_sha', 'failed_at',
          'failure_message', 'reviewer_session_uuid', 'reviewer_timeout_ms']) {
          assert.equal(refunded[key], before[key], 'refunded ' + key);
        }
        assert.ok(!globalThis.__watcherClaimLoopReviewerSpawns.some(s => s.subjectContext.prNumber === 101));
        assert.equal(globalThis.__seatIdleRealLease.has('example/review-fixture#101@sha-happy-101'), false,
          'the unconditional finally releases the real process-lifetime lease after freshness deferral');
        assert.deepEqual(globalThis.__seatIdleClaimLeaseStates, [true]);
        globalThis.__seatIdleReadError = false;
        await pollOnce(octokit, pollOptions);
        assert.equal(claims.filter(c => c.prNumber === 101).length, 2);
        assert.equal(claims.filter(c => c.prNumber === 101)[0].reviewerHeadSha,
          claims.filter(c => c.prNumber === 101)[1].reviewerHeadSha, 'retry reacquires the same head');
        assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.filter(s => s.subjectContext.prNumber === 101).length, 1);
        assert.deepEqual(globalThis.__seatIdleClaimLeaseStates, [true, true],
          'the real lease is held at each claim, including the same-head retry');
      `,
    });
    runner = runner.replace('claims.push(payload);', `
      claims.push(payload);
      if (payload.prNumber === 101) (globalThis.__seatIdleClaimLeaseStates ||= []).push(
        globalThis.__seatIdleRealLease.has('example/review-fixture#101@sha-happy-101'));
      if (payload.prNumber === 101 && claims.filter(c => c.prNumber === 101).length === 1) globalThis.__seatIdleReadError = true;
    `);
    writeFileSync(runnerPath, seatIdleSynthetic(runner));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
        env: fixtureEnv(installGhFixture(tmp)),
      });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    assert.match(result.stderr, /queued reviewer freshness read deferred/);
    assert.doesNotMatch(result.stdout, /dispatch lease already held/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('REVIEWSPILL-01: a late Claude account hold releases the claim and refunds its age reservation', () => {
  const { summary, output } = runDepthDiscoveryScenario({ depthEngaged: false, ageSpill: true, lateAccountHold: true });
  assert.equal(summary.rows['101'].review_status, 'pending', output);
  assert.equal(summary.reviewerSpawns.length, 1, output);
  assert.equal(summary.reviewerSpawns[0].subjectContext.prNumber, 102, output);
  assert.equal(summary.reviewerSpawns[0].subjectContext.reviewerModel, 'claude', output);
  assert.match(output, /review-queue-depth-spillover-refund .*pr=101/);
  assert.match(output, /review-wait-spill .*pr=102/);
  assert.equal(summary.depthDiagnostics.report.engagementSpilloverReviews, 1);
  assert.equal(summary.depthDiagnostics.report.cost.spilloverReviewsTotal, 1);
});

for (const age of [600, 901]) {
  test(`REVIEWSPILL-01: production re-review wait telemetry uses the 900-second bound at ${age}s`, () => {
    const { output } = runDepthDiscoveryScenario({ depthEngaged: false, ageSpill: true, rereviewAge: age });
    assert.doesNotMatch(output, /review-wait-decision .*pr=101 .*pass_kind=first-pass/);
    if (age === 600) assert.doesNotMatch(output, /review-wait-decision .*pr=101 /);
    else assert.match(output, /review-wait-decision .*pr=101 .*pass_kind=rereview/);
  });
}

for (const startupState of ['open', 'drain', 'drain-cleared-during-recovery', 'closed', 'merged']) test(`STARTADMIT-01: startup admission follows recovery and drain guards (${startupState})`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'startup-admission-'));
  const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
  try {
    let loader = buildLoaderSource({ subjectHeads: { '102': null }, subject101Overrides: { labels: ['risk:medium', 'merge-agent-dispatched'] }, discoveryHookSource: `
      if (['closed', 'merged'].includes(process.env.FIXTURE_STARTUP_STATE)) subjects[0].terminal = true;
      globalThis.__startupDiscoverySawSpawn = globalThis.__watcherClaimLoopReviewerSpawns.some(
        spawn => spawn.subjectContext.prNumber === 101);
    `, reviewerRuntimeSource: `
      globalThis.__watcherClaimLoopReviewerSpawns = [];
      export function createReviewerRuntimeAdapterForDomain() { return {
        spawnReviewer: async payload => {
          if (globalThis.__startupRecoveryPhases?.slice(-3).join(',') !== 'lifecycle,sessions,passes') {
            throw new Error('startup reviewer spawned before lifecycle/session/pass recovery');
          }
          globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
          payload.onReviewerPgid?.({ pgid: 123456, spawnedAt: new Date().toISOString() });
          return { ok: true, stdout: '', stderr: '' };
        }, cancel: async () => {}, reattach: async () => ({}),
      }; }
      export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
      export function loadDomainConfig() { return {}; }
      export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
    ` });
    loader = loader.replace("return { state: 'open', mergedAt: null, closedAt: null, headRefOid, labels: [] };",
      "return { state: process.env.FIXTURE_STARTUP_STATE === 'merged' ? 'MERGED' : process.env.FIXTURE_STARTUP_STATE === 'closed' ? 'closed' : 'open', mergedAt: process.env.FIXTURE_STARTUP_STATE === 'merged' ? '2026-05-15T12:01:00Z' : null, closedAt: process.env.FIXTURE_STARTUP_STATE === 'closed' ? '2026-05-15T12:01:00Z' : null, headRefOid, labels: [] };");
    loader = loader
      .replace('export function scanStuckMergeAgentDispatches() { return []; }',
        'export function scanStuckMergeAgentDispatches(args) { (globalThis.__startupStuckScanInputs ||= []).push(args); return []; }')
      .replace('export async function reconcileProactivePhantomHandoffs() { return { inspected: 0, graceStarted: 0, escalated: 0 }; }',
        'export async function reconcileProactivePhantomHandoffs(args) { (globalThis.__startupPhantomInputs ||= []).push(args); return { inspected: 0, graceStarted: 0, escalated: 0 }; }');
    loader = loader.replace('export async function load(url, context, nextLoad) {', `
      export async function load(url, context, nextLoad) {
        if (url === ${JSON.stringify(fileUrl('src', 'watcher.mjs'))}) {
          const result = await nextLoad(url, context);
          result.source = String(result.source).replace(
            "JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
            '({ org: "example", repos: ["example/review-fixture"] })')
            .replace("join(ROOT, 'data', 'watcher-drain.json')", ${JSON.stringify(JSON.stringify(path.join(tmp, 'drain.json')))})
            .replace('await syncPRLifecycle(octokit, operatorSurface, WATCHER_PRIMARY_DOMAIN_ID);',
              "await syncPRLifecycle(octokit, operatorSurface, WATCHER_PRIMARY_DOMAIN_ID); (globalThis.__startupRecoveryPhases ||= []).push('lifecycle'); if (process.env.FIXTURE_STARTUP_STATE === 'drain-cleared-during-recovery') (await import('node:fs')).rmSync(" + ${JSON.stringify(JSON.stringify(path.join(tmp, 'drain.json')))} + ");")
            .replace('if (reattach.skipped > 0)', "globalThis.__startupRecoveryPhases.push('sessions'); if (reattach.skipped > 0)")
            .replace('if (passReaper.reaped > 0)', "globalThis.__startupRecoveryPhases.push('passes'); if (passReaper.reaped > 0)")
            .replace("await drainReviewerDispatchCandidates('startup durable pending');",
              "globalThis.__startupDrainCalls = (globalThis.__startupDrainCalls || 0) + 1; await drainReviewerDispatchCandidates('startup durable pending');");
          return result;
        }
    `);
    writeFileSync(loaderPath, seatIdleSynthetic(loader));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, seatIdleSynthetic(buildRunnerSource({
      prePollSetup: `
        const { writeFileSync, rmSync } = await import('node:fs');
        const startupState = process.env.FIXTURE_STARTUP_STATE;
        const drainFile = ${JSON.stringify(path.join(tmp, 'drain.json'))};
        if (startupState.startsWith('drain')) writeFileSync(drainFile, JSON.stringify({
          reason: 'fixture maintenance', expiresAt: new Date(Date.now() + 60000).toISOString(),
        }));
        db.prepare(\`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
          review_status, revision_ref, labels_json)
          VALUES ('example/review-fixture', 101, '2026-05-15T12:00:00Z', 'claude', 'open',
            'pending', 'sha-happy-101', '[]')\`).run();
      `,
      healthProbeSetup: `
        pollOptions.consumeWakePayload = () => {
          assert.deepEqual(globalThis.__startupRecoveryPhases?.slice(-3), ['lifecycle', 'sessions', 'passes'],
            'quota/refill context construction must not consume wakes before recovery');
          globalThis.__startupLateWakeRead = true;
          return { repo: 'example/review-fixture', pr_number: 101, head_sha: 'sha-happy-101' };
        };
      `,
      afterFirstPoll: `
        assert.deepEqual(globalThis.__startupRecoveryPhases, ['lifecycle', 'sessions', 'passes']);
        assert.equal(globalThis.__startupLateWakeRead, true, 'recovered wakes must be consumed in the same poll');
        if (startupState === 'drain') {
          assert.equal(globalThis.__startupDrainCalls || 0, 0, 'active drain must skip startup refill');
          assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, 0);
          assert.equal(claims.filter(c => c.prNumber === 101).length, 0);
          rmSync(drainFile);
          await pollOnce(octokit, pollOptions);
          assert.equal(globalThis.__startupDrainCalls, 1, 'startup refill remains armed until drain clears');
        }
        if (['closed', 'merged'].includes(startupState)) {
          assert.equal(db.prepare('SELECT pr_state FROM reviewed_prs WHERE pr_number = 101').get().pr_state, startupState);
          assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, 0, 'terminal PRs must not spawn from stale durable rows');
          assert.equal(claims.filter(c => c.prNumber === 101).length, 0);
        } else {
          assert.equal(globalThis.__startupDiscoverySawSpawn, true,
            'a durable pending reviewer must spawn before discovery completes');
          assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.filter(s => s.subjectContext.prNumber === 101).length, 1);
          assert.equal(claims.filter(c => c.prNumber === 101).length, 1, 'rediscovery must keep same-head dedup');
          assert.equal(globalThis.__startupStuckScanInputs.length, startupState === 'drain' ? 2 : 1);
          const scan = globalThis.__startupStuckScanInputs.at(-1);
          assert.deepEqual(scan.activePRs.map(pr => pr.prNumber), [101],
            'startup refill must not duplicate stuck-scan records');
          assert.deepEqual(scan.currentPRs.map(pr => pr.prNumber), [101],
            'startup refill must not duplicate current-head records');
          assert.equal(globalThis.__startupPhantomInputs.length, startupState === 'drain' ? 2 : 1);
          assert.deepEqual(globalThis.__startupPhantomInputs.at(-1).currentPRs.map(pr => pr.prNumber), [101],
            'phantom reconciliation must inspect each discovered PR once');
        }
      `,
    })));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: fixtureEnv({ ...installGhFixture(tmp), FIXTURE_STARTUP_STATE: startupState }),
      });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    if (['open', 'drain'].includes(startupState)) assert.match(result.stdout, /watcher first reviewer spawn: startup_to_spawn_ms=\d+/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const failed of [false, true]) test(`STARTADMIT-01: real poll shares one quota snapshot across candidates (failed=${failed})`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'poll-quota-'));
  const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
  try {
    let loader = buildLoaderSource();
    loader = loader.replace('export async function load(url, context, nextLoad) {', `
      export async function load(url, context, nextLoad) {
        if (url === ${JSON.stringify(fileUrl('src', 'posted-review-row.mjs'))}) {
          const result = await nextLoad(url, context);
          result.source = String(result.source).replace('export async function runQueuedReviewAdoptionPhase(',
            'async function runQueuedReviewAdoptionPhaseActual(');
          result.source += ${JSON.stringify(`
            export async function runQueuedReviewAdoptionPhase(args) {
              globalThis.__quotaPostedSnapshot = await globalThis.__quotaContext.execFileAsync(
                'hq', ['fleet', 'quota', 'status', '--json']).catch(error => {
                  globalThis.__quotaPostedError = error;
                  return null;
                });
              return runQueuedReviewAdoptionPhaseActual(args);
            }
          `)};
          return result;
        }
        if ([${JSON.stringify(fileUrl('src', 'watcher.mjs'))}, ${JSON.stringify(fileUrl('src', 'afh-reviewer-fallback.mjs'))}].includes(url)) {
          const result = await nextLoad(url, context);
          result.source = String(result.source)
            .replace('const execFileAsync = promisify(execFile);', 'const execFileAsync = (...args) => globalThis.__quotaExec(...args);')
            .replace("JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))",
              '({ org: "example", repos: ["example/review-fixture"] })')
            .replace('const reviewContext = {', 'const reviewContext = globalThis.__quotaContext = {')
            .replace('await processReviewSubject(subjectEntry, { ...reviewContext });',
              'await processReviewSubject(subjectEntry, { ...reviewContext }); globalThis.__advanceQuotaClock();');
          return result;
        }
    `);
    writeFileSync(loaderPath, seatIdleSynthetic(loader));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, seatIdleSynthetic(buildRunnerSource({
      prePollSetup: `
        const { promisify } = await import('node:util');
        const { execFile } = await import('node:child_process');
        const actualExec = promisify(execFile);
        let quotaReads = 0, failQuota = false, clockOffset = 0;
        const realNow = Date.now;
        Date.now = () => realNow() + clockOffset;
        globalThis.__advanceQuotaClock = () => { clockOffset += 61_000; };
        globalThis.__quotaExec = async (command, args, options) => {
          if (args.join(' ') !== 'fleet quota status --json') return actualExec(command, args, options);
          quotaReads++;
          if (failQuota) throw new Error('synthetic quota failure');
          return { stdout: JSON.stringify({ providerStatuses: ['openai', 'anthropic', 'google'].map(provider => ({
            provider, authPath: 'oauth', state: 'ok', afhGrounding: { grounded: false },
          })) }) };
        };
      `,
      afterFirstPoll: `
        assert.ok(JSON.parse(globalThis.__quotaPostedSnapshot.stdout).providerStatuses.every(row => row.state === 'ok'),
          'the posted-review phase receives the shared quota snapshot');
        ${failed ? `
          const readsBeforeFailure = quotaReads;
          db.prepare('DELETE FROM reviewed_prs').run();
          failQuota = true;
          await pollOnce(octokit, pollOptions);
          assert.equal(quotaReads, readsBeforeFailure + 1, 'a failed read must be shared for the whole second poll');
          assert.match(globalThis.__quotaPostedError.message, /synthetic quota failure/,
            'posted handlers receive the quota failure instead of stale stdout');
          await assert.rejects(globalThis.__quotaContext.execFileAsync('hq', ['fleet', 'quota', 'status', '--json']),
            /synthetic quota failure/);
          assert.equal(quotaReads, readsBeforeFailure + 1, 'posted handlers reuse the same failure without another read');
        ` : `
          assert.equal(quotaReads, 1, 'N candidates must share one read despite more than one TTL elapsing');
          await globalThis.__quotaContext.execFileAsync('hq', ['fleet', 'quota', 'status', '--json']);
          assert.equal(quotaReads, 1, 'posted-review handlers receive the same quota executor');
        `}
      `,
    })));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
        env: fixtureEnv({ ...installGhFixture(tmp), ADVERSARIAL_AFH_REVIEWER_FALLBACK: '',
          ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: 'codex,claude-code',
          ADVERSARIAL_AFH_CLAUDE_RUNTIME_PROBE: 'false' }),
      });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    assert.match(result.stdout, /quota-status reads per poll: poll=1 reads=1/);
    if (failed) {
      assert.match(result.stderr, /afh-reviewer-grounding stale-if-error/);
      assert.match(result.stdout, /quota-status reads per poll: poll=2 reads=1/);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('retry fallback refreshes corporate Codex cooldown recorded after initial route selection', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-codex-cooldown-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    const routeUrl = fileUrl('src', 'reviewer-route-selection.mjs');
    const routeSource = `
      import * as actual from '${routeUrl}?actual';
      import { REVIEWER_ROUTE_BY_MODEL } from '${fileUrl('src', 'adapters', 'subject', 'github-pr', 'routing.mjs')}';
      import { recordCorporateCodexQuotaCooldown } from '${fileUrl('src', 'codex-account-routing.mjs')}';
      export * from '${routeUrl}?actual';
      const selected = new Set();
      export function selectReviewerRouteForAttempt(args) {
        if (!selected.has(args.prNumber)) {
          selected.add(args.prNumber);
          // Simulate another review exhausting corporate quota while this candidate waits.
          recordCorporateCodexQuotaCooldown(args.rootDir);
          return { ...actual.selectReviewerRouteForAttempt(args), ...REVIEWER_ROUTE_BY_MODEL.gemini };
        }
        if (args.afhGrounding?.codexAccountSelection?.provider !== 'codex') {
          throw new Error('retry fallback received stale corporate account grounding');
        }
        // Exercise execution fallback with the caller's current account grounding.
        return actual.selectReviewerRouteForAttempt({ ...args, baseRoute: REVIEWER_ROUTE_BY_MODEL.gemini,
          currentRow: { review_status: 'failed', reviewer: 'gemini', reviewer_head_sha: args.headSha,
            failure_message: '[quota-exhausted] synthetic exhaustion', infra_auto_recover_attempts: 1 } });
      }
    `;
    const runtimeSource = `
      globalThis.__watcherClaimLoopReviewerSpawns = [];
      export function createReviewerRuntimeAdapterForDomain() { return {
        async spawnReviewer(payload) {
          globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
          return payload.model === 'gemini' ? { ok: false, failureClass: 'quota-exhausted' }
            : { ok: true, stdout: '', stderr: '' };
        }, cancel: async () => {}, reattach: async () => ({})
      }; }
      export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
      export function loadDomainConfig() { return {}; }
      export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
    `;
    const loader = buildLoaderSource({ reviewerRuntimeSource: runtimeSource, discoveryHookSource: 'return [subjects[0].ref];' })
      .replaceAll("builderClass: 'codex'", "builderClass: 'claude-code'")
      .replaceAll('[codex]', '[claude-code]')
      .replace('  return nextLoad(url, context);', `
        if (url === ${JSON.stringify(routeUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(routeSource)} };
        return nextLoad(url, context);
      `);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
      env: fixtureEnv({ ...installGhFixture(tmp), ADVERSARIAL_REVIEW_STATE_DIR: tmp }),
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const line = result.stdout.split(/\r?\n/).find(entry => entry.startsWith(SUMMARY_MARKER));
    assert.ok(line, output);
    const summary = JSON.parse(line.slice(SUMMARY_MARKER.length));
    const codexSpawns = summary.reviewerSpawns.filter(spawn => spawn.model === 'codex');
    assert.equal(codexSpawns.length, 1, output);
    assert.equal(summary.rows['101'].review_status, 'posted', output);
    assert.ok(codexSpawns.every(spawn => spawn.subjectContext.codexBrokerProvider === 'codex'), output);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


test('OSG arm admission fallback preserves watcher claim identity through settlement', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-arm-fallback-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    const armModuleUrl = fileUrl('src', 'osg-reviewer-arm.mjs');
    let loader = buildLoaderSource({
      subject101Overrides: { builderClass: 'gemini' },
      reviewerRuntimeSource: `
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        export function createReviewerRuntimeAdapterForDomain() {
          return { spawnReviewer: async payload => {
            const row = globalThis.__watcherClaimLoopDb.prepare(
              'SELECT reviewer, reviewer_session_uuid FROM reviewed_prs WHERE pr_number = ?'
            ).get(payload.subjectContext.prNumber);
            if (row.reviewer_session_uuid !== payload.sessionUuid || row.reviewer !== payload.model) {
              throw Error('runtime does not match watcher claim');
            }
            globalThis.__watcherClaimLoopReviewerSpawns.push(payload);
            return { ok: true, stdout: '', stderr: '' };
          }, cancel: async () => {}, reattach: async () => ({}) };
        }
        export function createReviewerRuntimeAdapterByName() { return createReviewerRuntimeAdapterForDomain(); }
        export function loadDomainConfig() { return {}; }
        export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }
      `,
    });
    loader = loader.replace('  return nextLoad(url, context);', `
      if (url === ${JSON.stringify(armModuleUrl)}) return {
        format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          export * from '${armModuleUrl}?actual';
          export function applyReviewerArm(options) {
            if (options.baseRoute.builderClass !== 'gemini') return options.baseRoute;
            return { ...options.baseRoute, reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
              reviewerArmDefaultRoute: options.baseRoute,
              reviewerArm: { role: 'reviewer', harness: 'claude', worker_class: 'claude-reviewer',
                model: 'fixture-model', effort: 'high', account: 'fixture-account' } };
          }
        `)}
      };
      return nextLoad(url, context);
    `);
    writeFileSync(loaderPath, loader);
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ afterFirstPoll: `
      const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 101').get();
      assert.equal(row.review_status, 'posted');
      assert.equal(row.reviewer, 'codex');
      const runtime = globalThis.__watcherClaimLoopReviewerSpawns.find(p => p.subjectContext.prNumber === 101);
      assert.ok(runtime);
      assert.equal(runtime.sessionUuid, row.reviewer_session_uuid);
      assert.equal(runtime.subjectContext.reviewerArm, undefined);
    ` }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 20_000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.ok(/osg-reviewer reason=(runtime-unsupported|account-changed|error-account-unavailable)/.test(output), output.split('\n').filter(line => line.includes('osg')).join('\n'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


for (const [status, reason] of [['pending', 'hammer-validated-head'], ['posted', 'closer-commit-trailer']]) {
  test(`HAMVALIDORPHAN-01 ${status} hammer head reaches closure in the same poll`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hammer-owner-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      const postedUrl = fileUrl('src', 'posted-review-row.mjs');
      const orchestrationUrl = fileUrl('src', 'ama-closure-orchestration.mjs');
      const postedSource = `export * from ${JSON.stringify(postedUrl + '?actual')};
        import assert from 'node:assert/strict';
        import { maybeDispatchAmaClosureFor } from ${JSON.stringify(orchestrationUrl)};
        export async function handlePostedReviewRow(input) {
          if (input.prNumber !== 101) return { outcome: 'fixture-other-row' };
          globalThis.hammerHandoffs ||= [];
          globalThis.hammerHandoffs.push(input.existing);
          const result = await maybeDispatchAmaClosureFor({
            rootDir: ${JSON.stringify(tmp)}, repoPath: input.repoPath, prNumber: input.prNumber,
            reviewStateRow: { ...input.existing, review_body: ${JSON.stringify('## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only')} },
            dispatchJob: {}, candidate: { headSha: 'sha-happy-101', prState: 'OPEN', riskClass: 'low',
              mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', branchProtection: { requiredContexts: [] },
              statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
            currentRevisionRef: 'sha-happy-101', labelNames: [],
            loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true,
              branchProtection: { required: false } }), getOrchestrationMode: () => 'native' }),
            fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => head === 'reviewed-fixture'
              ? [${JSON.stringify('## Verdict\nComment only')}] : [],
            proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false,
              reviewedHead: 'reviewed-fixture', currentHead: 'sha-happy-101' }),
            resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: true, reason: ${JSON.stringify(reason)} }),
            fetchHeadCloserVerifiedCommitImpl: async () => null,
            resolveHamTerminalRemediationEvidenceImpl: async () => null,
            headHasValidatedHamTerminalRemediationImpl: () => false,
            fetchMergedProtectiveDependentsImpl: async () => [],
            fetchProtectivePredecessorStateImpl: async () => null,
            requestEligibleHammerWakeImpl: ({ shared }) => {
              if (shared.decision.action === 'hammer') globalThis.hammerWakes = (globalThis.hammerWakes || 0) + 1;
            },
            runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'validation-required' }),
            maybeDispatchAmaCloserImpl: async payload => {
              assert.equal(payload.dispatchContext.targetRemediationSha, 'sha-happy-101');
              assert.equal(payload.reviewState.headSha, 'reviewed-fixture');
              globalThis.hammerDispatches = (globalThis.hammerDispatches || 0) + 1;
              return { dispatched: true, launchRequestId: 'fixture-successor' };
            }, logger: { log() {}, warn() {} },
          });
          assert.equal(result.dispatched, true, JSON.stringify(result));
          return { outcome: 'ama-dispatched', amaClosureResult: result };
        }`;
      let loader = buildLoaderSource().replace("export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; }",
        "export function buildAdversarialGateSnapshot(_root, { reviewRow } = {}) { return globalThis.hammerFixtureArmed ? { reviewedHeadSha: reviewRow?.reviewer_head_sha, settledReview: { verdict: 'comment-only', remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 }, labels: [] } : { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; }")
        .replace("return async () => ({ suppressed: false, reason: 'fixture' });",
        `return async () => globalThis.hammerFixtureArmed ? ({ suppressed: true, reason: '${reason}' }) : ({ suppressed: false });`);
      loader = loader.replace('export async function resolve',
        `stubs.set(${JSON.stringify(postedUrl)}, 'fixture:hammer-posted');\nexport async function resolve`)
        .replace('export async function load(url, context, nextLoad) {',
          `export async function load(url, context, nextLoad) {\nif (url === 'fixture:hammer-posted') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(postedSource)} };`);
      writeFileSync(loaderPath, loader);
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({ afterFirstPoll: `
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
        db.prepare(\`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
          started_at,ended_at,status,head_sha,gh_comment_id,body_md,body_captured_at)
          VALUES (?,101,50,'claude','rereview',?,?,'completed','reviewed-fixture','fixture-review',?,?)\`)
          .run(row.repo, new Date().toISOString(), new Date().toISOString(), '## Verdict\\nComment only', new Date().toISOString());
        db.prepare(\`UPDATE reviewed_prs SET review_status=?,reviewer_head_sha=?,revision_ref='sha-happy-101',
          rereview_requested_at=?,rereview_reason='auto-refresh: posted review on stale head',
          reviewer_session_uuid=NULL,reviewer_lease_expires_at=NULL WHERE pr_number=101\`)
          .run(${JSON.stringify(status)}, ${JSON.stringify(status === 'posted' ? 'reviewed-fixture' : 'failed-attempt-head')}, new Date().toISOString());
        globalThis.hammerFixtureArmed = true;
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        await pollOnce(octokit, pollOptions);
        assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=101').get().review_status, 'posted');
        assert.ok(globalThis.hammerHandoffs.length > 0);
        assert.ok(globalThis.hammerWakes > 0, 'suppression wakes the hammer');
        assert.equal(globalThis.hammerWakes, globalThis.hammerDispatches, 'each handoff invokes the existing closer');
        assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, 0);
        assert.ok(globalThis.hammerHandoffs.every(row => row.reviewer_head_sha === 'reviewed-fixture'));
      ` }));
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 30000 });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}


for (const mode of ['empty', 'unsupported', 'disabled']) {
  test(`DOG-10 ${mode} observation intake claims exactly once on the title route`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-observation-intake-'));
    try {
      const loaderPath = path.join(tmp, 'loader.mjs');
      const registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      const actual = `${fileUrl('src', 'session-ledger-read-adapter.mjs')}?actual`;
      const response = mode === 'empty' ? {schema_version:1,observation:'provenance',status:'not_found',
        complete:true,next_offset:null,scope_complete:false,mutation_authority:false,items:[]} : {};
      writeFileSync(loaderPath, buildLoaderSource({provenanceReaderSource: `
        export * from '${actual}';
        import {readPrBuilderProvenanceAsync as actual} from '${actual}';
        export function readPrBuilderProvenanceAsync(args) {
          return actual({...args, env:{ADVERSARIAL_DISPATCH_READS_ENABLED:'1',
              ${mode === 'disabled' ? '' : "ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:'1'"}},
            ${mode === 'disabled' ? '' : `dispatchSession:{dispatchLookup:async () => (${JSON.stringify(response)})},`}
          });
        }
      `}));
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({afterFirstPoll: `
        assert.equal(claims.filter(claim => claim.prNumber === 101).length,1);
        assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=101').get().review_status,'posted');
        const spawns = globalThis.__watcherClaimLoopReviewerSpawns.filter(spawn => spawn.subjectContext.prNumber === 101);
        assert.equal(spawns.length,1);
        assert.notEqual(spawns[0].model,'codex');
      `}));
      const result = spawnSync(process.execPath,['--no-warnings','--import',pathToFileURL(registerPath).href,runnerPath],{
        cwd:REPO_ROOT,encoding:'utf8',timeout:30000,env:fixtureEnv(installGhFixture(tmp)),
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status,0,output);
      assert.match(output,/builder_class_inconclusive/);
      assert.doesNotMatch(output,/deferring claim until next tick/);
    } finally { rmSync(tmp,{recursive:true,force:true}); }
  });
}

test('HOLDCONTRACT-01: each completed poll evaluates discovered hold subjects once', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hold-contract-poll-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource({ afterFirstPoll: `
      assert.equal(globalThis.__closerHoldPolls, 1);
      assert.ok(globalThis.__closerHoldSubjects.length > 0);
      assert.ok(globalThis.__closerHoldSubjects.every(subject => subject.holdMetadata));
      await pollOnce(octokit, pollOptions);
      assert.equal(globalThis.__closerHoldPolls, 2);
    ` }));
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      { cwd: REPO_ROOT, encoding: 'utf8', env: fixtureEnv(installGhFixture(tmp)), timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('LABELSTOPOWNER-01: failed CI requeue pages before the watcher releases its claim', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ci-requeue-claim-'));
  const admissionUrl = fileUrl('src', 'reviewer-ci-admission.mjs');
  try {
    const source = `
      export * from '${admissionUrl}?actual';
      import { guardRereviewCiBeforeReviewer as actual } from '${admissionUrl}?actual';
      export function guardRereviewCiBeforeReviewer(args) {
        if (args.prNumber !== 101) return { proceed: true, reason: 'fixture-ci-green' };
        return actual({ ...args, rootDir: ${JSON.stringify(tmp)}, passKind: 'rereview',
          inspectCiImpl: async () => ({ state: 'failed', headSha: args.reviewerHeadSha,
            failedChecks: [{ name: 'link-check', state: 'FAILURE' }] }),
          latestJobFinder: () => ({ jobPath: '/fixture/stopped.json', job: { status: 'stopped',
            remediationPlan: { stop: { code: 'operator-label-required:fixture-approved' } } } }),
          requeueImpl: () => { throw new Error('Cannot requeue from stopped:operator-label-required:fixture-approved'); },
          deliverAlertImpl: async body => { (globalThis.__labelStopPages ||= []).push(body); } });
      }
    `;
    runHoldReleaseRegression({
      transformLoader: loader => loader.replace('  return nextLoad(url, context);', `
        if (url === ${JSON.stringify(admissionUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
        return nextLoad(url, context);
      `),
      setup: '',
      verify: `
        assert.equal(globalThis.__labelStopPages.length, 1);
        assert.match(globalThis.__labelStopPages[0], /operator-label-required:fixture-approved/);
        assert.ok(!(globalThis.__watcherClaimLoopReviewerSpawns || []).some(s => s.subjectContext.prNumber === 101));
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
        assert.notEqual(row.review_status, 'reviewing');
        assert.ok(!row.reviewer_session_uuid);
      `,
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


test('OWNERDEADLINE-01: every open subject visits deadline recovery before reviewer admission', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-deadline-'));
  try {
    const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs'), runnerPath = path.join(tmp, 'runner.mjs');
    writeFileSync(loaderPath, buildLoaderSource({ deadlineRecoverySource: `
      export async function recoverOwnerlessReview() { return null; }
      export async function recoverOverdueOwnership({ prNumber, subject }) {
        if (subject.terminal) throw new Error('terminal subject cannot recover');
        (globalThis.__deadlineRecoveries ||= []).push(prNumber);
        return { outcome: 'ama-dispatched' };
      }
    ` }));
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000, env: fixtureEnv(installGhFixture(tmp)),
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summary = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith(SUMMARY_MARKER)).slice(SUMMARY_MARKER.length));
    assert.ok(summary.deadlineRecoveries.includes(101));
    assert.equal(summary.claims.length, 0);
    assert.equal(summary.reviewerSpawns.length, 0);
    assert.equal(summary.githubWrites.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const initialStatus of ['posted', 'pending', 'pending-upstream', 'ci-blocked', 'sequence', 'parked-green', 'expired-hammer-handoff']) {
  test(`CLOSERDEADLOCK-01 ${initialStatus} final-round push remains in the closer lane`, () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-final-round-owner-'));
    const reviewed = '1'.repeat(40), pushed = '2'.repeat(40);
    const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- Synthetic typo.\n## Verdict\nComment only';
    try {
      const postedUrl = fileUrl('src', 'posted-review-row.mjs');
      const finalRoundUrl = fileUrl('src', 'comment-only-final-round.mjs');
      const postedSource = `export * from ${JSON.stringify(postedUrl + '?actual')};
        import assert from 'node:assert/strict';
        import { maybeDispatchAmaClosureFor } from ${JSON.stringify(fileUrl('src', 'ama-closure-orchestration.mjs'))};
        export async function handlePostedReviewRow(input) {
          if (input.prNumber !== 101 || !globalThis.finalRoundArmed) return { outcome: 'fixture-other-row' };
          const green = globalThis.finalRoundGreen === true;
          const result = await maybeDispatchAmaClosureFor({
            rootDir: ${JSON.stringify(tmp)}, repoPath: input.repoPath, prNumber: 101,
            reviewStateRow: { ...input.existing, review_body: ${JSON.stringify(body)}, last_verdict: 'Comment only', risk_class: 'low' }, dispatchJob: {}, currentRevisionRef: '${pushed}', labelNames: [],
            candidate: { headSha: '${pushed}', prState: 'OPEN', riskClass: 'low', isDraft: false,
              mergeable: 'MERGEABLE', mergeStateStatus: green ? 'CLEAN' : 'BLOCKED',
              branchProtection: { requiredContexts: [] },
              statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit',
                status: green ? 'COMPLETED' : 'IN_PROGRESS', conclusion: green ? 'SUCCESS' : null }] },
            now: () => Date.parse(globalThis.finalRoundCompletedAt) + (${JSON.stringify(initialStatus)} === 'expired-hammer-handoff' ? 360000 : 60000),
            loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }), getOrchestrationMode: () => 'native' }),
            resolveAmaHammerDispatchModeImpl: () => 'inline',
            fetchLatestHeadReviewBodiesImpl: async () => [${JSON.stringify(body)}],
            resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
            fetchMergedProtectiveDependentsImpl: async () => [],
            requestEligibleHammerWakeImpl: () => ({ requested: false }),
            proveCommentOnlyFinalRoundHeadImpl: async () => true,
            runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
            maybeDispatchAmaCloserImpl: async args => {
              assert.equal(green, true, 'pending CI stays in the existing wait');
              assert.equal(args.dispatchContext.targetRemediationSha, '${pushed}');
              assert.equal(args.reviewState.headSha, '${reviewed}');
              globalThis.finalRoundClosureAdmissions = (globalThis.finalRoundClosureAdmissions || 0) + 1;
              return { dispatched: true, launchRequestId: 'synthetic-closer' };
            }, logger: { log() {}, warn() {} },
          });
          if (!green) assert.equal(result.nextAction.action, 'wait-for-CI', JSON.stringify(result));
          else assert.equal(result.dispatched, true, JSON.stringify(result));
          (globalThis.finalRoundDecisions ||= []).push(result);
          return { outcome: green ? 'ama-dispatched' : 'ama-pending', amaClosureResult: result };
        }`;
      const jobsSource = `export * from ${JSON.stringify(finalRoundUrl + '?actual')};
        import { findFinalRemediationPushJob as actual } from ${JSON.stringify(finalRoundUrl + '?actual')};
        export function findFinalRemediationPushJob(_root, args, log) { return actual(${JSON.stringify(tmp)}, args, log); }`;
      let loader = buildLoaderSource({ subjectHeads: { 101: pushed },
        followUpJobsSource: DEFAULT_FOLLOW_UP_JOBS_SOURCE.replace('return { completedRoundsForPR: 0, latestRiskClass:',
          'return globalThis.finalRoundLedger || { completedRoundsForPR: 0, latestRiskClass:'),
      })
        .replace('return globalThis.__holdReleaseSettled ||', 'return globalThis.finalRoundSettled || globalThis.__holdReleaseSettled ||')
        .replace("export function buildAdversarialGateSnapshot() { return { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; }",
          "export function buildAdversarialGateSnapshot() { return globalThis.finalRoundSettled ? { settledReview: globalThis.finalRoundSettled, reviewedHeadSha: globalThis.finalRoundSettled.reviewedHeadSha, labels: [] } : { settledReview: { verdict: '', remediationPending: false }, reviewedHeadSha: null, mergeableState: '', labels: [] }; }")
        .replaceAll('laceyenterprises/adversarial-review', 'example/project');
      loader = loader.replace('export async function resolve',
        `stubs.set(${JSON.stringify(postedUrl)}, 'fixture:final-round-posted');\nstubs.set(${JSON.stringify(finalRoundUrl)}, 'fixture:final-round-jobs');\nexport async function resolve`)
        .replace('export async function load(url, context, nextLoad) {',
          `export async function load(url, context, nextLoad) {\nif (url === 'fixture:final-round-posted') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(postedSource)} };\nif (url === 'fixture:final-round-jobs') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(jobsSource)} };`);
      const loaderPath = path.join(tmp, 'loader.mjs'), registerPath = path.join(tmp, 'register.mjs');
      const runnerPath = path.join(tmp, 'runner.mjs');
      writeFileSync(loaderPath, loader);
      writeFileSync(registerPath, buildRegisterSource(loaderPath));
      writeFileSync(runnerPath, buildRunnerSource({ freshHeads: { 101: pushed }, afterFirstPoll: `
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const completedAt = new Date(Date.now() - ('${initialStatus}' === 'expired-hammer-handoff' ? 360000 : 0)).toISOString();
        globalThis.finalRoundCompletedAt = completedAt;
        const dir = ${JSON.stringify(path.join(tmp, 'data', 'follow-up-jobs', 'completed'))};
        mkdirSync(dir, { recursive: true });
        const jobId = 'example__project-pr-101-final';
        writeFileSync(dir + '/' + jobId + '.json', JSON.stringify({
          jobId, repo: 'example/project', prNumber: 101, status: 'completed', finalRound: 'comment-only',
          revisionRef: '${reviewed}', reviewBody: ${JSON.stringify(body)}, completedAt,
          remediationPlan: { currentRound: 1, maxRounds: 2 },
          completion: { finalRemediationPush: true, workerPushedHeadSha: '${pushed}' },
          reReview: { requested: false, suppressed: '${initialStatus}' === 'expired-hammer-handoff' ? 'shared-next-action' : 'comment-only-final-round', nextAction: {
            action: '${initialStatus}' === 'expired-hammer-handoff' ? 'hammer' : 'wait-for-CI',
            actor: '${initialStatus}' === 'expired-hammer-handoff' ? 'hammer' : 'ci',
            reason: 'suppressed-final-push', head: '${pushed}',
            deadline: { at: new Date(Date.parse(completedAt) + ('${initialStatus}' === 'expired-hammer-handoff' ? 300000 : 1800000)).toISOString(), anchoredAt: completedAt } } },
        }));
        mkdirSync(${JSON.stringify(path.join(tmp, 'data', 'follow-up-jobs', 'workspaces'))} + '/' + jobId, { recursive: true });
        const row = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number=101').get();
        db.prepare(\`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
          started_at,ended_at,status,head_sha,gh_comment_id,body_md,body_captured_at)
          VALUES (?,101,50,'claude','rereview',?,?,'completed','${reviewed}','synthetic-review',?,?)\`)
          .run(row.repo, completedAt, completedAt, ${JSON.stringify(body)}, completedAt);
        db.prepare(\`UPDATE reviewed_prs SET review_status=?,reviewer_head_sha='${reviewed}',revision_ref='${pushed}',
          rereview_requested_at=?,rereview_reason='auto-refresh: posted review on stale head',
          reviewer_session_uuid=NULL,reviewer_lease_expires_at=NULL WHERE pr_number=101\`)
          .run('${initialStatus}' === 'sequence' ? 'posted' : ['parked-green', 'expired-hammer-handoff'].includes('${initialStatus}') ? 'pending' : '${initialStatus}',
            ['posted', 'sequence'].includes('${initialStatus}') ? null : completedAt);
        globalThis.finalRoundArmed = true;
        globalThis.finalRoundLedger = { completedRoundsForPR: 1, latestRiskClass: 'medium', latestMaxRounds: 2,
          commentOnlyFinalRoundRevisionRefs: ['${reviewed}'],
          commentOnlyFinalRoundPushedHeads: [{ reviewedHead: '${reviewed}', workerPushedHeadSha: '${pushed}', status: 'completed', completedAt }] };
        globalThis.finalRoundSettled = { verdict: 'comment-only', remediationPending: false,
          blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 1,
          reviewedHeadSha: '${reviewed}', commentOnlyFinalRoundPush: true };
        globalThis.__watcherClaimLoopReviewerSpawns = [];
        globalThis.finalRoundGreen = ['parked-green', 'expired-hammer-handoff'].includes('${initialStatus}');
        await pollOnce(octokit, pollOptions);
        assert.ok(globalThis.finalRoundDecisions?.length >= 1, 'pending CI must reach the closer in this pass');
        assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=101').get().review_status, 'posted');
        if (['parked-green', 'expired-hammer-handoff'].includes('${initialStatus}')) {
          // Startup refill may also observe closure before the posted phase.
          // This stub counts admissions; the real executor's lease/launch
          // reconciliation, not this stub, deduplicates launches.
          assert.ok([1, 2].includes(globalThis.finalRoundClosureAdmissions),
            'green parked head reaches closure in the posted phase and optionally startup refill');
        } else {
          // Replay the historical requestReviewRereview durable transition.
          // Current request admission already refuses some new final-round
          // requests; deployed older rows still require recovery.
          if ('${initialStatus}' === 'sequence') {
            db.prepare(\`UPDATE reviewed_prs SET review_status='pending', posted_at=NULL,
              rereview_requested_at=?, rereview_reason='auto-refresh: posted review on stale head'
              WHERE pr_number=101\`).run(completedAt);
          } else {
            // Repeated pending observations must not back off closure when CI
            // can settle without changing the review row.
            for (let tick = 0; tick < 8; tick += 1) await pollOnce(octokit, pollOptions);
          }
          globalThis.finalRoundGreen = true;
          await pollOnce(octokit, pollOptions);
          assert.ok([1, 2].includes(globalThis.finalRoundClosureAdmissions), 'first green pass reaches each due closure observation');
        }
        assert.equal(globalThis.__watcherClaimLoopReviewerSpawns.length, 0);
      ` }).replaceAll('laceyenterprises/adversarial-review', 'example/project')
        .replace("name: 'adversarial-review', archived: false", "name: 'project', full_name: 'example/project', archived: false"));
      const env = fixtureEnv(installGhFixture(tmp));
      const ghPath = path.join(tmp, 'gh');
      writeFileSync(ghPath, readFileSync(ghPath, 'utf8').replaceAll('laceyenterprises/adversarial-review', 'example/project'));
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
        { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30000 });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, output);
      assert.ok((output.match(/owning lane=closer.*(?:completed-comment-only-final-round|expired-remediation-handoff)/g) || []).length
        >= (['parked-green', 'expired-hammer-handoff'].includes(initialStatus) ? 1 : initialStatus === 'sequence' ? 2 : 10), 'every pass names the closer owner, including startup refill');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}
