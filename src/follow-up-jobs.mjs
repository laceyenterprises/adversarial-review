import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { buildCodePrSubjectIdentity, buildDeliveryKey } from './identity-shapes.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readBestReviewerEvidenceTokenUsage,
} from './reviewer-pass-tokens.mjs';
import {
  PUBLIC_REPLY_MAX_CHARS,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  detectPublicReplyNoiseSignal,
  validateRemediationReply as validateKernelRemediationReply,
} from './kernel/remediation-reply.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

const MAX_CREATE_ATTEMPTS = 100;

const FOLLOW_UP_JOB_SCHEMA_VERSION = 2;
// Bounded remediation cap. This was uniformly 6 in PR #18's era,
// dropped to a uniform 3 after observing diminishing returns past
// round 3, then became risk-tiered. Post-2026-05-06 defaults are
// low=1, medium=2, high=3, critical=4. Pairs with a lenient final-round
// verdict threshold in the
// reviewer prompt (the final-round review only blocks on data
// corruption / secret leakage / security regression / broken
// external contract; everything else becomes a non-blocking note for
// human review). See prompts/code-pr/reviewer.last.md.
//
// Legacy jobs persisted with the old 3- or 6-round caps keep their
// persisted value via the per-job `remediationPlan.maxRounds` field;
// only NEW jobs derive their budget from this table.
const LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS = 6;
const DEFAULT_RISK_CLASS = 'medium';
// Convergence loop budgets, post-2026-05-06:
// Higher-risk PRs get more bot rounds before operator escalation,
// because that's where you most want the bot to converge before
// pulling the operator in. Default (medium) = 2: the initial
// remediation triggered by the first `Request changes`, plus one
// auto-queued follow-up if the rereview is still `Request changes`.
// Below that, low = 1 (simpler PRs aren't worth multiple rounds).
// Above that, high = 3 and critical = 4 (more iterations to absorb
// tougher reviewer feedback before halting).
//
// Each round is one remediation + one rereview. After the cap is
// consumed, `claimNextFollowUpJob` refuses to start another round —
// the PR halts and waits for operator review (or the
// `operator-approved` label). The watcher ALWAYS fires the rereview
// after each remediation regardless of how close to the cap we are;
// the cap lives entirely on the remediation-enqueue side.
//
// Operator override (`operator-approved` label) is the escape valve
// when the operator has decided the current PR head is mergeable now,
// even if review/remediation state is still pending or noisy.
const ROUND_BUDGET_BY_RISK_CLASS = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});
const DEFAULT_MAX_REMEDIATION_ROUNDS = ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS];
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_TRANSIENT_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MAX_TRANSIENT_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const MAX_QUOTA_HOLD_WINDOW_MS = 60 * 60 * 1000;
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
  stoppedArchived: ['data', 'follow-up-jobs', 'stopped-archived'],
  workspaces: ['data', 'follow-up-jobs', 'workspaces'],
});
const ARCHIVE_ANOMALY_DIR = ['data', 'archive-anomalies'];
const RETRIGGERABLE_STOP_CODES = Object.freeze([
  'max-rounds-reached',
  'round-budget-exhausted',
  'daemon-bounce-safety',
  // A settled review stops the automatic loop, but an explicit operator
  // retrigger label/CLI call means "address the remaining non-blocking flags."
  'review-settled',
  // The silent-no-progress guard auto-stops when a remediation round
  // completes without setting `reReview.requested = true`. The guard
  // prevents an automatic loop where remediation keeps "completing"
  // without forward signal. An explicit operator retrigger gesture means
  // "I see the no-progress signal — try anyway, I'll evaluate."
  // (PR laceyenterprises/agent-os#1086 hit this: `no-progress` was
  // missing from the allowlist and the watcher reported `job-active`
  // on every tick for hours without progress.)
  'no-progress',
  // The remediation was stopped because the head had moved out from
  // under a review created for an older SHA. By the time the operator
  // applies the retrigger label, the head IS the current head, so the
  // operator's gesture ("re-review the current head") races nothing.
  // The requeue path clears or refreshes `revisionRef` so the
  // consume-time `lifecycleStopDecision` check does not re-fire the
  // same stop on the next tick (round-1 review B1).
  'stale-review-head',
  // The stuck-claim sweep reclaims orphaned in-progress jobs into a
  // durable stop state. That reclamation is a transient recovery path,
  // so the normal operator retrigger surfaces must be able to requeue it.
  'stale-heartbeat',
  //
  // Intentionally NOT retriggerable — listed exhaustively per round-1
  // review N3 so a future contributor doesn't misread the asymmetry as
  // oversight:
  //   * `operator-stop` — explicit operator-applied stop; a new
  //     operator gesture should explicitly un-stop, not paper over.
  //   * `rereview-blocked` — encodes "blocked re-review state"; the
  //     reviewer who refused the reset would refuse it again until
  //     the in-flight review clears or is operator-bumped via a
  //     different lever. Separate decision if we ever want override.
  //   * `stale-drift` — operator-applied `no-merge-hold` / drift
  //     suppression label; semantically a sibling of `operator-stop`
  //     emitted from `lifecycleStopDecision` against the same
  //     "operator says do not remediate" intent.
  //   * `operator-merged-pr` / `operator-closed-pr` — terminal
  //     lifecycle states; the PR is gone, retriggering has no target.
]);
const RETRIGGERABLE_STOP_CODE_SET = new Set(RETRIGGERABLE_STOP_CODES);

// Canonical set of follow-up job `status` field values that indicate
// the job is still being worked. A second invocation that intends to
// re-trigger / re-bump / re-spawn should refuse against any of these.
//
// All four spellings have to be accepted because the codebase has drifted:
// - `'pending'` and `'in_progress'` are what the writers in this file
//   produce today (`createFollowUpJob`, `claimNextFollowUpJob`,
//   `markFollowUpJobSpawned`).
// - `'inProgress'` / `'in-progress'` appear in older callers and
//   directory-key forms (`FOLLOW_UP_JOB_DIRS.inProgress`, the
//   `'in-progress'` filesystem path).
//
// Older readers hand-rolled `status === 'pending' || status ===
// 'inProgress'` checks, which silently missed the underscore form the
// writers actually produce — see the 2026-05-31 watcher
// `isActiveFollowUpJob` bug for the same shape on a different reader.
// Use this set instead of open-coding the literals.
const ACTIVE_FOLLOW_UP_JOB_STATUSES = Object.freeze(
  new Set(['pending', 'inProgress', 'in-progress', 'in_progress'])
);

function isActiveFollowUpJobStatus(status) {
  return ACTIVE_FOLLOW_UP_JOB_STATUSES.has(status);
}

function getFollowUpJobDir(rootDir, key) {
  const parts = FOLLOW_UP_JOB_DIRS[key];
  if (!parts) {
    throw new Error(`Unknown follow-up job directory key: ${key}`);
  }

  return join(rootDir, ...parts);
}

function ensureFollowUpJobDirs(rootDir) {
  Object.keys(FOLLOW_UP_JOB_DIRS).forEach((key) => {
    mkdirSync(getFollowUpJobDir(rootDir, key), { recursive: true });
  });
}

function writeFollowUpJob(jobPath, job) {
  writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

function normalizeMaxRounds(maxRounds, { fallback = LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS } = {}) {
  return Number.isInteger(maxRounds) && maxRounds > 0
    ? maxRounds
    : fallback;
}

function normalizeRiskClass(riskClass, { fallback = null } = {}) {
  const normalized = String(riskClass ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUND_BUDGET_BY_RISK_CLASS, normalized)
    ? normalized
    : fallback;
}

function normalizeFollowUpJobRepoPrKey(repo, prNumber) {
  return `${String(repo || '').toLowerCase()}#${prNumber || ''}`;
}

function followUpJobRepoPrKey(job) {
  return normalizeFollowUpJobRepoPrKey(job?.repo, job?.prNumber);
}

function buildRoundBudgetResolution({
  riskClass = DEFAULT_RISK_CLASS,
  roundBudget = ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS],
  source = 'default-medium',
} = {}) {
  const normalizedRiskClass = normalizeRiskClass(riskClass, { fallback: DEFAULT_RISK_CLASS });
  const normalizedRoundBudget = normalizeMaxRounds(
    roundBudget,
    { fallback: ROUND_BUDGET_BY_RISK_CLASS[normalizedRiskClass] }
  );

  return {
    riskClass: normalizedRiskClass,
    roundBudget: normalizedRoundBudget,
    source,
  };
}

function getProjectsDir(rootDir) {
  const candidates = [
    join(rootDir, 'projects'),
    resolve(rootDir, '..', '..', 'projects'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function listLinearMappingPaths(dirPath) {
  if (!existsSync(dirPath)) {
    return [];
  }

  const results = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listLinearMappingPaths(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.linear-mapping.json')) {
      results.push(entryPath);
    }
  }
  return results.sort();
}

function readJsonFileIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function resolveRiskClassForLinearTicket(linearTicketId, { rootDir }) {
  const normalizedTicketId = String(linearTicketId ?? '').trim().toUpperCase();
  if (!normalizedTicketId) {
    return buildRoundBudgetResolution({ source: 'default-medium' });
  }

  const projectsDir = getProjectsDir(rootDir);
  for (const mappingPath of listLinearMappingPaths(projectsDir)) {
    try {
      const mapping = readJsonFileIfPresent(mappingPath);
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        continue;
      }

      const ticketEntry = Object.entries(mapping).find(([, ticketId]) => (
        String(ticketId ?? '').trim().toUpperCase() === normalizedTicketId
      ));
      if (!ticketEntry) {
        continue;
      }

      const [planTicketId] = ticketEntry;
      const planPath = mappingPath.replace(/\.linear-mapping\.json$/u, '');
      const plan = readJsonFileIfPresent(planPath);
      const planTicket = Array.isArray(plan?.tickets)
        ? plan.tickets.find((ticket) => String(ticket?.id ?? '').trim() === String(planTicketId).trim())
        : null;
      const riskClass = normalizeRiskClass(planTicket?.riskClass);

      if (!riskClass) {
        continue;
      }

      return buildRoundBudgetResolution({
        riskClass,
        roundBudget: ROUND_BUDGET_BY_RISK_CLASS[riskClass],
        source: `plan:${planPath}`,
      });
    } catch {}
  }

  return buildRoundBudgetResolution({ source: normalizedTicketId ? 'default-medium' : 'default-medium' });
}

function resolveRoundBudgetForJob(job, { rootDir, preferPersisted = true } = {}) {
  const persistedRiskClass = normalizeRiskClass(job?.riskClass);
  const persistedRoundBudget = Number(
    job?.remediationPlan?.maxRounds
      || job?.recommendedFollowUpAction?.maxRounds
  );

  // Persisted state is authoritative within a single follow-up job.
  // Fresh jobs normally re-derive the cap from the PR's current
  // riskClass; callers may intentionally pass an elevated prior cap
  // when preserving an in-flight legacy/operator budget is required.
  if (preferPersisted && Number.isInteger(persistedRoundBudget) && persistedRoundBudget > 0) {
    return buildRoundBudgetResolution({
      riskClass: persistedRiskClass || DEFAULT_RISK_CLASS,
      roundBudget: persistedRoundBudget,
      source: 'job-persisted-maxRounds',
    });
  }

  if (persistedRiskClass) {
    return buildRoundBudgetResolution({
      riskClass: persistedRiskClass,
      roundBudget: ROUND_BUDGET_BY_RISK_CLASS[persistedRiskClass],
      source: 'job-risk-class',
    });
  }

  return resolveRiskClassForLinearTicket(job?.linearTicketId, { rootDir });
}

function buildRemediationRoundPlan(maxRounds = DEFAULT_MAX_REMEDIATION_ROUNDS) {
  const normalizedMaxRounds = normalizeMaxRounds(maxRounds);

  return {
    mode: 'bounded-manual-rounds',
    maxRounds: normalizedMaxRounds,
    currentRound: 0,
    rounds: [],
    transientRetries: 0,
    retryHistory: [],
    retryAfter: null,
    stopReason: null,
    stop: null,
    nextAction: {
      type: 'consume-pending-round',
      round: 1,
      operatorVisibility: 'explicit',
    },
  };
}

function buildRecommendedFollowUpAction({ critical }) {
  return {
    type: 'address-adversarial-review',
    priority: critical ? 'high' : 'normal',
    summary: critical
      ? 'Start a follow-up coding session for this PR immediately and address the critical review findings first.'
      : 'Start a follow-up coding session for this PR and address the adversarial review findings.',
    executionModel: 'bounded-manual-rounds',
    maxRounds: DEFAULT_MAX_REMEDIATION_ROUNDS,
    futureArchitectureNote: 'Long term this should resume the original build session and preserve original build intent/context instead of spawning a fresh session from a file handoff.',
  };
}

function isSettledReviewJob(job) {
  const nextAction = job?.remediationPlan?.nextAction;
  // An explicit operator retrigger requeues a settled job back to pending
  // with a durable one-shot override. Allow exactly that next claim to
  // proceed even if the stored review body is still Comment-only.
  if (nextAction?.operatorOverride === true) return false;

  const verdict = normalizeEffectiveReviewVerdict(job?.reviewBody);
  return verdict === 'comment-only' || verdict === 'approved';
}

function handleClaimedStopFailure({ pendingPath, inProgressPath, stopCode, err }) {
  console.error(`[follow-up] failed to mark ${stopCode} job stopped`, err);
  if (!existsSync(inProgressPath) || existsSync(pendingPath)) return;

  try {
    renameSync(inProgressPath, pendingPath);
  } catch (restoreErr) {
    console.error(`[follow-up] failed to restore ${stopCode} job to pending`, restoreErr);
  }
}

function buildRemediationReplyArtifact(outputPath) {
  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    state: 'awaiting-worker-write',
    path: outputPath ?? null,
  };
}

function buildRemediationReply({
  job,
  outcome = 'completed',
  summary,
  validation = [],
  blockers = [],
  operationalBlockers = [],
  // Per-finding accountability fields. Both default to [] for backward
  // compatibility — older worker replies that predate this schema
  // simply omit them, and the renderer treats an empty array as "no
  // section to print." Workers that DO report per-finding state get
  // structured rendering in the public PR comment so the reader can
  // see, for each blocking issue from the adversarial review, whether
  // it was fixed (`addressed`), deliberately disagreed with
  // (`pushback`), or hard-exited on (`blockers`). All three carry a
  // per-entry `finding` so the next human can map each entry back to
  // the originating review item without guessing.
  addressed = [],
  pushback = [],
  reReviewRequested = false,
  reReviewReason = null,
}) {
  if (!job?.jobId) {
    throw new Error('Cannot build remediation reply without a job record');
  }

  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome,
    summary,
    validation,
    addressed,
    pushback,
    blockers,
    operationalBlockers,
    reReview: {
      requested: Boolean(reReviewRequested),
      reason: reReviewRequested
        ? (reReviewReason || 'Remediation applied and ready for another adversarial review pass.')
        : null,
    },
  };
}

function validateRemediationReply(reply, { expectedJob = null } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('Remediation reply must be a JSON object');
  }

  if (reply.kind !== REMEDIATION_REPLY_KIND) {
    throw new Error(`Remediation reply kind must be ${REMEDIATION_REPLY_KIND}`);
  }

  if (reply.schemaVersion !== REMEDIATION_REPLY_SCHEMA_VERSION) {
    throw new Error(`Unsupported remediation reply schemaVersion: ${reply.schemaVersion}`);
  }

  if (typeof reply.jobId !== 'string' || !reply.jobId.trim()) {
    throw new Error('Remediation reply jobId is required');
  }

  if (typeof reply.repo !== 'string' || !reply.repo.trim()) {
    throw new Error('Remediation reply repo is required');
  }

  if (!Number.isInteger(reply.prNumber) || reply.prNumber <= 0) {
    throw new Error('Remediation reply prNumber must be a positive integer');
  }

  const validated = validateKernelRemediationReply(reply, {
    expectedJob,
    publicCommentLabel: 'public P' + 'R comment',
  });

  if (expectedJob) {
    if (validated.repo !== expectedJob.repo) {
      throw new Error(`Remediation reply repo mismatch: expected ${expectedJob.repo}, got ${validated.repo}`);
    }

    if (validated.prNumber !== expectedJob.prNumber) {
      throw new Error(`Remediation reply prNumber mismatch: expected ${expectedJob.prNumber}, got ${validated.prNumber}`);
    }
  }

  return validated;
}

function readRemediationReplyArtifact(replyPath, { expectedJob = null } = {}) {
  try {
    return validateRemediationReply(
      JSON.parse(readFileSync(replyPath, 'utf8')),
      { expectedJob }
    );
  } catch (err) {
    const jobContext = expectedJob
      ? ` for job ${expectedJob.jobId} (${expectedJob.repo}#${expectedJob.prNumber})`
      : '';
    throw new Error(
      `Failed to read remediation reply artifact at ${replyPath}${jobContext}: ${err.message}`,
      { cause: err }
    );
  }
}

// Best-effort recovery of renderable fields from a remediation reply
// that did NOT pass strict validation. Returns null when the file
// cannot even be parsed as JSON. When the file IS valid JSON, returns
// only the fields the PR-comment renderer can use, with conservative
// type checks so we don't pass garbage into the comment body. Strict
// validation still gates the state machine — this helper is only for
// salvaging the worker's prose for the operator-facing failure comment
// so a single contract violation doesn't throw away the worker's
// point-by-point response.
function salvagePartialRemediationReply(replyPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(replyPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const partial = {};

  if (isStr(raw.summary)) {
    partial.summary = raw.summary;
  }

  if (Array.isArray(raw.validation)) {
    const v = raw.validation.filter(isStr);
    if (v.length) partial.validation = v;
  }

  if (Array.isArray(raw.addressed)) {
    const a = raw.addressed.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && isStr(e.finding) && isStr(e.action)
    );
    if (a.length) partial.addressed = a;
  }

  if (Array.isArray(raw.pushback)) {
    const p = raw.pushback.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && isStr(e.finding) && isStr(e.reasoning)
    );
    if (p.length) partial.pushback = p;
  }

  if (Array.isArray(raw.nonBlocking)) {
    const nb = raw.nonBlocking.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && isStr(e.finding) && isStr(e.action)
    );
    if (nb.length) partial.nonBlocking = nb;
  }

  if (Array.isArray(raw.blockers)) {
    const b = raw.blockers.filter((e) => {
      if (typeof e === 'string') return e.trim().length > 0;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
      return isStr(e.finding);
    });
    if (b.length) partial.blockers = b;
  }

  if (Array.isArray(raw.operationalBlockers)) {
    const o = raw.operationalBlockers.filter((e) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
      return isStr(e.finding);
    });
    if (o.length) partial.operationalBlockers = o;
  }

  return Object.keys(partial).length ? partial : null;
}

function buildLegacyRemediationPlan(job) {
  const maxRounds = normalizeMaxRounds(
    Number(job?.remediationPlan?.maxRounds)
      || Number(job?.recommendedFollowUpAction?.maxRounds),
    { fallback: LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS }
  );
  const basePlan = buildRemediationRoundPlan(maxRounds);
  const status = String(job?.status || 'pending');

  if (status === 'pending') {
    return basePlan;
  }

  const round = {
    round: 1,
    state: 'claimed',
  };

  if (job?.claimedAt) {
    round.claimedAt = job.claimedAt;
  }
  if (job?.claimedBy) {
    round.claimedBy = job.claimedBy;
  }
  if (job?.remediationWorker) {
    round.worker = job.remediationWorker;
  }
  if (job?.remediationWorker?.spawnedAt) {
    round.spawnedAt = job.remediationWorker.spawnedAt;
  }

  if (status === 'in_progress') {
    round.state = job?.remediationWorker?.state === 'spawned' ? 'spawned' : 'claimed';
    return {
      ...basePlan,
      currentRound: 1,
      rounds: [round],
      nextAction: {
        type: round.state === 'spawned' ? 'reconcile-worker' : 'worker-spawn',
        round: 1,
        operatorVisibility: 'explicit',
      },
    };
  }

  if (status === 'completed') {
    round.state = 'completed';
    round.finishedAt = job?.completedAt || null;
    round.completion = job?.completion || null;
  } else if (status === 'failed') {
    round.state = 'failed';
    round.finishedAt = job?.failedAt || null;
    round.failure = job?.failure || null;
  } else if (status === 'stopped') {
    round.state = 'stopped';
    round.finishedAt = job?.stoppedAt || null;
  }

  return {
    ...basePlan,
    currentRound: 1,
    rounds: [round],
    stopReason: status === 'stopped' ? job?.remediationPlan?.stopReason || job?.stopReason || null : null,
    stop: status === 'stopped'
      ? buildStopMetadata({
          code: job?.remediationPlan?.stop?.code || 'stopped',
          reason: job?.remediationPlan?.stopReason || job?.stopReason || null,
          stoppedAt: job?.stoppedAt || null,
          sourceStatus: job?.remediationPlan?.stop?.sourceStatus || status,
          currentRound: 1,
          maxRounds,
        })
      : null,
    nextAction: null,
  };
}

function normalizeRound(round, index, fallbackState = 'claimed') {
  const roundNumber = Number(round?.round ?? index + 1);
  return {
    ...round,
    round: roundNumber > 0 ? roundNumber : index + 1,
    state: round?.state || fallbackState,
  };
}

function normalizeRetryHistoryEntry(entry, index) {
  const roundNumber = Number(entry?.round ?? 0);
  return {
    ...entry,
    round: roundNumber > 0 ? roundNumber : index + 1,
    transientRetry: Number.isInteger(Number(entry?.transientRetry)) && Number(entry.transientRetry) > 0
      ? Number(entry.transientRetry)
      : index + 1,
  };
}

function buildStopMetadata({
  code,
  reason,
  stoppedAt,
  stoppedBy = null,
  sourceStatus = null,
  currentRound = null,
  maxRounds = null,
}) {
  return {
    code: typeof code === 'string' && code.trim() ? code : 'stopped',
    reason: typeof reason === 'string' && reason.trim() ? reason : 'Follow-up remediation stopped.',
    stoppedAt: stoppedAt || null,
    stoppedBy: stoppedBy || null,
    sourceStatus: sourceStatus || null,
    currentRound: Number.isInteger(currentRound) && currentRound > 0 ? currentRound : null,
    maxRounds: Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : null,
  };
}

function selectStopCode({ currentRound, maxRounds, requestedStopCode }) {
  if (currentRound >= maxRounds && requestedStopCode !== 'operator-stop') {
    return 'max-rounds-reached';
  }

  return requestedStopCode || 'stopped';
}

function normalizeRemediationPlan(job) {
  if (job?.schemaVersion === FOLLOW_UP_JOB_SCHEMA_VERSION && job?.remediationPlan) {
    const currentRound = Math.max(0, Number(job.remediationPlan.currentRound || 0));
    const maxRounds = normalizeMaxRounds(
      Number(job.remediationPlan.maxRounds || job?.recommendedFollowUpAction?.maxRounds),
      { fallback: LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS }
    );
    const persistedStopReason = typeof job.remediationPlan.stop?.reason === 'string'
      && job.remediationPlan.stop.reason.trim()
      ? job.remediationPlan.stop.reason
      : job.remediationPlan.stopReason;
    const rounds = Array.isArray(job.remediationPlan.rounds)
      ? job.remediationPlan.rounds.map((round, index) => normalizeRound(round, index))
      : [];
    const retryHistory = Array.isArray(job.remediationPlan.retryHistory)
      ? job.remediationPlan.retryHistory.map((entry, index) => normalizeRetryHistoryEntry(entry, index))
      : [];
    const transientRetries = Number.isInteger(Number(job.remediationPlan.transientRetries))
      && Number(job.remediationPlan.transientRetries) >= 0
      ? Number(job.remediationPlan.transientRetries)
      : retryHistory.length;
    const retryAfter = typeof job.remediationPlan.retryAfter === 'string' && job.remediationPlan.retryAfter.trim()
      ? job.remediationPlan.retryAfter
      : null;

    return {
      ...buildRemediationRoundPlan(
        maxRounds
      ),
      ...job.remediationPlan,
      mode: 'bounded-manual-rounds',
      maxRounds,
      currentRound,
      rounds,
      transientRetries,
      retryHistory,
      retryAfter,
      stop: job.remediationPlan.stop && typeof job.remediationPlan.stop === 'object'
        ? buildStopMetadata({
            code: job.remediationPlan.stop.code,
            reason: persistedStopReason,
            stoppedAt: job.remediationPlan.stop.stoppedAt,
            stoppedBy: job.remediationPlan.stop.stoppedBy,
            sourceStatus: job.remediationPlan.stop.sourceStatus,
            currentRound,
            maxRounds,
          })
        : null,
    };
  }

  return buildLegacyRemediationPlan(job);
}

function normalizeFollowUpJob(job) {
  if (!job || typeof job !== 'object') {
    return job;
  }

  const remediationPlan = normalizeRemediationPlan(job);
  const persistedRemediationReply = job?.remediationReply;
  const normalizedRemediationReplyPath = typeof persistedRemediationReply?.path === 'string'
    && persistedRemediationReply.path.trim()
    ? persistedRemediationReply.path
    : null;
  const normalizedRiskClass = normalizeRiskClass(job?.riskClass);
  const subjectIdentity = buildCodePrSubjectIdentity({
    repo: job?.repo,
    prNumber: job?.prNumber,
    revisionRef: job?.revisionRef || null,
  });
  return {
    ...job,
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    domainId: job?.domainId || subjectIdentity.domainId,
    subjectExternalId: job?.subjectExternalId || subjectIdentity.subjectExternalId,
    revisionRef: job?.revisionRef || subjectIdentity.revisionRef,
    riskClass: normalizedRiskClass,
    recommendedFollowUpAction: {
      ...buildRecommendedFollowUpAction({ critical: job.critical }),
      ...(job.recommendedFollowUpAction || {}),
      executionModel: 'bounded-manual-rounds',
      maxRounds: remediationPlan.maxRounds,
    },
    remediationReply: {
      ...buildRemediationReplyArtifact(null),
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      state: typeof persistedRemediationReply?.state === 'string' && persistedRemediationReply.state.trim()
        ? persistedRemediationReply.state
        : 'awaiting-worker-write',
      path: normalizedRemediationReplyPath,
    },
    remediationPlan,
  };
}

function readFollowUpJob(jobPath) {
  return normalizeFollowUpJob(JSON.parse(readFileSync(jobPath, 'utf8')));
}

function listPendingFollowUpJobPaths(rootDir) {
  const pendingDir = getFollowUpJobDir(rootDir, 'pending');
  if (!existsSync(pendingDir)) return [];

  return readdirSync(pendingDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(pendingDir, name));
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeTransientRetryBackoffMs(transientRetryCount) {
  const exponent = Math.max(0, Number(transientRetryCount || 1) - 1);
  return Math.min(
    DEFAULT_TRANSIENT_RETRY_BACKOFF_MS * (2 ** exponent),
    MAX_TRANSIENT_RETRY_BACKOFF_MS
  );
}

function listInProgressFollowUpJobPaths(rootDir) {
  const inProgressDir = getFollowUpJobDir(rootDir, 'inProgress');
  if (!existsSync(inProgressDir)) return [];

  return readdirSync(inProgressDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(inProgressDir, name));
}

function listPendingFollowUpJobs(rootDir) {
  return listPendingFollowUpJobPaths(rootDir).map((jobPath) => ({
    job: readFollowUpJob(jobPath),
    jobPath,
  }));
}

function listInProgressFollowUpJobs(rootDir) {
  return listInProgressFollowUpJobPaths(rootDir).map((jobPath) => ({
    job: readFollowUpJob(jobPath),
    jobPath,
  }));
}

function listFollowUpJobsInDir(rootDir, key) {
  const dir = getFollowUpJobDir(rootDir, key);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      job: readFollowUpJob(join(dir, name)),
      jobPath: join(dir, name),
    }));
}

function relatedJobEntryNames(entryNames, jobFileName) {
  return entryNames
    .filter((entry) => entry === jobFileName || entry.startsWith(`${jobFileName}.`))
    .sort();
}

function archiveAnomalyPath(rootDir, nowMs, sourceName, attempt = 0) {
  const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
  const safeName = sourceName.replace(/[^A-Za-z0-9_.-]/gu, '_');
  return join(
    rootDir,
    ...ARCHIVE_ANOMALY_DIR,
    `${new Date(nowMs).toISOString().replace(/[:.]/gu, '-')}-${safeName}${suffix}.json`
  );
}

function writeArchiveAnomaly(rootDir, nowMs, anomaly) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targetPath = archiveAnomalyPath(rootDir, nowMs, anomaly.name, attempt);
    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      writeFileAtomic(targetPath, `${JSON.stringify(anomaly, null, 2)}\n`, {
        mode: 0o640,
        overwrite: false,
      });
      return targetPath;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`could not allocate archive anomaly path for ${anomaly.name}`);
}

function sameFileBytes(leftPath, rightPath) {
  return readFileSync(leftPath).equals(readFileSync(rightPath));
}

function stoppedAgeMs(job, st, nowMs) {
  const stoppedAtMs = typeof job?.stoppedAt === 'string' ? Date.parse(job.stoppedAt) : NaN;
  return Number.isFinite(stoppedAtMs) ? nowMs - stoppedAtMs : nowMs - st.mtimeMs;
}

function archiveStoppedFollowUpJobs({
  rootDir,
  nowMs = Date.now(),
  ttlMs = 24 * 60 * 60 * 1000,
} = {}) {
  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  if (!existsSync(stoppedDir)) {
    return { scanned: 0, archived: 0, skipped: 0, collisions: 0, archivedPaths: [], anomalyPaths: [] };
  }

  let scanned = 0;
  let archived = 0;
  let skipped = 0;
  let collisions = 0;
  const archivedPaths = [];
  const anomalyPaths = [];

  const stoppedEntries = readdirSync(stoppedDir).sort();
  for (const name of stoppedEntries.filter((entry) => entry.endsWith('.json'))) {
    scanned += 1;
    const sourcePath = join(stoppedDir, name);
    if (!existsSync(sourcePath)) {
      skipped += 1;
      continue;
    }
    const st = statSync(sourcePath);

    let job = null;
    try {
      job = readFollowUpJob(sourcePath);
    } catch {}
    if (stoppedAgeMs(job, st, nowMs) < ttlMs) {
      skipped += 1;
      continue;
    }

    const archiveTimestamp = job?.stoppedAt || new Date(st.mtimeMs).toISOString();
    const archiveMonth = (
      typeof archiveTimestamp === 'string'
        && /^\d{4}-(0[1-9]|1[0-2])-\d{2}T/u.test(archiveTimestamp)
        && Number.isFinite(Date.parse(archiveTimestamp))
    )
      ? archiveTimestamp.slice(0, 7)
      : new Date(nowMs).toISOString().slice(0, 7);
    const archiveDir = join(getFollowUpJobDir(rootDir, 'stoppedArchived'), archiveMonth);
    mkdirSync(archiveDir, { recursive: true });

    const targetPath = join(archiveDir, name);
    const relatedNames = relatedJobEntryNames(stoppedEntries, name);
    if (existsSync(targetPath)) {
      const related = [];
      let hasDivergentCollision = false;
      for (const entryName of relatedNames) {
        const entrySourcePath = join(stoppedDir, entryName);
        const entryTargetPath = join(archiveDir, entryName);
        if (!existsSync(entrySourcePath)) continue;
        if (existsSync(entryTargetPath)) {
          const bytesMatch = sameFileBytes(entrySourcePath, entryTargetPath);
          hasDivergentCollision ||= !bytesMatch;
          related.push({
            sourcePath: entrySourcePath,
            targetPath: entryTargetPath,
            action: bytesMatch ? 'duplicate-target' : 'left-in-stopped',
            bytesMatch,
          });
        } else {
          related.push({
            sourcePath: entrySourcePath,
            targetPath: entryTargetPath,
            action: 'move-sidecar',
            bytesMatch: null,
          });
        }
      }

      if (!hasDivergentCollision) {
        for (const item of related) {
          if (item.action === 'duplicate-target') {
            rmSync(item.sourcePath, { force: true });
            item.action = 'removed-identical-source';
          } else if (item.action === 'move-sidecar') {
            mkdirSync(dirname(item.targetPath), { recursive: true });
            renameSync(item.sourcePath, item.targetPath);
            item.action = 'moved';
          }
        }
      }

      collisions += 1;
      anomalyPaths.push(writeArchiveAnomaly(rootDir, nowMs, {
        ts: new Date(nowMs).toISOString(),
        type: hasDivergentCollision ? 'stopped-archive-collision' : 'stopped-archive-duplicate',
        name,
        sourcePath,
        targetPath,
        archiveDir,
        action: hasDivergentCollision ? 'left-source-in-stopped' : 'deduplicated-identical-source',
        related,
      }));
      continue;
    }

    for (const entryName of relatedNames) {
      const sourceEntryPath = join(stoppedDir, entryName);
      if (!existsSync(sourceEntryPath)) {
        continue;
      }
      const targetEntryPath = join(archiveDir, entryName);
      if (existsSync(targetEntryPath)) {
        const bytesMatch = sameFileBytes(sourceEntryPath, targetEntryPath);
        if (bytesMatch) {
          rmSync(sourceEntryPath, { force: true });
          collisions += 1;
          anomalyPaths.push(writeArchiveAnomaly(rootDir, nowMs, {
            ts: new Date(nowMs).toISOString(),
            type: 'stopped-archive-duplicate',
            name: entryName,
            sourcePath: sourceEntryPath,
            targetPath: targetEntryPath,
            archiveDir,
            action: 'removed-identical-source',
            related: [{
              sourcePath: sourceEntryPath,
              targetPath: targetEntryPath,
              action: 'removed-identical-source',
              bytesMatch: true,
            }],
          }));
          continue;
        }
        collisions += 1;
        anomalyPaths.push(writeArchiveAnomaly(rootDir, nowMs, {
          ts: new Date(nowMs).toISOString(),
          type: 'stopped-archive-collision',
          name: entryName,
          sourcePath: sourceEntryPath,
          targetPath: targetEntryPath,
          archiveDir,
          action: 'left-source-in-stopped',
          related: [{
            sourcePath: sourceEntryPath,
            targetPath: targetEntryPath,
            action: 'left-in-stopped',
            bytesMatch: false,
          }],
        }));
      } else {
        renameSync(sourceEntryPath, targetEntryPath);
      }
    }
    if (relatedNames.every((entryName) => !existsSync(join(stoppedDir, entryName)))) {
      archived += 1;
      archivedPaths.push(targetPath);
    }
  }

  return { scanned, archived, skipped, collisions, archivedPaths, anomalyPaths };
}

function terminalFollowUpJobTimestamp(job) {
  let latestTimestamp = null;
  let latestTimestampMs = NaN;
  for (const timestamp of [job?.completedAt, job?.failedAt, job?.stoppedAt]) {
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (
      Number.isFinite(timestampMs)
      && (!Number.isFinite(latestTimestampMs) || timestampMs > latestTimestampMs)
    ) {
      latestTimestamp = timestamp;
      latestTimestampMs = timestampMs;
    }
  }
  return latestTimestamp;
}

function listArchivedStoppedJobPathsForId(rootDir, jobId) {
  const archivedRoot = getFollowUpJobDir(rootDir, 'stoppedArchived');
  if (!existsSync(archivedRoot)) return [];

  const relativeJobName = `${jobId}.json`;
  const jobPaths = [];
  for (const entry of readdirSync(archivedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidatePath = join(archivedRoot, entry.name, relativeJobName);
    if (existsSync(candidatePath)) {
      jobPaths.push(candidatePath);
    }
  }
  return jobPaths.sort();
}

function readTerminalWorkspaceJobForId(
  rootDir,
  jobId,
  {
    readFollowUpJobImpl = readFollowUpJob,
    logErrorImpl = console.error,
  } = {},
) {
  const candidatePaths = [];
  for (const key of ['completed', 'failed', 'stopped']) {
    const candidatePath = join(getFollowUpJobDir(rootDir, key), `${jobId}.json`);
    if (existsSync(candidatePath)) {
      candidatePaths.push(candidatePath);
    }
  }
  candidatePaths.push(...listArchivedStoppedJobPathsForId(rootDir, jobId));
  const seenCandidatePaths = new Set();
  const orderedCandidatePaths = [];
  for (const candidatePath of candidatePaths) {
    if (seenCandidatePaths.has(candidatePath)) continue;
    seenCandidatePaths.add(candidatePath);
    orderedCandidatePaths.push(candidatePath);
  }

  let unreadableJobRecords = 0;
  let terminalJob = null;
  for (const jobPath of orderedCandidatePaths) {
    let job;
    try {
      job = readFollowUpJobImpl(jobPath);
    } catch (err) {
      unreadableJobRecords += 1;
      logErrorImpl(
        `[follow-up-jobs] Skipping unreadable terminal workspace job record ${jobPath}: ` +
          `${err?.message || err}`,
      );
      continue;
    }
    if (!job?.jobId || !['completed', 'failed', 'stopped'].includes(job.status)) {
      continue;
    }

    const terminalTimestamp = terminalFollowUpJobTimestamp(job);
    const terminalTimestampMs = terminalTimestamp ? Date.parse(terminalTimestamp) : NaN;
    const existingTimestamp = terminalFollowUpJobTimestamp(terminalJob);
    const existingTimestampMs = existingTimestamp ? Date.parse(existingTimestamp) : NaN;
    if (
      !terminalJob ||
      (
        Number.isFinite(terminalTimestampMs) &&
        (!Number.isFinite(existingTimestampMs) || terminalTimestampMs > existingTimestampMs)
      )
    ) {
      terminalJob = job;
    }
  }

  return { terminalJob, unreadableJobRecords };
}

function runtimeUsername(env = process.env) {
  const envUser = String(env.LOGNAME || env.USER || '').trim();
  if (envUser) return envUser;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function workspaceReapStatSnapshot(workspacePath) {
  try {
    return { stat: statSync(workspacePath), error: null };
  } catch (err) {
    return { stat: null, error: err };
  }
}

function workspaceReapErrorDetails(workspacePath, err, env = process.env, workspaceSnapshot = null) {
  if (err?.code !== 'EACCES' && err?.code !== 'EPERM') {
    return `${err?.code ? `${err.code}: ` : ''}${err?.message || err}`;
  }

  const hqRoot = String(env.HQ_ROOT || '').trim() || '(unset)';
  const runtimeUser = runtimeUsername(env);
  let ownershipHint = '';
  const workspaceStat = workspaceSnapshot?.stat || null;
  if (workspaceStat) {
    if (typeof process.getuid === 'function') {
      const runtimeUid = process.getuid();
      if (Number.isInteger(workspaceStat.uid) && workspaceStat.uid !== runtimeUid) {
        ownershipHint = ` workspace uid=${workspaceStat.uid} differs from runtime uid=${runtimeUid}.`;
      }
    }
  }

  return (
    `${err.code}: ${err?.message || err}. ` +
    `While running as ${runtimeUser} with HQ_ROOT=${hqRoot}, the daemon could not reap ${workspacePath}.` +
    `${ownershipHint}`
  );
}

function workspaceReapPermissionAnomaly(
  rootDir,
  nowMs,
  workspacePath,
  err,
  env = process.env,
  workspaceSnapshot = null,
) {
  const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const hqRoot = String(env.HQ_ROOT || '').trim() || '(unset)';
  const runtimeUser = runtimeUsername(env);
  const anomaly = {
    ts: new Date(nowMs).toISOString(),
    type: 'terminal-workspace-reap-permission-denied',
    name: basename(workspacePath),
    workspacePath,
    hqRoot,
    runtime: {
      user: runtimeUser,
      uid: runtimeUid,
    },
    error: {
      code: err?.code || null,
      message: err?.message || String(err),
    },
    action: 'left-workspace-in-place',
  };

  if (workspaceSnapshot?.stat) {
    const workspaceStat = workspaceSnapshot.stat;
    anomaly.workspace = {
      uid: workspaceStat.uid,
      gid: workspaceStat.gid,
      mode: `0${(workspaceStat.mode & 0o777).toString(8)}`,
      runtimeUidMatchesOwner: (
        Number.isInteger(runtimeUid)
          && Number.isInteger(workspaceStat.uid)
          ? workspaceStat.uid === runtimeUid
          : null
      ),
    };
  } else if (workspaceSnapshot?.error) {
    const statErr = workspaceSnapshot.error;
    anomaly.workspace = {
      statError: {
        code: statErr?.code || null,
        message: statErr?.message || String(statErr),
      },
    };
  } else {
    anomaly.workspace = null;
  }

  return anomaly;
}

function reapTerminalFollowUpWorkspaces({
  rootDir,
  workspaceRootDir,
  nowMs = Date.now(),
  ttlMs = 24 * 60 * 60 * 1000,
  readFollowUpJobImpl = readFollowUpJob,
  rmSyncImpl = rmSync,
  logErrorImpl = console.error,
  env = process.env,
} = {}) {
  if (!workspaceRootDir || !existsSync(workspaceRootDir)) {
    return {
      scanned: 0,
      reaped: 0,
      skipped: 0,
      errors: 0,
      missingTerminalJob: 0,
      missingTerminalTimestamp: 0,
      recentTerminalJob: 0,
      unreadableJobRecords: 0,
      missingTerminalTimestampPaths: [],
      reapedPaths: [],
      anomalyPaths: [],
    };
  }

  let scanned = 0;
  let reaped = 0;
  let skipped = 0;
  let errors = 0;
  let missingTerminalJob = 0;
  let missingTerminalTimestamp = 0;
  let recentTerminalJob = 0;
  let unreadableJobRecords = 0;
  const missingTerminalTimestampPaths = [];
  const reapedPaths = [];
  const anomalyPaths = [];

  for (const entry of readdirSync(workspaceRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const workspacePath = join(workspaceRootDir, entry.name);
    try {
      const lookup = readTerminalWorkspaceJobForId(rootDir, entry.name, {
        readFollowUpJobImpl,
        logErrorImpl,
      });
      unreadableJobRecords += lookup.unreadableJobRecords;
      const { terminalJob } = lookup;
      if (!terminalJob) {
        skipped += 1;
        missingTerminalJob += 1;
        continue;
      }

      const terminalAt = terminalFollowUpJobTimestamp(terminalJob);
      const terminalAtMs = terminalAt ? Date.parse(terminalAt) : NaN;
      if (!Number.isFinite(terminalAtMs)) {
        skipped += 1;
        missingTerminalTimestamp += 1;
        if (missingTerminalTimestampPaths.length < 5) {
          missingTerminalTimestampPaths.push(workspacePath);
        }
        logErrorImpl(
          `[follow-up-jobs] Skipping terminal workspace ${workspacePath}: ` +
            `job ${terminalJob.jobId} is terminal but has no parseable completedAt/failedAt/stoppedAt timestamp`,
        );
        continue;
      }

      if ((nowMs - terminalAtMs) < ttlMs) {
        skipped += 1;
        recentTerminalJob += 1;
        continue;
      }

      rmSyncImpl(workspacePath, { recursive: true, force: true });
      reaped += 1;
      reapedPaths.push(workspacePath);
    } catch (err) {
      errors += 1;
      const permissionError = err?.code === 'EACCES' || err?.code === 'EPERM';
      const workspaceSnapshot = permissionError ? workspaceReapStatSnapshot(workspacePath) : null;
      logErrorImpl(
        `[follow-up-jobs] Failed to reap terminal workspace ${workspacePath}: ` +
          `${workspaceReapErrorDetails(workspacePath, err, env, workspaceSnapshot)}`,
      );
      if (permissionError) {
        try {
          anomalyPaths.push(writeArchiveAnomaly(
            rootDir,
            nowMs,
            workspaceReapPermissionAnomaly(rootDir, nowMs, workspacePath, err, env, workspaceSnapshot),
          ));
        } catch (anomalyErr) {
          logErrorImpl(
            `[follow-up-jobs] Failed to record terminal workspace reap anomaly ${workspacePath}: ` +
              `${anomalyErr?.message || anomalyErr}`,
          );
        }
      }
      continue;
    }
  }

  return {
    scanned,
    reaped,
    skipped,
    errors,
    missingTerminalJob,
    missingTerminalTimestamp,
    recentTerminalJob,
    unreadableJobRecords,
    missingTerminalTimestampPaths,
    reapedPaths,
    anomalyPaths,
  };
}

// Per-PR remediation ledger summary. The bounded loop's "round number"
// must be derived from the durable follow-up-jobs ledger (the only
// counter that actually advances when remediation work completes), not
// from `reviewed_prs.review_attempts` (which also increments on
// transient post / OAuth / reviewer-crash failures and would silently
// trip the lenient final-round threshold on infrastructure flakiness).
//
// `currentRound` on terminal jobs is *cumulative* for the PR: each new
// follow-up job is seeded from the PR's prior accumulated count
// (`buildFollowUpJob` -> `priorCompletedRounds`), and `claimNext...`
// then increments it by exactly one. The PR-wide consumed-round count
// is therefore `max(currentRound)` across terminal jobs, NOT the sum.
// Summing would double-count: 3 sequential remediation cycles produce
// terminal `currentRound` stamps of 1, 2, 3 — a sum of 6 would
// prematurely trip `max-rounds-reached` at round 2 on a 3-round cap,
// and at round 3 on the legacy 6-round cap.
//
// `latestMaxRounds` is read from the most-recent job (by terminal /
// claim / create timestamp). Jobs created with the legacy 6-round cap
// must continue to use 6 as their bound — this is what the reviewer's
// blocking issue #2 calls out: do not substitute the global default.
//
// Pending and in-progress jobs are intentionally excluded from
// `completedRoundsForPR`: pending hasn't consumed a round yet, and
// in-progress is mid-flight (the round it's running has not yet
// produced a terminal outcome the gate can react to).
//
// Resilience: a single corrupt or unreadable JSON file in any of the
// scanned directories must NOT silently zero out the directory's
// contribution to the ledger for unrelated PRs. Errors are caught
// per-file (logged + skipped), not per-directory.
function summarizePRRemediationLedger(rootDir, { domainId = 'code-pr', repo, prNumber }) {
  const targetDomainId = String(domainId || 'code-pr');
  const targetRepo = String(repo ?? '');
  const targetPr = Number(prNumber);
  if (!targetRepo || !Number.isFinite(targetPr)) {
    return { completedRoundsForPR: 0, latestMaxRounds: null, latestJobId: null };
  }

  let completedRoundsForPR = 0;
  let latestJob = null;
  let latestTimestamp = '';

  const allKeys = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
  const terminalKeys = new Set(['completed', 'failed', 'stopped']);

  for (const key of allKeys) {
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;

    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch (err) {
      console.error(
        `[follow-up-jobs] Failed to list ${key} directory while summarizing ` +
          `PR ledger for ${targetRepo}#${targetPr}: ${err?.message || err}`,
      );
      continue;
    }

    for (const name of names) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch (err) {
        // Per-file fail-soft: a single bad JSON record cannot remove
        // history for unrelated PRs in the same directory. Logging
        // the bad path keeps the failure visible to operators.
        console.error(
          `[follow-up-jobs] Skipping unreadable ledger record ${jobPath} ` +
            `while summarizing PR ledger for ${targetRepo}#${targetPr}: ` +
            `${err?.message || err}`,
        );
        continue;
      }
      if (!job) continue;
      if (String(job.domainId || 'code-pr') !== targetDomainId) continue;
      if (job.repo !== targetRepo) continue;
      if (Number(job.prNumber) !== targetPr) continue;

      if (terminalKeys.has(key)) {
        // `claimNextFollowUpJob` increments `currentRound` on claim,
        // before consume-time pre-spawn gates (lifecycle, round-budget,
        // OAuth pre-flight, workspace prep) run. When one of those gates
        // refuses, the terminal record carries the bumped count even
        // though no remediation worker ever started. The intended tag for
        // that path is `remediationWorker.state === 'never-spawned'`, but
        // we also treat missing/null/malformed `remediationWorker` payloads
        // as never-spawned here so a pre-spawn stop that forgot to stamp
        // the tag does not permanently burn PR-wide budget. The tradeoff is
        // that a corrupted real worker payload can overstate remaining
        // budget, so unexpected non-object shapes are logged for operators.
        const remediationWorker = job?.remediationWorker;
        const hasObjectWorkerShape = (
          remediationWorker != null
          && typeof remediationWorker === 'object'
          && !Array.isArray(remediationWorker)
        );
        if (remediationWorker != null && !hasObjectWorkerShape) {
          console.warn(
            `[follow-up-jobs] Treating malformed remediationWorker as never-spawned ` +
              `while summarizing PR ledger for ${targetRepo}#${targetPr} from ${jobPath}`,
          );
        }
        const neverSpawned = (
          remediationWorker == null
          || !hasObjectWorkerShape
          || remediationWorker.state === 'never-spawned'
        );
        if (!neverSpawned) {
          const cur = Number(job?.remediationPlan?.currentRound || 0);
          if (Number.isFinite(cur) && cur > completedRoundsForPR) {
            completedRoundsForPR = cur;
          }
        }
      }

      const ts = job?.completedAt
        || job?.failedAt
        || job?.stoppedAt
        || job?.claimedAt
        || job?.createdAt
        || '';
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestJob = job;
      }
    }
  }

  const latestMaxRoundsRaw = Number(latestJob?.remediationPlan?.maxRounds);
  const latestMaxRounds = Number.isFinite(latestMaxRoundsRaw) && latestMaxRoundsRaw > 0
    ? latestMaxRoundsRaw
    : null;

  // PMO-A1 / Track A: callers (watcher's pre-spawn rereview gate)
  // need to know the PR's last-recorded riskClass to decide whether
  // the round budget has been exhausted at the riskClass tier.
  // `latestRiskClass` falls back to DEFAULT_RISK_CLASS when no job
  // records a riskClass (legacy or spec-less PRs).
  const latestRiskClass = normalizeRiskClass(latestJob?.riskClass) || DEFAULT_RISK_CLASS;

  return {
    completedRoundsForPR,
    latestMaxRounds,
    latestRiskClass,
    latestJobId: latestJob?.jobId || null,
  };
}

function sanitizeRepo(repo) {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function sanitizeTimestamp(timestamp) {
  return String(timestamp ?? '').replace(/[:.]/g, '-');
}

function extractReviewSummary(reviewBody) {
  const text = String(reviewBody ?? '').trim();
  if (!text) return 'No review summary captured.';

  const match = text.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }

  return text.slice(0, 1000);
}

function getCurrentRound(job) {
  const roundNumber = Number(job?.remediationPlan?.currentRound || 0);
  if (roundNumber <= 0) return null;
  return job?.remediationPlan?.rounds?.find((round) => round.round === roundNumber) || null;
}

function updateCurrentRound(job, updater) {
  const currentRound = getCurrentRound(job);
  if (!currentRound) {
    throw new Error(`Follow-up job ${job?.jobId || '<unknown>'} has no active remediation round`);
  }

  return {
    ...job,
    remediationPlan: {
      ...job.remediationPlan,
      rounds: job.remediationPlan.rounds.map((round) => (
        round.round === currentRound.round ? updater(round) : round
      )),
    },
  };
}

function moveFollowUpJob(rootDir, jobPath, targetKey, nextJob) {
  ensureFollowUpJobDirs(rootDir);
  const targetPath = join(getFollowUpJobDir(rootDir, targetKey), basename(jobPath));
  writeFollowUpJob(jobPath, nextJob);
  if (targetPath !== jobPath) {
    renameSync(jobPath, targetPath);
  }
  return { job: nextJob, jobPath: targetPath };
}

function moveTerminalJobRecord({
  rootDir,
  jobPath,
  destinationKey,
  buildNextJob,
}) {
  ensureFollowUpJobDirs(rootDir);

  const terminalPath = join(getFollowUpJobDir(rootDir, destinationKey), basename(jobPath));

  let currentJob;
  try {
    currentJob = readFollowUpJob(jobPath);
  } catch (err) {
    if (err?.code === 'ENOENT' && existsSync(terminalPath)) {
      return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
    }
    throw err;
  }

  if (existsSync(terminalPath)) {
    rmSync(jobPath, { force: true });
    return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
  }

  const nextJob = buildNextJob(currentJob);

  try {
    writeFileAtomic(terminalPath, `${JSON.stringify(nextJob, null, 2)}\n`, { overwrite: false });
  } catch (err) {
    if (err?.code === 'EEXIST' && existsSync(terminalPath)) {
      rmSync(jobPath, { force: true });
      return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
    }
    throw err;
  }

  try {
    rmSync(jobPath, { force: true });
  } catch (err) {
    rmSync(terminalPath, { force: true });
    throw err;
  }

  return { job: nextJob, jobPath: terminalPath, alreadyTerminal: false };
}

function buildFollowUpJob({
  repo,
  prNumber,
  baseBranch = 'main',
  revisionRef = null,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewBody,
  reviewPostedAt,
  verdictMode = 'enforce',
  critical,
  maxRemediationRounds = DEFAULT_MAX_REMEDIATION_ROUNDS,
  // Number of remediation rounds this PR has already completed across
  // earlier follow-up jobs. The auto-flow creates one new follow-up job
  // per adversarial review pass, so the bounded cap must be enforced
  // PR-wide, not per-job. Seeding `currentRound` with the PR's prior
  // count means `claimNextFollowUpJob`'s `currentRound >= maxRounds`
  // guard naturally stops the job after the PR exhausts its budget,
  // even though each individual job is freshly created.
  priorCompletedRounds = 0,
  // riskClass tier (low/medium/high/critical) carried from the linked
  // spec/plan. `createFollowUpJob` calls `resolveRoundBudgetForJob`
  // with this value to derive `remediationPlan.maxRounds` — the
  // pr-merge-orchestration spec's risk-tiered budget. Null for jobs
  // built without a spec linkage; falls back to DEFAULT_RISK_CLASS.
  riskClass = null,
}) {
  if (String(verdictMode || 'enforce') !== 'enforce') {
    throw new Error('advisory-only reviews must not create follow-up remediation jobs');
  }

  const createdAt = reviewPostedAt || new Date().toISOString();
  const jobId = `${sanitizeRepo(repo)}-pr-${prNumber}-${sanitizeTimestamp(createdAt)}`;
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef });
  const basePlan = buildRemediationRoundPlan(maxRemediationRounds);
  const seededRounds = Number.isFinite(Number(priorCompletedRounds)) && priorCompletedRounds > 0
    ? Math.floor(Number(priorCompletedRounds))
    : 0;
  const remediationPlan = {
    ...basePlan,
    currentRound: seededRounds,
    nextAction: {
      ...basePlan.nextAction,
      round: seededRounds + 1,
    },
  };

  return {
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    kind: 'adversarial-review-follow-up',
    status: 'pending',
    jobId,
    createdAt,
    trigger: {
      type: 'github-review-posted',
      postedAt: createdAt,
    },
    repo,
    prNumber,
    baseBranch: String(baseBranch || 'main'),
    domainId: subjectIdentity.domainId,
    subjectExternalId: subjectIdentity.subjectExternalId,
    revisionRef: subjectIdentity.revisionRef,
    linearTicketId,
    riskClass: normalizeRiskClass(riskClass),
    reviewerModel,
    // Durable record of the original PR title tag so remediation routing
    // does not have to reverse-map from reviewerModel. Reverse-mapping is
    // ambiguous because both [claude-code] and [clio-agent] PRs carry
    // reviewerModel='codex'. Persisting the tag at creation time keeps the
    // builder→remediator routing deterministic.
    builderTag: builderTag || null,
    critical: Boolean(critical),
    reviewSummary: extractReviewSummary(reviewBody),
    reviewBody,
    // Advisory-only reviews short-circuit before job creation; persisted jobs
    // are always enforcement carriers. Keep the field explicit for consumers
    // that read historical schemas, but do not imply advisory jobs exist.
    verdict_mode: 'enforce',
    recommendedFollowUpAction: {
      ...buildRecommendedFollowUpAction({ critical }),
      maxRounds: remediationPlan.maxRounds,
    },
    remediationReply: buildRemediationReplyArtifact(null),
    remediationPlan,
    sessionHandoff: {
      originalBuildSessionId: null,
      resumePreferred: true,
      resumeAvailable: false,
    },
  };
}

function createFollowUpJob({ rootDir, ...jobInput }) {
  const baseJob = buildFollowUpJob(jobInput);
  const { riskClass, roundBudget } = resolveRoundBudgetForJob(baseJob, {
    rootDir,
    preferPersisted: Number.isInteger(jobInput.maxRemediationRounds) && jobInput.maxRemediationRounds > 0,
  });
  // Preserve the `currentRound` seeded from `priorCompletedRounds` in
  // `buildFollowUpJob` — that's how the PR-wide bounded cap is
  // enforced across multiple follow-up jobs. Only `maxRounds` is
  // overridden by the riskClass-derived budget; the seeded round
  // count and the empty `rounds` history stay as `buildFollowUpJob`
  // wrote them.
  const resolvedJob = {
    ...baseJob,
    riskClass,
    recommendedFollowUpAction: {
      ...baseJob.recommendedFollowUpAction,
      maxRounds: roundBudget,
    },
    remediationPlan: {
      ...baseJob.remediationPlan,
      maxRounds: roundBudget,
    },
  };
  const queueDir = getFollowUpJobDir(rootDir, 'pending');

  mkdirSync(queueDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const job = attempt === 0
      ? resolvedJob
      : {
          ...resolvedJob,
          jobId: `${resolvedJob.jobId}-${attempt + 1}`,
        };
    const jobPath = join(queueDir, `${job.jobId}.json`);

    try {
      writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, { overwrite: false });
      return { job, jobPath };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Unable to create unique follow-up job file for ${resolvedJob.jobId} after ${MAX_CREATE_ATTEMPTS} attempts`);
}

function latestRetryHistoryEntry(job) {
  const history = Array.isArray(job?.remediationPlan?.retryHistory)
    ? job.remediationPlan.retryHistory
    : [];
  return history.length ? history[history.length - 1] : null;
}

function isQuotaExhaustedRetryHold(job) {
  const latestRetry = latestRetryHistoryEntry(job);
  if (latestRetry) {
    return latestRetry?.retryMetadata?.code === 'quota-exhausted';
  }
  return job?.remediationPlan?.lastRetryMetadata?.code === 'quota-exhausted';
}

function quotaHoldHarness(job) {
  const latestRetry = latestRetryHistoryEntry(job);
  return String(
    latestRetry?.retryMetadata?.harness
    || job?.remediationPlan?.lastRetryMetadata?.harness
    || ''
  ).trim().toLowerCase() || 'unknown';
}

function clampQuotaRetryAfter({ retryAfterMs, requeuedAtMs }) {
  if (!Number.isFinite(retryAfterMs)) return null;
  const ceilingBaseMs = Number.isFinite(requeuedAtMs) ? requeuedAtMs : Date.now();
  return Math.min(retryAfterMs, ceilingBaseMs + MAX_QUOTA_HOLD_WINDOW_MS);
}

function recordQuotaHoldRevalidationError({
  pendingPath,
  pendingJob,
  claimedAt,
  error,
}) {
  const updatedJob = {
    ...pendingJob,
    remediationPlan: {
      ...(pendingJob?.remediationPlan || buildRemediationRoundPlan()),
      quotaHoldRevalidatedErroredAt: claimedAt,
      quotaHoldRevalidationError: error?.message || String(error),
    },
  };
  writeFollowUpJob(pendingPath, updatedJob);
  return { cleared: false, job: updatedJob };
}

function maybeRevalidateQuotaHold({
  pendingPath,
  pendingJob,
  claimedAt,
  claimedAtMs,
  quotaHoldRevalidator,
} = {}) {
  if (!isQuotaExhaustedRetryHold(pendingJob) || typeof quotaHoldRevalidator !== 'function') {
    return { cleared: false, job: pendingJob };
  }
  let decision;
  try {
    decision = quotaHoldRevalidator({
      job: pendingJob,
      jobPath: pendingPath,
      harness: quotaHoldHarness(pendingJob),
      now: claimedAt,
      nowMs: claimedAtMs,
    });
  } catch (err) {
    return recordQuotaHoldRevalidationError({
      pendingPath,
      pendingJob,
      claimedAt,
      error: err,
    });
  }
  if (decision?.state === 'error') {
    return recordQuotaHoldRevalidationError({
      pendingPath,
      pendingJob,
      claimedAt,
      error: decision.error || 'quota revalidation failed',
    });
  }
  if (decision?.available !== true) {
    return { cleared: false, job: pendingJob };
  }
  const updatedJob = {
    ...pendingJob,
    remediationPlan: {
      ...(pendingJob?.remediationPlan || buildRemediationRoundPlan()),
      retryAfter: new Date(claimedAtMs).toISOString(),
      quotaHoldRevalidatedClearedAt: claimedAt,
      quotaHoldRevalidation: {
        harness: quotaHoldHarness(pendingJob),
        source: decision.source || 'live-quota',
        state: decision.state || 'available',
        checkedAt: decision.checkedAt || claimedAt,
      },
    },
  };
  writeFollowUpJob(pendingPath, updatedJob);
  return { cleared: true, job: updatedJob };
}

function claimNextFollowUpJob({
  rootDir,
  workerType = 'codex-remediation',
  claimedAt = new Date().toISOString(),
  launcherPid = process.pid,
  markStoppedImpl = markFollowUpJobStopped,
  returnStopped = false,
  excludedRepoPrKeys = new Set(),
  onExcludedRepoPrKey = null,
  delayedPendingPaths = null,
  onDelayedPendingJob = null,
  quotaHoldRevalidator = null,
} = {}) {
  ensureFollowUpJobDirs(rootDir);
  const normalizedExcludedRepoPrKeys = new Set(
    Array.from(excludedRepoPrKeys || [], (key) => String(key || '').toLowerCase())
  );

  for (const pendingPath of listPendingFollowUpJobPaths(rootDir)) {
    if (delayedPendingPaths?.has?.(pendingPath)) continue;

    let pendingJob = null;
    try {
      pendingJob = readFollowUpJob(pendingPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const retryAfterMs = parseIsoTimestamp(pendingJob?.remediationPlan?.retryAfter);
    const claimedAtMs = parseIsoTimestamp(claimedAt);
    if (retryAfterMs !== null && claimedAtMs !== null && retryAfterMs > claimedAtMs) {
      const revalidation = maybeRevalidateQuotaHold({
        pendingPath,
        pendingJob,
        claimedAt,
        claimedAtMs,
        quotaHoldRevalidator,
      });
      if (revalidation.cleared) {
        pendingJob = revalidation.job;
      } else {
        delayedPendingPaths?.add?.(pendingPath);
        onDelayedPendingJob?.(pendingPath, revalidation.job || pendingJob);
        continue;
      }
    }

    if (normalizedExcludedRepoPrKeys.size) {
      const repoPrKey = followUpJobRepoPrKey(pendingJob);
      if (normalizedExcludedRepoPrKeys.has(repoPrKey)) {
        onExcludedRepoPrKey?.(pendingPath, repoPrKey, pendingJob);
        continue;
      }
    }

    const inProgressPath = join(getFollowUpJobDir(rootDir, 'inProgress'), basename(pendingPath));

    try {
      renameSync(pendingPath, inProgressPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const job = pendingJob;

    if (isSettledReviewJob(job)) {
      let stopped = null;
      try {
        stopped = markStoppedImpl({
          rootDir,
          jobPath: inProgressPath,
          stoppedAt: claimedAt,
          stopCode: 'review-settled',
          sourceStatus: job.status,
          stopReason: 'Latest adversarial review verdict is non-blocking; no remediation worker required.',
          completion: {
            preview: 'Latest adversarial review verdict is non-blocking; no remediation worker required.',
          },
        });
      } catch (err) {
        handleClaimedStopFailure({
          pendingPath,
          inProgressPath,
          stopCode: 'review-settled',
          err,
        });
      }
      if (returnStopped && stopped) {
        return {
          job: stopped.job,
          jobPath: stopped.jobPath,
          stopped: true,
          reason: 'review-settled',
        };
      }
      continue;
    }

    const currentRound = Number(job?.remediationPlan?.currentRound || 0);
    const maxRounds = Number(job?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
    if (currentRound >= maxRounds) {
      let stopped = null;
      try {
        stopped = markStoppedImpl({
          rootDir,
          jobPath: inProgressPath,
          stoppedAt: claimedAt,
          stopCode: 'max-rounds-reached',
          sourceStatus: job.status,
          stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before claim.`,
        });
      } catch (err) {
        handleClaimedStopFailure({
          pendingPath,
          inProgressPath,
          stopCode: 'max-rounds-reached',
          err,
        });
      }
      if (returnStopped && stopped) {
        return {
          job: stopped.job,
          jobPath: stopped.jobPath,
          stopped: true,
          reason: 'max-rounds-reached',
        };
      }
      continue;
    }

    const nextRoundNumber = currentRound + 1;
    const claimedJob = {
      ...job,
      status: 'in_progress',
      claimedAt,
      claimedBy: {
        workerType,
        launcherPid,
      },
      remediationPlan: {
        ...(job.remediationPlan || buildRemediationRoundPlan()),
        currentRound: nextRoundNumber,
        retryAfter: null,
        stopReason: null,
        nextAction: {
          type: 'worker-spawn',
          round: nextRoundNumber,
          operatorVisibility: 'explicit',
        },
        rounds: [
          ...(job?.remediationPlan?.rounds || []),
          {
            round: nextRoundNumber,
            ...buildDeliveryKey({
              repo: job?.repo,
              prNumber: job?.prNumber,
              revisionRef: job?.revisionRef || null,
              round: nextRoundNumber,
              kind: 'remediation',
            }),
            state: 'claimed',
            claimedAt,
            claimedBy: {
              workerType,
              launcherPid,
            },
          },
        ],
      },
    };

    writeFollowUpJob(inProgressPath, claimedJob);
    return { job: claimedJob, jobPath: inProgressPath };
  }

  return null;
}

function markFollowUpJobSpawned({
  rootDir = null,
  jobPath,
  worker,
  spawnedAt = new Date().toISOString(),
}) {
  const effectiveSpawnedAt = worker?.spawnedAt || spawnedAt;
  const currentJob = readFollowUpJob(jobPath);
  let nextJob = {
    ...currentJob,
    status: 'in_progress',
    // Seed lastHeartbeatAt so the stale-claim sweep (LAC-957) sees a
    // fresh timestamp on the very next tick. Without seeding, jobs
    // spawned just before a tick boundary could read as "no heartbeat
    // yet" and fall back to mtime — usually fine, but a spawn that
    // immediately stalls before the daemon's first heartbeat pass
    // would only be reclaimable via mtime, which lags real activity.
    lastHeartbeatAt: effectiveSpawnedAt,
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt: effectiveSpawnedAt,
      ...worker,
    },
    remediationReply: buildRemediationReplyArtifact(worker?.replyPath ?? null),
    remediationPlan: {
      ...currentJob.remediationPlan,
      nextAction: {
        type: 'reconcile-worker',
        round: currentJob?.remediationPlan?.currentRound || 1,
        operatorVisibility: 'explicit',
      },
    },
  };

  nextJob = updateCurrentRound(nextJob, (round) => ({
    ...round,
    state: 'spawned',
    spawnedAt: effectiveSpawnedAt,
    worker: {
      model: 'codex',
      ...worker,
    },
  }));

  if (worker?.workspaceDir) {
    nextJob.workspaceDir = worker.workspaceDir;
  }

  writeFollowUpJob(jobPath, nextJob);
  recordRemediationPassStartedSafe({
    rootDir: rootDir || inferRootDirFromFollowUpJobPath(jobPath),
    job: nextJob,
    worker,
    spawnedAt,
  });
  return { job: nextJob, jobPath };
}

function requeueInProgressFollowUpJobForRetry({
  rootDir,
  jobPath,
  requeuedAt = new Date().toISOString(),
  retryReason = 'Transient remediation worker failure; retrying on a future tick.',
  remediationWorker = null,
  retryMetadata = null,
  // HRR quota graceful degradation: the direct-CLI remediation worker (the
  // default path when ADV_WITH_HQ_INTEGRATION is unset) spawns the codex/claude
  // CLI outside the dispatch daemon, so a hard provider usage cap bypasses HRR
  // exactly like the reviewer. When `allowDirectWorkerRetry` is set the hq-only
  // guard is relaxed so a quota-hit direct worker can be held-until-reset on a
  // future tick. `retryAfterOverride` (an ISO timestamp) pins the hold window to
  // the provider-reported reset instead of the default exponential backoff; the
  // consume gate (`claimNextFollowUpJob`) already skips pending jobs whose
  // `remediationPlan.retryAfter` is still in the future.
  allowDirectWorkerRetry = false,
  retryAfterOverride = null,
}) {
  const currentJob = readFollowUpJob(jobPath);
  if (currentJob?.status !== 'in_progress') {
    throw new Error(`Cannot retry follow-up job ${currentJob?.jobId || '<unknown>'} from status ${currentJob?.status || 'unknown'}`);
  }
  const effectiveWorker = remediationWorker || currentJob.remediationWorker || null;
  if (effectiveWorker?.dispatchMode !== 'hq' && !allowDirectWorkerRetry) {
    throw new Error(`Cannot retry follow-up job ${currentJob?.jobId || '<unknown>'}: transient retry requeue is only valid for HQ remediation workers`);
  }

  const currentRoundNumber = Number(currentJob?.remediationPlan?.currentRound || 0);
  const priorTransientRetries = Number(currentJob?.remediationPlan?.transientRetries || 0);
  const nextTransientRetries = priorTransientRetries + 1;
  const requeuedAtMs = parseIsoTimestamp(requeuedAt) ?? Date.now();
  const overrideRetryAfterMs = retryAfterOverride ? parseIsoTimestamp(retryAfterOverride) : null;
  const effectiveOverrideRetryAfterMs = retryMetadata?.code === 'quota-exhausted'
    ? clampQuotaRetryAfter({ retryAfterMs: overrideRetryAfterMs, requeuedAtMs })
    : overrideRetryAfterMs;
  const retryAfter = effectiveOverrideRetryAfterMs !== null
    ? new Date(effectiveOverrideRetryAfterMs).toISOString()
    : new Date(requeuedAtMs + computeTransientRetryBackoffMs(nextTransientRetries)).toISOString();
  const activeRound = currentRoundNumber > 0 ? getCurrentRound(currentJob) : null;
  const nextCurrentRound = Math.max(0, currentRoundNumber - 1);
  let nextJob = {
    ...currentJob,
    status: 'pending',
    pendingAt: requeuedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: remediationWorker || null,
    failure: null,
    completedAt: null,
    stoppedAt: null,
    completion: null,
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
      currentRound: nextCurrentRound,
      transientRetries: nextTransientRetries,
      retryAfter,
      stopReason: null,
      stop: null,
      nextAction: {
        type: 'consume-pending-round',
        // After requeue, currentRound is decremented so the next claim reuses
        // the same round number without creating duplicate live round entries.
        round: nextCurrentRound + 1,
        operatorVisibility: 'explicit',
        requestedAt: requeuedAt,
        requestedBy: 'system',
        reason: retryReason,
      },
      retryHistory: [
        ...(currentJob?.remediationPlan?.retryHistory || []),
        {
          round: currentRoundNumber,
          transientRetry: nextTransientRetries,
          requeuedAt,
          retryAfter,
          retryReason,
          retryMetadata,
          worker: effectiveWorker || activeRound?.worker || null,
        },
      ],
    },
  };

  if (currentRoundNumber > 0) {
    nextJob.remediationPlan = {
      ...nextJob.remediationPlan,
      rounds: (nextJob.remediationPlan?.rounds || []).filter((round) => round.round !== currentRoundNumber),
    };
  }

  return moveFollowUpJob(rootDir, jobPath, 'pending', nextJob);
}

function inferRootDirFromFollowUpJobPath(jobPath) {
  const marker = `${join('data', 'follow-up-jobs')}`;
  const normalized = resolve(jobPath);
  const idx = normalized.indexOf(`${marker}`);
  if (idx < 0) {
    throw new Error(`Cannot infer rootDir from follow-up job path outside ${marker}: ${jobPath}`);
  }
  return normalized.slice(0, idx - 1);
}

function remediationAttemptNumber(job) {
  const parsed = Number(job?.remediationPlan?.currentRound || job?.currentRound || 1);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

function workerLaunchRequestId(job, worker = {}) {
  return worker.launchRequestId || worker.launchRequestID || worker.lrq || job?.replyStorageKey || null;
}

function shouldRecordRemediationPass(job, worker = {}) {
  const prNumber = Number(job?.prNumber);
  if (!job?.repo || !Number.isInteger(prNumber)) return false;
  if (worker?.state === 'never-spawned') return false;
  return Boolean(worker?.workspaceDir || job?.workspaceDir || worker?.processId || worker?.workerRunId || worker?.runId);
}

function recordRemediationPassStartedSafe({ rootDir, job, worker = {}, spawnedAt }) {
  if (!rootDir || !shouldRecordRemediationPass(job, worker)) return;
  try {
    beginReviewerPass(rootDir, {
      repo: job.repo,
      prNumber: Number(job.prNumber),
      attemptNumber: remediationAttemptNumber(job),
      reviewerClass: worker.workerClass || worker.model || 'codex',
      reviewerModel: worker.model || worker.workerClass || 'codex',
      passKind: 'remediation',
      workerRunId: worker.workerRunId || worker.runId || null,
      workspacePath: worker.workspaceDir || job.workspaceDir || null,
      startedAt: spawnedAt,
      metadata: {
        jobId: job.jobId || null,
        launchRequestId: workerLaunchRequestId(job, worker),
      },
    });
  } catch (err) {
    console.warn(`[follow-up-jobs] reviewer_pass_start_failed job=${job?.jobId || '<unknown>'}: ${err?.message || err}`);
  }
}

function recordRemediationPassTerminalSafe({ rootDir, job, worker = {}, status, endedAt }) {
  if (!rootDir || !shouldRecordRemediationPass(job, worker)) return;
  try {
    const launchRequestId = workerLaunchRequestId(job, worker);
    const usage = readBestReviewerEvidenceTokenUsage({
      workerRunId: worker.workerRunId || worker.runId || null,
      launchRequestId,
      workspacePath: worker.workspaceDir || job.workspaceDir || null,
      startedAt: worker.spawnedAt || job.claimedAt || job.createdAt || null,
      endedAt,
      reviewerModel: worker.model || worker.workerClass || job.reviewerModel || 'codex',
      workerLogPath: worker.logPath || null,
      rootDir,
    });
    completeReviewerPass(rootDir, {
      repo: job.repo,
      prNumber: Number(job.prNumber),
      attemptNumber: remediationAttemptNumber(job),
      passKind: 'remediation',
      status,
      endedAt,
      workerRunId: usage?.workerRunId || worker.workerRunId || worker.runId || null,
      tokenUsage: usage,
      tokenSource: usage?.source || (usage ? 'session-ledger' : 'unknown'),
      metadata: {
        jobId: job.jobId || null,
        launchRequestId,
        transcriptPath: usage?.transcriptPath || null,
        transcriptSessionId: usage?.adapterSessionKey || null,
        workerLogPath: usage?.source === 'codex-worker-log' ? usage.transcriptPath : null,
      },
    });
  } catch (err) {
    console.warn(`[follow-up-jobs] reviewer_pass_finish_failed job=${job?.jobId || '<unknown>'}: ${err?.message || err}`);
  }
}

function markFollowUpJobFailed({
  rootDir,
  jobPath,
  error,
  failedAt = new Date().toISOString(),
  failureCode = 'worker-failure',
  remediationWorker,
  failure = {},
  // Optional pre-built commentDelivery shape. When the reconcile path
  // passes this, the terminal record lands in failed/ with the field
  // already present — closing the crash window between the atomic
  // terminal move and the post-move pre-stamp in
  // `recordInitialCommentDelivery`. Reviewer R5 blocking #1 fix.
  commentDelivery = null,
  jobUpdates = null,
}) {
  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'failed',
    buildNextJob: (currentJob) => {
      const failureDetails = {
        ...failure,
        code: failureCode,
        message: error?.message || failure.message || String(error),
      };

      let nextJob = {
        ...currentJob,
        status: 'failed',
        failedAt,
        remediationWorker: remediationWorker || currentJob.remediationWorker,
        failure: failureDetails,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          nextAction: null,
        },
      };

      // `currentRound` may be > 0 either because a worker has been
      // claimed/spawned for this job (a `rounds[]` entry exists) OR
      // because the job was created with a seeded count from the
      // PR-wide ledger (no `rounds[]` entry yet). Only update the
      // round entry when one actually exists; otherwise the top-level
      // failure metadata is the only place to record the outcome.
      if (currentJob?.remediationPlan?.currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'failed',
          finishedAt: failedAt,
          worker: remediationWorker || round.worker || currentJob.remediationWorker || null,
          failure: failureDetails,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      if (jobUpdates && typeof jobUpdates === 'object') {
        nextJob = {
          ...nextJob,
          ...jobUpdates,
        };
      }

      recordRemediationPassTerminalSafe({
        rootDir,
        job: nextJob,
        worker: nextJob.remediationWorker || {},
        status: 'failed',
        endedAt: failedAt,
      });
      return nextJob;
    },
  });
}

function markFollowUpJobCompleted({
  rootDir,
  jobPath,
  completion,
  completedAt,
  remediationWorker,
  remediationReply,
  reReview,
  finishedAt = new Date().toISOString(),
  completionPreview = null,
  commentDelivery = null,
}) {
  const normalizedCompletedAt = completedAt ?? finishedAt;
  const normalizedCompletion = completion || {
    preview: completionPreview,
  };

  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'completed',
    buildNextJob: (currentJob) => {
      let nextJob = {
        ...currentJob,
        status: 'completed',
        completedAt: normalizedCompletedAt,
        remediationWorker: remediationWorker || currentJob.remediationWorker,
        completion: normalizedCompletion,
        remediationReply: remediationReply || currentJob.remediationReply,
        reReview: reReview || currentJob.reReview,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          nextAction: null,
        },
      };

      if (currentJob?.remediationPlan?.currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'completed',
          finishedAt: normalizedCompletedAt,
          worker: remediationWorker || round.worker || currentJob.remediationWorker || null,
          completion: normalizedCompletion,
          remediationReply: remediationReply || round.remediationReply || currentJob.remediationReply || null,
          reReview: reReview || round.reReview || currentJob.reReview || null,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      recordRemediationPassTerminalSafe({
        rootDir,
        job: nextJob,
        worker: nextJob.remediationWorker || {},
        status: 'completed',
        endedAt: normalizedCompletedAt,
      });
      return nextJob;
    },
  });
}

// Intentionally synchronous today: stopped/ failed/ completed queue
// transitions use rename + writeFileSync so callers can treat the on-disk
// terminal record as durable immediately after return.
function markFollowUpJobStopped({
  rootDir,
  jobPath,
  stoppedAt = new Date().toISOString(),
  stopReason,
  stopCode = 'stopped',
  stoppedBy = null,
  sourceStatus = null,
  remediationWorker,
  remediationReply,
  reReview,
  completion,
  failure,
  commentDelivery = null,
}) {
  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'stopped',
    buildNextJob: (currentJob) => {
      const currentRound = Number(currentJob?.remediationPlan?.currentRound || 0);
      const maxRounds = Number(currentJob?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
      const stop = buildStopMetadata({
        code: stopCode,
        reason: stopReason,
        stoppedAt,
        stoppedBy,
        sourceStatus: sourceStatus || currentJob.status || null,
        currentRound,
        maxRounds,
      });

      let nextJob = {
        ...currentJob,
        status: 'stopped',
        stoppedAt,
        remediationWorker: remediationWorker ?? currentJob.remediationWorker ?? null,
        remediationReply: remediationReply ?? currentJob.remediationReply,
        reReview: reReview ?? currentJob.reReview ?? null,
        completion: completion ?? currentJob.completion ?? null,
        failure: failure ?? currentJob.failure ?? null,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          stopReason: stop.reason,
          stop,
          nextAction: null,
        },
      };

      if (currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'stopped',
          finishedAt: stoppedAt,
          worker: remediationWorker ?? round.worker ?? currentJob.remediationWorker ?? null,
          remediationReply: remediationReply ?? round.remediationReply ?? currentJob.remediationReply ?? null,
          reReview: reReview ?? round.reReview ?? currentJob.reReview ?? null,
          completion: completion ?? round.completion ?? currentJob.completion ?? null,
          failure: failure ?? round.failure ?? currentJob.failure ?? null,
          stop,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      recordRemediationPassTerminalSafe({
        rootDir,
        job: nextJob,
        worker: nextJob.remediationWorker || {},
        status: 'cancelled',
        endedAt: stoppedAt,
      });
      return nextJob;
    },
  });
}

function requeueFollowUpJobForNextRound({
  rootDir,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = 'operator',
  reason = 'Additional remediation round requested.',
  // PR #186 round-1 review B1: when the job was stopped with
  // `stale-review-head`, the consume-time check at
  // `lifecycleStopDecision` (`src/follow-up-remediation.mjs:2370-2381`)
  // re-fires `jobRevisionRef !== currentHeadSha` on the next tick
  // unless we either (a) write the fresh head into `nextJob.revisionRef`
  // or (b) clear it so the guard short-circuits. Callers that know the
  // current head (the label handler reads it from
  // `labelEvent.headSha`) pass it via `revisionRef`; callers that don't
  // (the CLI) get the safe fallback below.
  revisionRef = null,
}) {
  const currentJob = readFollowUpJob(jobPath);
  const currentRound = Number(currentJob?.remediationPlan?.currentRound || 0);
  const maxRounds = Number(currentJob?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
  const stopCode = selectStopCode({
    currentRound,
    maxRounds,
    requestedStopCode: currentJob.status === 'completed' && currentJob?.reReview?.requested !== true
      ? 'no-progress'
      : 'max-rounds-reached',
  });

  if (isActiveFollowUpJobStatus(currentJob.status)) {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }
  if (!['completed', 'failed', 'stopped'].includes(currentJob.status)) {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }
  if (currentJob.status === 'stopped' && !isRetriggerableStoppedFollowUpJob(currentJob)) {
    const code = currentJob?.remediationPlan?.stop?.code || 'unknown';
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from stopped:${code}`);
  }

  if (currentRound >= maxRounds) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: requestedAt,
      stopCode,
      stoppedBy: {
        type: 'system',
        requestedBy,
      },
      sourceStatus: currentJob.status,
      stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}). ${reason}`,
    });
  }

  if (currentJob.status === 'completed' && currentJob?.reReview?.requested !== true) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: requestedAt,
      stopCode,
      stoppedBy: {
        type: 'system',
        requestedBy,
      },
      sourceStatus: currentJob.status,
      stopReason: `No durable re-review request was recorded for remediation round ${currentRound || 1}; stopping to avoid a silent no-progress loop. ${reason}`,
    });
  }

  // Resolve the revisionRef the requeued job should carry.
  //   - Caller-supplied head (label handler) → write that. The operator
  //     gesture is "remediate against this head" so it's authoritative.
  //   - Caller didn't supply a head AND the job was stopped with
  //     `stale-review-head` → clear `revisionRef` so the consume-time
  //     `jobRevisionRef && currentHeadSha && jobRevisionRef !== currentHeadSha`
  //     check short-circuits on the next tick. Otherwise the operator
  //     gesture is silently inert: the job flips to `pending`, then the
  //     next consume tick re-fires the same stale-head stop within ≤120s.
  //   - Otherwise → preserve the existing revisionRef unchanged.
  const previousStopCode = currentJob?.remediationPlan?.stop?.code || null;
  let nextRevisionRef;
  if (typeof revisionRef === 'string' && revisionRef.trim()) {
    nextRevisionRef = revisionRef.trim();
  } else if (previousStopCode === 'stale-review-head') {
    nextRevisionRef = null;
  } else {
    nextRevisionRef = currentJob?.revisionRef ?? null;
  }

  const nextJob = {
    ...currentJob,
    revisionRef: nextRevisionRef,
    status: 'pending',
    pendingAt: requestedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: null,
    failure: null,
    completedAt: null,
    stoppedAt: null,
    completion: null,
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan(maxRounds)),
      stopReason: null,
      nextAction: {
        type: 'consume-pending-round',
        round: currentRound + 1,
        operatorVisibility: 'explicit',
        operatorOverride: true,
        requestedAt,
        requestedBy,
        reason,
      },
    },
  };

  return moveFollowUpJob(rootDir, jobPath, 'pending', nextJob);
}

function stopFollowUpJob({
  rootDir,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = 'operator',
  reason = 'Operator requested stop.',
}) {
  const currentJob = readFollowUpJob(jobPath);

  if (currentJob.status === 'stopped') {
    return { job: currentJob, jobPath };
  }

  if (!['pending', 'in_progress', 'completed', 'failed'].includes(currentJob.status)) {
    throw new Error(`Cannot stop follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }

  return markFollowUpJobStopped({
    rootDir,
    jobPath,
    stoppedAt: requestedAt,
    stopCode: 'operator-stop',
    stoppedBy: {
      type: 'operator',
      requestedBy,
    },
    sourceStatus: currentJob.status,
    stopReason: reason,
  });
}

function isRetriggerableStoppedFollowUpJob(job) {
  if (job?.status !== 'stopped') return false;
  return RETRIGGERABLE_STOP_CODE_SET.has(job?.remediationPlan?.stop?.code);
}

export {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  DEFAULT_MAX_TRANSIENT_RETRIES,
  MAX_QUOTA_HOLD_WINDOW_MS,
  FOLLOW_UP_JOB_DIRS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS,
  PUBLIC_REPLY_MAX_CHARS,
  RETRIGGERABLE_STOP_CODES,
  ROUND_BUDGET_BY_RISK_CLASS,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildStopMetadata,
  buildRemediationReply,
  buildRemediationReplyArtifact,
  archiveStoppedFollowUpJobs,
  reapTerminalFollowUpWorkspaces,
  claimNextFollowUpJob,
  createFollowUpJob,
  detectPublicReplyNoiseSignal,
  ensureFollowUpJobDirs,
  extractReviewSummary,
  getCurrentRound,
  getFollowUpJobDir,
  isActiveFollowUpJobStatus,
  isRetriggerableStoppedFollowUpJob,
  listFollowUpJobsInDir,
  listInProgressFollowUpJobPaths,
  listInProgressFollowUpJobs,
  listPendingFollowUpJobPaths,
  listPendingFollowUpJobs,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  requeueInProgressFollowUpJobForRetry,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  readRemediationReplyArtifact,
  salvagePartialRemediationReply,
  readFollowUpJob,
  remediationAttemptNumber,
  resolveRoundBudgetForJob,
  requeueFollowUpJobForNextRound,
  stopFollowUpJob,
  summarizePRRemediationLedger,
  validateRemediationReply,
  writeFollowUpJob,
};
