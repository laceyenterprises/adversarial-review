import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { completeArgusJob, returnArgusJobToPending, writeArgusJob } from './argus-security-queue.mjs';
import { ARGUS_VERDICTS } from './argus-security-verdict.mjs';
import { ARGUS_REVIEW_RESULT_SOURCE } from './argus-security-review.mjs';
import { isUnroutableBotAuthor } from './bot-author.mjs';
import { DAEMON_MERGE_DISPOSITION } from './ama/daemon-merge.mjs';
import { ARGUS_CI_WAIT_DEFERRAL_BUDGET, CI_WAIT_RETRY_MS } from './argus-dependency-evidence.mjs';
import { classifyCheckRollup, summarizeChecksConclusion } from './checks-summary.mjs';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { execGhWithRetry } from './gh-cli.mjs';

export const DEPENDENCY_BOT_AUTOADJUDICATION_EVENT = 'argus.dependency_bot_autoadjudication';

const DEPENDABOT_TITLE_PATTERN =
  /^chore\(deps(?<dev>-dev)?\):\s+bump\s+(?<name>.+?)\s+from\s+(?<from>[^\s]+)\s+to\s+(?<to>[^\s]+)(?:\s+.*)?$/iu;

const NATIVE_OR_SECURITY_SURFACE_PACKAGES = Object.freeze(new Set([
  'better-sqlite3',
  'sqlite3',
  'node-gyp',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'bcrypt',
  'sharp',
  'canvas',
  'keytar',
  'ffi-napi',
  'ref-napi',
  'node-pty',
  'esbuild',
  'rollup',
  'vite',
  'webpack',
]));

function normalizePackageName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseSemverCore(value) {
  const match = String(value || '').trim().match(/^v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:[-+].*)?$/u);
  if (!match) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

export function classifySemverBump(fromVersion, toVersion) {
  const from = parseSemverCore(fromVersion);
  const to = parseSemverCore(toVersion);
  if (!from || !to) return 'unknown';
  if (to.major !== from.major) return 'major';
  if (from.major === 0 && to.minor !== from.minor) return 'major';
  if (to.minor !== from.minor) return 'minor';
  if (to.patch !== from.patch) return 'patch';
  return 'same';
}

export function parseDependabotDependencyTitle(title) {
  const match = String(title || '').trim().match(DEPENDABOT_TITLE_PATTERN);
  if (!match) return null;
  const packageName = match.groups.name.trim();
  return {
    packageName,
    dependencyType: match.groups.dev ? 'dev' : 'runtime',
    fromVersion: match.groups.from,
    toVersion: match.groups.to,
    bumpKind: classifySemverBump(match.groups.from, match.groups.to),
  };
}

function hasManifestReason(job) {
  return (Array.isArray(job?.reasons) ? job.reasons : []).some((reason) => {
    if (String(reason?.trigger || '') !== 'manifest-change') return false;
    return (Array.isArray(reason.matches) ? reason.matches : []).length > 0
      || (Array.isArray(reason.ecosystems) ? reason.ecosystems : []).length > 0;
  });
}

export function adjudicateDependencyBotUpdate({
  title,
  authorRef,
  job,
  securitySurfacePackages = NATIVE_OR_SECURITY_SURFACE_PACKAGES,
} = {}) {
  const parsed = parseDependabotDependencyTitle(title);
  const packageKey = normalizePackageName(parsed?.packageName);
  const inputs = {
    authorRef: authorRef || null,
    title: title || '',
    packageName: parsed?.packageName || null,
    dependencyType: parsed?.dependencyType || null,
    fromVersion: parsed?.fromVersion || null,
    toVersion: parsed?.toVersion || null,
    bumpKind: parsed?.bumpKind || null,
    manifestReason: hasManifestReason(job),
    securitySurface: packageKey ? securitySurfacePackages.has(packageKey) : false,
  };

  const deny = (reason) => ({
    autoMergeEligible: false,
    reason,
    inputs,
  });

  if (!isUnroutableBotAuthor(authorRef)) return deny('not-bot-author');
  if (!parsed) return deny('unparsed-dependabot-title');
  if (!inputs.manifestReason) return deny('no-manifest-change');
  if (inputs.bumpKind === 'unknown') return deny('semver-unparsed');
  if (inputs.bumpKind === 'major') return deny('semver-major');
  if (inputs.securitySurface) return deny('security-surface-or-native-dependency');

  return {
    autoMergeEligible: true,
    reason: 'non-major-dependency-bump',
    inputs,
  };
}

function buildArgusResult({ decision, completedAt }) {
  return {
    schemaVersion: 1,
    kind: 'argus-security-result',
    verdict: decision.autoMergeEligible ? ARGUS_VERDICTS.APPROVE : ARGUS_VERDICTS.NEEDS_VERIFICATION,
    summary: decision.autoMergeEligible
      ? `Dependency bot auto-adjudication approved ${decision.inputs.packageName} ${decision.inputs.fromVersion} -> ${decision.inputs.toVersion}.`
      : `Dependency bot auto-adjudication withheld auto-merge: ${decision.reason}.`,
    findings: [],
    triggerReasons: ['bot-author', 'manifest-change'],
    autoadjudication: {
      schemaVersion: 1,
      decision: decision.autoMergeEligible ? 'approve-auto-merge' : 'route-for-review',
      reason: decision.reason,
      inputs: decision.inputs,
      completedAt,
    },
  };
}

function resolveGateChecks(daemonResult) {
  const liveGate = daemonResult?.liveGate || daemonResult?.gateSnapshot || null;
  if (Array.isArray(liveGate?.requiredChecks)) return liveGate.requiredChecks;
  if (Array.isArray(liveGate?.checks)) return liveGate.checks;
  if (Array.isArray(liveGate?.statusCheckRollup)) return liveGate.statusCheckRollup;
  return null;
}

// Only incomplete reads and contention can clear without changing the approved
// head or policy. A hard blocker beside a transient miss still withholds merge.
const RETRYABLE_ELIGIBILITY_REASONS = new Set([
  'pr-mergeability-unknown',
  'labels-unavailable',
  'primary-change-read-failed',
  'history-read-failed',
  'ci-cost-read-failed',
  'lease-not-held',
]);
const RETRYABLE_DEFERRED_REASONS = new Set([
  'live-head-refresh-failed',
  'live-head-unresolved',
  'gate-read-failed',
  'history-read-failed',
  'merge-title-missing',
  'lease-acquire-error',
  'lease-contended',
  'audit-init-failed',
]);
const RETRYABLE_DECLINE_REASONS = new Set([
  'protective-predecessor-open',
  'protective-predecessor-state-unreadable',
]);

function shouldKeepArgusJobPendingForMergeRetry(daemonResult, cfg) {
  const disposition = String(daemonResult?.disposition || '');
  const reason = String(daemonResult?.reason || '');
  const reasons = Array.isArray(daemonResult?.reasons) ? daemonResult.reasons : [];
  const gatesCanClear = reasons.every((gate) => {
    if (gate !== 'ci-not-green') return RETRYABLE_ELIGIBILITY_REASONS.has(gate);
    const ci = classifyCheckRollup(resolveGateChecks(daemonResult), {
      requiredContexts: resolveRequiredCheckContextsFromCfg(cfg),
    });
    return ci === null || ci === 'PENDING';
  });
  if (!gatesCanClear) return false;
  if (disposition === DAEMON_MERGE_DISPOSITION.DEFERRED) {
    return RETRYABLE_DEFERRED_REASONS.has(reason);
  }
  return disposition === DAEMON_MERGE_DISPOSITION.NOT_TAKEN
    && ((reason === 'not-eligible' && reasons.length > 0)
      || RETRYABLE_DECLINE_REASONS.has(reason));
}

// The reviewed dependency lane (including major bumps) retains its existing
// settlement semantics. DEPWAIT-01 only changes auto-adjudicated approvals.
function shouldKeepArgusDrainApprovalForMergeRetry(daemonResult) {
  if (daemonResult?.disposition === DAEMON_MERGE_DISPOSITION.DEFERRED) {
    return daemonResult.reason !== 'pr-head-moved';
  }
  if (daemonResult?.disposition !== DAEMON_MERGE_DISPOSITION.NOT_TAKEN
    || daemonResult.reason !== 'not-eligible'
    || !daemonResult.reasons?.includes('ci-not-green')) return false;
  const checks = resolveGateChecks(daemonResult);
  if (!Array.isArray(checks) || checks.length === 0) return true;
  return checks.some((check) => {
    if (!check || typeof check !== 'object') return false;
    const status = String(check.status || check.state || '').trim().toUpperCase();
    const conclusion = String(check.conclusion || '').trim().toUpperCase();
    if (check.__typename === 'StatusContext') {
      return status !== '' && !['SUCCESS', 'FAILURE', 'ERROR'].includes(status);
    }
    if (status) return status !== 'COMPLETED';
    return !conclusion;
  });
}

function writePendingAutoadjudicationAttempt({
  jobRecord,
  decision,
  daemonResult,
  attemptedAt,
  writeArgusJobImpl,
}) {
  const pendingJob = {
    ...jobRecord.job,
    status: 'pending',
    completedAt: null,
    result: null,
    lastAutoadjudicationAttempt: {
      schemaVersion: 1,
      decision: 'approve-auto-merge',
      reason: decision.reason,
      inputs: decision.inputs,
      attemptedAt,
      // One budget across all curable reasons prevents alternating misses from
      // extending the wait indefinitely. The initial decline buys one wait.
      deferrals: (jobRecord.job.lastAutoadjudicationAttempt?.deferrals || 0) + 1,
      notBefore: new Date(Date.parse(attemptedAt) + CI_WAIT_RETRY_MS).toISOString(),
      mergeDisposition: daemonResult?.disposition || null,
      mergeReason: daemonResult?.reason || null,
      mergeReasons: Array.isArray(daemonResult?.reasons) ? daemonResult.reasons : [],
    },
  };
  writeArgusJobImpl(jobRecord.jobPath, pendingJob);
  return { job: pendingJob, jobPath: jobRecord.jobPath };
}

// ARGUSDRAIN-01. A bump the adjudicator will not approve on its own is ROUTED:
// the job stays in `pending`, marked, and the Argus drain claims it for a real
// security review. Before the drain existed this completed the job as
// `needs_verification` ("route-for-review") and nothing ever reviewed it, so
// every semver-major bump parked forever (agent-os#7326).
function routeDependencyBotJobForReview({ jobRecord, decision, routedAt, writeArgusJobImpl }) {
  const routedJob = {
    ...jobRecord.job,
    routedForReview: {
      schemaVersion: 1,
      source: 'dependency-bot-autoadjudication',
      decision: 'route-for-review',
      reason: decision.reason,
      inputs: decision.inputs,
      routedAt,
    },
  };
  writeArgusJobImpl(jobRecord.jobPath, routedJob);
  return { job: routedJob, jobPath: jobRecord.jobPath };
}

/**
 * A job the Argus drain reviewed and approved, whose PR has not merged yet and
 * whose merge has not been settled. Only the drain's own approvals qualify: an
 * auto-adjudicated approval already went through its merge attempt.
 */
export function isArgusDrainApprovalAwaitingMerge(job) {
  return job?.status === 'completed'
    && job?.result?.source === ARGUS_REVIEW_RESULT_SOURCE
    && job?.result?.verdict === ARGUS_VERDICTS.APPROVE
    && job?.result?.merge?.settled !== true;
}

// ARGUSDRAIN-01 item 2: "approved lets the normal AMA path merge". A bot PR has
// no adversarial reviewer, so the daemon clean-merge attempt the adjudicator
// uses for patch/minor bumps is the merge path; the Argus review stands in for
// the settled review, with its advisory findings counted.
async function mergeArgusDrainApprovedDependencyBump({
  rootDir,
  jobRecord,
  candidate,
  gateSnapshot,
  mergeabilityForGate,
  cfg,
  currentPrHeadSha,
  runDaemonCleanMergeAttemptImpl,
  writeArgusJobImpl,
  logger,
  env,
  attemptedAt,
}) {
  const { job } = jobRecord;
  const headSha = String(job.headSha || currentPrHeadSha || '').trim();
  // Argus `medium`/`low` findings are advisory by the operator's authority
  // decision (ASR-06): posted, never blocking. The daemon's non-blocking count
  // means "findings remediation should address first", which a dependency bump
  // has no remediator for, so they are not counted there. They travel in the
  // merge accountability instead, so the audit still records them.
  const advisoryCount = (Array.isArray(job.result?.findings) ? job.result.findings : [])
    .filter((finding) => finding?.severity !== 'high').length;
  const daemonResult = await runDaemonCleanMergeAttemptImpl({
    rootDir,
    cfg,
    repoPath: job.repo,
    prNumber: job.prNumber,
    candidate: { ...candidate, headSha },
    gateSnapshot: {
      ...gateSnapshot,
      reviewedHeadSha: headSha,
      settledReview: { verdict: 'settled-success' },
    },
    mergeabilityForGate,
    reviewState: {
      headSha,
      riskClass: 'argus-security-reviewed',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    reviewStateRow: {
      reviewer: 'argus-security',
      reviewer_login: 'argus-security',
    },
    currentPrHeadSha: headSha,
    autonomousMergeAccountability: {
      label: 'argus-security-review',
      actor: 'argus-security',
      eventId: `${job.jobId}:argus-review`,
      observedAt: attemptedAt,
      headSha,
      reason: 'argus-security-approved',
      inputs: {
        reviewer: job.result?.reviewer?.model || null,
        verification: job.result?.verification || null,
        advisoryFindingCount: advisoryCount,
        commentUrl: job.result?.posted?.url || null,
      },
    },
    logger,
    env,
  });
  const merged = daemonResult?.disposition === DAEMON_MERGE_DISPOSITION.MERGED;
  const retryable = !merged && shouldKeepArgusDrainApprovalForMergeRetry(daemonResult);
  const updated = {
    ...job,
    result: {
      ...job.result,
      merge: {
        attemptedAt,
        disposition: daemonResult?.disposition || null,
        reason: daemonResult?.reason || null,
        reasons: Array.isArray(daemonResult?.reasons) ? daemonResult.reasons : [],
        merged,
        // Settled means stop trying: merged, or withheld for a reason a retry
        // will not change. The verdict stays `approved` either way; a withheld
        // merge is a merge problem, not a security one.
        settled: merged || !retryable,
      },
    },
  };
  writeArgusJobImpl(jobRecord.jobPath, updated);
  return {
    attempted: true,
    reason: merged ? 'merged' : `argus-approved-merge-${retryable ? 'retry' : 'withheld'}-${daemonResult?.reason || 'unknown'}`,
    decision: { autoMergeEligible: true, reason: 'argus-security-approved', inputs: null },
    completed: { job: updated, jobPath: jobRecord.jobPath },
    merge: daemonResult || null,
  };
}

function isCompletedMergeWithheldJob(jobRecord, currentPrHeadSha) {
  const job = jobRecord?.job;
  return jobRecord?.bucket === 'completed'
    && Boolean(jobRecord.jobPath)
    && Boolean(currentPrHeadSha)
    && job?.status === 'completed'
    && job.headSha === currentPrHeadSha
    && !job.mergeWithheldRecovery
    && job.result?.verdict === ARGUS_VERDICTS.NEEDS_VERIFICATION
    && job.result?.autoadjudication?.decision === 'route-for-review'
    && String(job.result.autoadjudication.reason || '').startsWith('merge-withheld-');
}

// Read directly rather than using a subject snapshot or adapter cache: a
// terminal PR, a moved head, or stale CI must never revive a completed job.
async function fetchDependencyMergeRecoveryEvidence(repo, prNumber, { env, logger }) {
  const { stdout } = await execGhWithRetry({
    args: ['pr', 'view', String(prNumber), '--repo', repo, '--json',
      'state,headRefOid,mergeable,mergeStateStatus,isDraft,statusCheckRollup'],
    env,
    timeoutMs: loadAwareTimeoutMs(30_000),
    log: logger,
  });
  return JSON.parse(String(stdout || '{}'));
}

export async function maybeAutoAdjudicateDependencyBotArgusJob({
  rootDir,
  jobRecord,
  title,
  authorRef,
  candidate,
  gateSnapshot,
  mergeabilityForGate,
  cfg,
  currentPrHeadSha,
  runDaemonCleanMergeAttemptImpl,
  completeArgusJobImpl = completeArgusJob,
  returnArgusJobToPendingImpl = returnArgusJobToPending,
  fetchMergeRecoveryEvidenceImpl = fetchDependencyMergeRecoveryEvidence,
  writeArgusJobImpl = writeArgusJob,
  logger = console,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (
    jobRecord?.job
    && jobRecord.jobPath
    && jobRecord.bucket === 'completed'
    && isArgusDrainApprovalAwaitingMerge(jobRecord.job)
  ) {
    if (!isUnroutableBotAuthor(authorRef)) return { attempted: false, reason: 'not-bot-author' };
    return mergeArgusDrainApprovedDependencyBump({
      rootDir,
      jobRecord,
      candidate,
      gateSnapshot,
      mergeabilityForGate,
      cfg,
      currentPrHeadSha,
      runDaemonCleanMergeAttemptImpl,
      writeArgusJobImpl,
      logger,
      env,
      attemptedAt: now(),
    });
  }
  if (isCompletedMergeWithheldJob(jobRecord, currentPrHeadSha)
    && isUnroutableBotAuthor(authorRef)) {
    let live;
    try {
      live = await fetchMergeRecoveryEvidenceImpl(jobRecord.job.repo, jobRecord.job.prNumber, { env, logger });
    } catch {
      return { attempted: false, reason: 'merge-recovery-evidence-unavailable' };
    }
    if (live?.headRefOid !== jobRecord.job.headSha
      || String(live?.state || '').toUpperCase() !== 'OPEN'
      || String(live?.mergeable || '').toUpperCase() !== 'MERGEABLE'
      || String(live?.mergeStateStatus || '').toUpperCase() === 'DIRTY'
      || live?.isDraft === true
      || summarizeChecksConclusion(live?.statusCheckRollup, { cfg, env }) !== 'SUCCESS') {
      return { attempted: false, reason: 'merge-recovery-not-ready' };
    }
    const reopenedAt = now();
    const recovered = returnArgusJobToPendingImpl({
      rootDir,
      jobPath: jobRecord.jobPath,
      job: jobRecord.job,
      patch: {
        // Persist before the move/merge attempt, including across restarts. A
        // second withheld result on this job can never start another recovery.
        mergeWithheldRecovery: {
          headSha: jobRecord.job.headSha,
          reopenedAt,
          inputs: jobRecord.job.result.autoadjudication.inputs,
        },
        // Keep the drain from claiming an old job while the watcher awaits the
        // daemon. Its original bot grace may have expired hours ago.
        lastAutoadjudicationAttempt: {
          schemaVersion: 1,
          decision: 'approve-auto-merge',
          reason: 'non-major-dependency-bump',
          inputs: jobRecord.job.result.autoadjudication.inputs,
          attemptedAt: reopenedAt,
          deferrals: 0,
        },
      },
    });
    jobRecord = { ...recovered, bucket: 'pending' };
  }
  if (!jobRecord?.job || !jobRecord.jobPath || jobRecord.bucket !== 'pending') {
    return { attempted: false, reason: 'no-pending-job' };
  }
  if (jobRecord.job.routedForReview) {
    // Already routed on an earlier tick; the Argus drain owns it now.
    return { attempted: false, reason: 'routed-for-review' };
  }

  const completedAt = now();
  const retryAt = Date.parse(jobRecord.job.lastAutoadjudicationAttempt?.notBefore || '');
  if (retryAt > Date.parse(completedAt)) {
    return { attempted: false, reason: 'merge-retry-wait' };
  }
  // A recovered merge retries the approval already issued for this head. A
  // title edit after completion does not turn that approval into a new review.
  const recovery = jobRecord.job.mergeWithheldRecovery;
  const decision = recovery?.headSha === jobRecord.job.headSha && isUnroutableBotAuthor(authorRef)
    ? { autoMergeEligible: true, reason: 'non-major-dependency-bump', inputs: recovery.inputs }
    : adjudicateDependencyBotUpdate({ title, authorRef, job: jobRecord.job });
  if (decision.reason === 'not-bot-author') {
    return {
      attempted: false,
      reason: 'not-bot-author',
      decision,
      completed: null,
      merge: null,
    };
  }

  const result = buildArgusResult({ decision, completedAt });

  logger?.log?.(JSON.stringify({
    schemaVersion: 1,
    event: DEPENDENCY_BOT_AUTOADJUDICATION_EVENT,
    repo: jobRecord.job.repo,
    pr: jobRecord.job.prNumber,
    headSha: jobRecord.job.headSha,
    decision: result.autoadjudication.decision,
    reason: decision.reason,
    inputs: decision.inputs,
  }));

  if (!decision.autoMergeEligible) {
    const routed = routeDependencyBotJobForReview({
      jobRecord,
      decision,
      routedAt: completedAt,
      writeArgusJobImpl,
    });

    return {
      attempted: true,
      reason: decision.reason,
      decision,
      completed: null,
      routed,
      merge: null,
    };
  }

  const headSha = String(jobRecord.job.headSha || currentPrHeadSha || '').trim();
  const daemonResult = await runDaemonCleanMergeAttemptImpl({
    rootDir,
    cfg,
    repoPath: jobRecord.job.repo,
    prNumber: jobRecord.job.prNumber,
    candidate: {
      ...candidate,
      headSha,
    },
    gateSnapshot: {
      ...gateSnapshot,
      reviewedHeadSha: headSha,
      settledReview: { verdict: 'settled-success' },
    },
    mergeabilityForGate,
    reviewState: {
      headSha,
      riskClass: 'dependency-bot-autoadjudicated',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    reviewStateRow: {
      reviewer: 'argus-security',
      reviewer_login: 'argus-security',
    },
    currentPrHeadSha: headSha,
    autonomousMergeAccountability: {
      label: 'dependency-bot-autoadjudication',
      actor: 'argus-security',
      eventId: `${jobRecord.job.jobId}:autoadjudication`,
      observedAt: completedAt,
      headSha,
      reason: decision.reason,
      inputs: decision.inputs,
    },
    logger,
    env,
  });

  if (daemonResult?.disposition !== DAEMON_MERGE_DISPOSITION.MERGED) {
    if (shouldKeepArgusJobPendingForMergeRetry(daemonResult, cfg)
      && (jobRecord.job.lastAutoadjudicationAttempt?.deferrals || 0) < ARGUS_CI_WAIT_DEFERRAL_BUDGET) {
      const pending = writePendingAutoadjudicationAttempt({
        jobRecord,
        decision,
        daemonResult,
        attemptedAt: completedAt,
        writeArgusJobImpl,
      });
      return {
        attempted: true,
        reason: `merge-retry-${daemonResult?.reason || 'pending'}`,
        decision,
        completed: null,
        pending,
        merge: daemonResult || null,
      };
    }

    const withheldDecision = {
      autoMergeEligible: false,
      reason: `merge-withheld-${daemonResult?.reason || 'unknown'}`,
      inputs: decision.inputs,
    };
    const withheldResult = buildArgusResult({ decision: withheldDecision, completedAt });
    withheldResult.autoadjudication.mergeDisposition = daemonResult?.disposition || null;
    withheldResult.autoadjudication.mergeReasons = Array.isArray(daemonResult?.reasons) ? daemonResult.reasons : [];
    const completed = completeArgusJobImpl({
      rootDir,
      jobPath: jobRecord.jobPath,
      completedAt,
      result: withheldResult,
      job: jobRecord.job,
    });

    return {
      attempted: true,
      reason: daemonResult?.reason || 'daemon-result',
      decision,
      completed,
      merge: daemonResult || null,
    };
  }

  const completed = completeArgusJobImpl({
    rootDir,
    jobPath: jobRecord.jobPath,
    completedAt,
    result,
    job: jobRecord.job,
  });

  return {
    attempted: true,
    reason: daemonResult?.reason || (daemonResult?.disposition === DAEMON_MERGE_DISPOSITION.MERGED ? 'merged' : 'daemon-result'),
    decision,
    completed,
    merge: daemonResult || null,
  };
}
