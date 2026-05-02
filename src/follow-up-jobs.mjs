import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const MAX_CREATE_ATTEMPTS = 100;

const FOLLOW_UP_JOB_SCHEMA_VERSION = 2;
// Bounded remediation cap. Was 6 (PR #18 era); dropped to 3 after
// observing diminishing returns past round 3 — rounds 1-3 caught real
// structural bugs, edge cases, and security regressions; rounds 4-7
// produced mostly duplicate findings and stacked complexity faster
// than they removed risk. Pairs with a lenient final-round verdict
// threshold in the reviewer prompt (the final-round review only blocks
// on data corruption / secret leakage / security regression /
// broken external contract; everything else becomes a non-blocking
// note for human review). See prompts/reviewer-prompt-final-round-addendum.md.
const DEFAULT_MAX_REMEDIATION_ROUNDS = 3;
const REMEDIATION_REPLY_SCHEMA_VERSION = 1;
const REMEDIATION_REPLY_KIND = 'adversarial-review-remediation-reply';
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
  workspaces: ['data', 'follow-up-jobs', 'workspaces'],
});

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
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

function normalizeMaxRounds(maxRounds) {
  return Number.isInteger(maxRounds) && maxRounds > 0
    ? maxRounds
    : DEFAULT_MAX_REMEDIATION_ROUNDS;
}

function buildRemediationRoundPlan(maxRounds = DEFAULT_MAX_REMEDIATION_ROUNDS) {
  const normalizedMaxRounds = normalizeMaxRounds(maxRounds);

  return {
    mode: 'bounded-manual-rounds',
    maxRounds: normalizedMaxRounds,
    currentRound: 0,
    rounds: [],
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
    reReview: {
      requested: Boolean(reReviewRequested),
      reason: reReviewRequested
        ? (reReviewReason || 'Remediation applied and ready for another adversarial review pass.')
        : null,
    },
  };
}

// Known placeholder/template strings that the prompt prefills (or used
// to prefill) as shape examples for the worker. Templated agent
// outputs routinely leak example text unchanged when the worker copies
// the contract verbatim — catching it here keeps the placeholders out
// of the public PR comment AND prevents a fake-accountability reply
// from flipping `reReview.requested = true` and burning another round.
//
// Both patterns are anchored at the start of the trimmed string so
// they cannot fire on legitimate prose that happens to mention
// "replace with" or "optional list of files" in passing — only on
// strings that lead with the template wording.
const PLACEHOLDER_PATTERNS = [
  /^Replace (this )?with\b/i,
  /^Optional list of files\b/i,
];

function assertNoPlaceholderText(value, locationLabel) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(
        `Remediation reply ${locationLabel} contains placeholder/example text ` +
          `from the prompt template; replace it with real content before submitting`
      );
    }
  }
}

function validateStringArrayField(items, fieldName) {
  if (!Array.isArray(items)) {
    throw new Error(`Remediation reply ${fieldName} must be an array`);
  }

  items.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Remediation reply ${fieldName}[${index}] must be a non-empty string`);
    }
    assertNoPlaceholderText(item, `${fieldName}[${index}]`);
  });
}

// addressed[] entries are { finding, action, files? } where files is
// an optional array of strings (the worker can list paths it touched
// while addressing the finding). Per-entry validation rejects a
// missing or empty finding/action so the public PR comment never
// renders an empty bullet, but tolerates files being absent.
function validateAddressedField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply addressed must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply addressed[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply addressed[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.action !== 'string' || !entry.action.trim()) {
      throw new Error(`Remediation reply addressed[${index}].action must be a non-empty string`);
    }
    assertNoPlaceholderText(entry.finding, `addressed[${index}].finding`);
    assertNoPlaceholderText(entry.action, `addressed[${index}].action`);
    if (entry.files !== undefined) {
      if (!Array.isArray(entry.files)) {
        throw new Error(`Remediation reply addressed[${index}].files must be an array if provided`);
      }
      entry.files.forEach((f, fi) => {
        if (typeof f !== 'string' || !f.trim()) {
          throw new Error(`Remediation reply addressed[${index}].files[${fi}] must be a non-empty string`);
        }
        assertNoPlaceholderText(f, `addressed[${index}].files[${fi}]`);
      });
    }
  });
}

// pushback[] entries are { finding, reasoning } — both required and
// non-empty. This is the slot for "I read the finding, decided not to
// change the code, here's why." Distinct from blockers (hard exit) and
// addressed (fix applied).
function validatePushbackField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply pushback must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply pushback[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply pushback[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.reasoning !== 'string' || !entry.reasoning.trim()) {
      throw new Error(`Remediation reply pushback[${index}].reasoning must be a non-empty string`);
    }
    assertNoPlaceholderText(entry.finding, `pushback[${index}].finding`);
    assertNoPlaceholderText(entry.reasoning, `pushback[${index}].reasoning`);
  });
}

// blockers[] entries are { finding, reasoning?, needsHumanInput? } —
// `finding` always required, plus at least one of `reasoning` or
// `needsHumanInput` (both can be present). Same per-finding shape as
// addressed[]/pushback[] so the hard-exit path can also identify
// which review finding it corresponds to. Without this, a multi-
// finding review that hard-exits on finding 3 produces a blocker the
// next human cannot trace back to a specific review item — defeats
// the per-finding accountability contract.
function validateBlockersField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply blockers must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply blockers[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply blockers[${index}].finding must be a non-empty string`);
    }
    const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning.trim();
    const hasNeedsHumanInput = typeof entry.needsHumanInput === 'string' && entry.needsHumanInput.trim();
    if (!hasReasoning && !hasNeedsHumanInput) {
      throw new Error(
        `Remediation reply blockers[${index}] must include a non-empty reasoning or needsHumanInput field`
      );
    }
    if (entry.reasoning !== undefined && !hasReasoning) {
      throw new Error(`Remediation reply blockers[${index}].reasoning must be a non-empty string when provided`);
    }
    if (entry.needsHumanInput !== undefined && !hasNeedsHumanInput) {
      throw new Error(`Remediation reply blockers[${index}].needsHumanInput must be a non-empty string when provided`);
    }
    assertNoPlaceholderText(entry.finding, `blockers[${index}].finding`);
    if (hasReasoning) {
      assertNoPlaceholderText(entry.reasoning, `blockers[${index}].reasoning`);
    }
    if (hasNeedsHumanInput) {
      assertNoPlaceholderText(entry.needsHumanInput, `blockers[${index}].needsHumanInput`);
    }
  });
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

  if (typeof reply.summary !== 'string' || !reply.summary.trim()) {
    throw new Error('Remediation reply summary is required');
  }
  assertNoPlaceholderText(reply.summary, 'summary');

  const allowedOutcomes = new Set(['completed', 'blocked', 'partial']);
  if (!allowedOutcomes.has(reply.outcome)) {
    throw new Error(`Remediation reply outcome must be one of: ${Array.from(allowedOutcomes).join(', ')}`);
  }

  validateStringArrayField(reply.validation, 'validation');
  validateBlockersField(reply.blockers);

  // addressed[] / pushback[] are additive — replies that omit them
  // entirely are still valid (legacy worker output, jobs created before
  // this schema landed). Only validate shape when the fields are
  // present. Workers that emit them get strict enforcement so a
  // half-formed entry never reaches the public PR comment renderer.
  if (reply.addressed !== undefined) {
    validateAddressedField(reply.addressed);
  }
  if (reply.pushback !== undefined) {
    validatePushbackField(reply.pushback);
  }

  if (!reply.reReview || typeof reply.reReview !== 'object' || Array.isArray(reply.reReview)) {
    throw new Error('Remediation reply reReview must be an object');
  }

  if (typeof reply.reReview.requested !== 'boolean') {
    throw new Error('Remediation reply reReview.requested must be a boolean');
  }

  if (reply.reReview.requested && (typeof reply.reReview.reason !== 'string' || !reply.reReview.reason.trim())) {
    throw new Error('Remediation reply reReview.reason is required when reReview.requested is true');
  }

  if (reply.reReview.requested) {
    assertNoPlaceholderText(reply.reReview.reason, 'reReview.reason');
  }

  // Cross-field semantic invariants. Without these the prompt's hard
  // contract ("populate blockers → set reReview.requested = false")
  // is documentation-only — a contradictory reply slips into
  // reconciliation and corrupts queue state (e.g. `outcome: blocked`
  // with `reReview.requested = true` re-arms the watcher AND posts a
  // PR comment claiming both "human intervention required" and
  // "re-review queued" for the same unresolved state).
  const blockersPopulated = reply.blockers.length > 0;

  if (blockersPopulated && reply.reReview.requested) {
    throw new Error(
      'Remediation reply contradicts itself: blockers are populated but reReview.requested is true. ' +
        'A populated blockers list is a hard exit; set reReview.requested = false.'
    );
  }

  if (reply.outcome === 'blocked') {
    if (!blockersPopulated) {
      throw new Error(
        'Remediation reply outcome is "blocked" but blockers is empty. ' +
          'A blocked outcome must list the unresolved blockers.'
      );
    }
    if (reply.reReview.requested) {
      throw new Error(
        'Remediation reply outcome is "blocked" but reReview.requested is true. ' +
          'A blocked outcome must set reReview.requested = false.'
      );
    }
  }

  if (reply.outcome === 'completed' && blockersPopulated) {
    throw new Error(
      'Remediation reply outcome is "completed" but blockers is non-empty. ' +
        'Use outcome "partial" or "blocked" when unresolved blockers remain.'
    );
  }

  if (expectedJob) {
    if (reply.jobId !== expectedJob.jobId) {
      throw new Error(`Remediation reply jobId mismatch: expected ${expectedJob.jobId}, got ${reply.jobId}`);
    }

    if (reply.repo !== expectedJob.repo) {
      throw new Error(`Remediation reply repo mismatch: expected ${expectedJob.repo}, got ${reply.repo}`);
    }

    if (reply.prNumber !== expectedJob.prNumber) {
      throw new Error(`Remediation reply prNumber mismatch: expected ${expectedJob.prNumber}, got ${reply.prNumber}`);
    }
  }

  return reply;
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

function buildLegacyRemediationPlan(job) {
  const maxRounds = normalizeMaxRounds(
    Number(job?.remediationPlan?.maxRounds)
      || Number(job?.recommendedFollowUpAction?.maxRounds)
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
      Number(job.remediationPlan.maxRounds || job?.recommendedFollowUpAction?.maxRounds)
    );
    const persistedStopReason = typeof job.remediationPlan.stop?.reason === 'string'
      && job.remediationPlan.stop.reason.trim()
      ? job.remediationPlan.stop.reason
      : job.remediationPlan.stopReason;
    const rounds = Array.isArray(job.remediationPlan.rounds)
      ? job.remediationPlan.rounds.map((round, index) => normalizeRound(round, index))
      : [];

    return {
      ...buildRemediationRoundPlan(
        maxRounds
      ),
      ...job.remediationPlan,
      mode: 'bounded-manual-rounds',
      maxRounds,
      currentRound,
      rounds,
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
  return {
    ...job,
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
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
// prematurely trip `max-rounds-reached` at round 2 on the new 3-round
// default cap, and at round 3 on the legacy 6-round cap.
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
function summarizePRRemediationLedger(rootDir, { repo, prNumber }) {
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
      if (job.repo !== targetRepo) continue;
      if (Number(job.prNumber) !== targetPr) continue;

      if (terminalKeys.has(key)) {
        const cur = Number(job?.remediationPlan?.currentRound || 0);
        if (Number.isFinite(cur) && cur > completedRoundsForPR) {
          completedRoundsForPR = cur;
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

  return {
    completedRoundsForPR,
    latestMaxRounds,
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

  let terminalFd;
  try {
    terminalFd = openSync(terminalPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST' && existsSync(terminalPath)) {
      rmSync(jobPath, { force: true });
      return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
    }
    throw err;
  }

  try {
    writeFileSync(terminalFd, `${JSON.stringify(nextJob, null, 2)}\n`, 'utf8');
    closeSync(terminalFd);
    terminalFd = null;
    rmSync(jobPath, { force: true });
  } catch (err) {
    if (terminalFd !== undefined && terminalFd !== null) {
      try {
        closeSync(terminalFd);
      } catch {}
    }
    rmSync(terminalPath, { force: true });
    throw err;
  }

  return { job: nextJob, jobPath: terminalPath, alreadyTerminal: false };
}

function buildFollowUpJob({
  repo,
  prNumber,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewBody,
  reviewPostedAt,
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
}) {
  const createdAt = reviewPostedAt || new Date().toISOString();
  const jobId = `${sanitizeRepo(repo)}-pr-${prNumber}-${sanitizeTimestamp(createdAt)}`;
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
    linearTicketId,
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
  const queueDir = getFollowUpJobDir(rootDir, 'pending');

  mkdirSync(queueDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const job = attempt === 0
      ? baseJob
      : {
          ...baseJob,
          jobId: `${baseJob.jobId}-${attempt + 1}`,
        };
    const jobPath = join(queueDir, `${job.jobId}.json`);

    try {
      writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { job, jobPath };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Unable to create unique follow-up job file for ${baseJob.jobId} after ${MAX_CREATE_ATTEMPTS} attempts`);
}

function claimNextFollowUpJob({
  rootDir,
  workerType = 'codex-remediation',
  claimedAt = new Date().toISOString(),
  launcherPid = process.pid,
  markStoppedImpl = markFollowUpJobStopped,
} = {}) {
  ensureFollowUpJobDirs(rootDir);

  for (const pendingPath of listPendingFollowUpJobPaths(rootDir)) {
    const inProgressPath = join(getFollowUpJobDir(rootDir, 'inProgress'), basename(pendingPath));

    try {
      renameSync(pendingPath, inProgressPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const job = readFollowUpJob(inProgressPath);
    const currentRound = Number(job?.remediationPlan?.currentRound || 0);
    const maxRounds = Number(job?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
    if (currentRound >= maxRounds) {
      try {
        markStoppedImpl({
          rootDir,
          jobPath: inProgressPath,
          stoppedAt: claimedAt,
          stopCode: 'max-rounds-reached',
          sourceStatus: job.status,
          stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before claim.`,
        });
      } catch {}
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
  jobPath,
  worker,
  spawnedAt = new Date().toISOString(),
}) {
  const currentJob = readFollowUpJob(jobPath);
  let nextJob = {
    ...currentJob,
    status: 'in_progress',
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt,
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
    spawnedAt,
    worker: {
      model: 'codex',
      ...worker,
    },
  }));

  if (worker?.workspaceDir) {
    nextJob.workspaceDir = worker.workspaceDir;
  }

  writeFollowUpJob(jobPath, nextJob);
  return { job: nextJob, jobPath };
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

      return nextJob;
    },
  });
}

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

  if (!['completed', 'failed'].includes(currentJob.status)) {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
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

  const nextJob = {
    ...currentJob,
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

export {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_DIRS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildStopMetadata,
  buildRemediationReply,
  buildRemediationReplyArtifact,
  claimNextFollowUpJob,
  createFollowUpJob,
  ensureFollowUpJobDirs,
  extractReviewSummary,
  getCurrentRound,
  getFollowUpJobDir,
  listFollowUpJobsInDir,
  listInProgressFollowUpJobPaths,
  listInProgressFollowUpJobs,
  listPendingFollowUpJobPaths,
  listPendingFollowUpJobs,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  readRemediationReplyArtifact,
  readFollowUpJob,
  requeueFollowUpJobForNextRound,
  stopFollowUpJob,
  summarizePRRemediationLedger,
  validateRemediationReply,
  writeFollowUpJob,
};
