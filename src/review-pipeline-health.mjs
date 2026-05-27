import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const DEFAULT_REVIEWER_DEATH_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_REVIEWER_DEATH_RATE_THRESHOLD = 0.5;
const DEFAULT_REVIEWER_DEATH_RATE_MIN_ATTEMPTS = 3;
const DEFAULT_QUEUE_STARVATION_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_REMEDIATION_BACKLOG_THRESHOLD = 5;
const DEFAULT_MERGE_STALLED_MAX_TICKS = 3;
const DEFAULT_PIPELINE_TICK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REMEDIATION_THROUGHPUT_WINDOW_MS = 60 * 60 * 1000;

const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  in_progress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
});

const REVIEW_PIPELINE_HEALTH_METRICS = Object.freeze([
  'review_pipeline_reviewer_attempts_total',
  'review_pipeline_first_pass_queue_depth',
  'review_pipeline_first_pass_oldest_pending_age_seconds',
  'review_pipeline_remediation_backlog_jobs',
  'review_pipeline_remediation_oldest_pending_age_seconds',
  'review_pipeline_remediation_throughput_jobs',
  'review_pipeline_merge_outcomes_total',
  'review_pipeline_merge_stalled_jobs',
  'review_pipeline_sentinel_finding_active',
]);

const REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS = Object.freeze([
  {
    code: 'review:reviewer_death_rate_high',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'reviewerDeathRateThreshold',
    defaultThreshold: DEFAULT_REVIEWER_DEATH_RATE_THRESHOLD,
    windowKey: 'reviewerDeathRateWindowMs',
    defaultWindowMs: DEFAULT_REVIEWER_DEATH_RATE_WINDOW_MS,
  },
  {
    code: 'review:queue_starvation',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'queueStarvationMaxAgeMs',
    defaultThreshold: DEFAULT_QUEUE_STARVATION_MAX_AGE_MS,
  },
  {
    code: 'review:remediation_backlog',
    tier: 'ticket',
    category: 'review-pipeline',
    thresholdKey: 'remediationBacklogThreshold',
    defaultThreshold: DEFAULT_REMEDIATION_BACKLOG_THRESHOLD,
  },
  {
    code: 'review:merge_stalled',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'mergeStalledMaxTicks',
    defaultThreshold: DEFAULT_MERGE_STALLED_MAX_TICKS,
  },
]);

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveReviewPipelineHealthConfig(env = process.env, overrides = {}) {
  return {
    reviewerDeathRateWindowMs: parsePositiveInteger(
      overrides.reviewerDeathRateWindowMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_WINDOW_MS,
      DEFAULT_REVIEWER_DEATH_RATE_WINDOW_MS
    ),
    reviewerDeathRateThreshold: parseNumber(
      overrides.reviewerDeathRateThreshold
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_THRESHOLD,
      DEFAULT_REVIEWER_DEATH_RATE_THRESHOLD
    ),
    reviewerDeathRateMinAttempts: parsePositiveInteger(
      overrides.reviewerDeathRateMinAttempts
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_MIN_ATTEMPTS,
      DEFAULT_REVIEWER_DEATH_RATE_MIN_ATTEMPTS
    ),
    queueStarvationMaxAgeMs: parsePositiveInteger(
      overrides.queueStarvationMaxAgeMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_QUEUE_STARVATION_MAX_AGE_MS,
      DEFAULT_QUEUE_STARVATION_MAX_AGE_MS
    ),
    remediationBacklogThreshold: parsePositiveInteger(
      overrides.remediationBacklogThreshold
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_BACKLOG_THRESHOLD,
      DEFAULT_REMEDIATION_BACKLOG_THRESHOLD
    ),
    mergeStalledMaxTicks: parsePositiveInteger(
      overrides.mergeStalledMaxTicks
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_MERGE_STALLED_MAX_TICKS,
      DEFAULT_MERGE_STALLED_MAX_TICKS
    ),
    pipelineTickIntervalMs: parsePositiveInteger(
      overrides.pipelineTickIntervalMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_TICK_INTERVAL_MS,
      DEFAULT_PIPELINE_TICK_INTERVAL_MS
    ),
    remediationThroughputWindowMs: parsePositiveInteger(
      overrides.remediationThroughputWindowMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_THROUGHPUT_WINDOW_MS,
      DEFAULT_REMEDIATION_THROUGHPUT_WINDOW_MS
    ),
  };
}

function toIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMs(nowMs, value) {
  const valueMs = toMs(value);
  if (valueMs === null) return null;
  return Math.max(0, nowMs - valueMs);
}

function parseJson(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function classifyFailure(value) {
  const text = String(value || '').toLowerCase();
  if (!text.trim()) return 'unknown';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('no output')) return 'timeout';
  if (text.includes('oauth') || text.includes('auth') || text.includes('token') || text.includes('credential')) return 'auth';
  if (text.includes('upstream') || text.includes('litellm') || text.includes('rate limit') || text.includes('5xx')) return 'upstream';
  if (text.includes('launchctl') || text.includes('bootstrap') || text.includes('tcc') || text.includes('sandbox')) return 'runtime';
  if (text.includes('orphan') || text.includes('pgid') || text.includes('session')) return 'orphan';
  if (text.includes('malformed')) return 'malformed-title';
  if (text.includes('cancel')) return 'cancelled';
  return 'unknown';
}

function failureClassForPass(row) {
  const metadata = parseJson(row?.metadata_json, {});
  return metadata.failureClass
    || metadata.failure_class
    || metadata.errorClass
    || metadata.error_class
    || metadata.failureCode
    || metadata.failure_code
    || classifyFailure(metadata.failureMessage || metadata.message || metadata.error || row?.status);
}

function summarizeReviewerAttempts(db, { nowMs, config }) {
  const cutoff = new Date(nowMs - config.reviewerDeathRateWindowMs).toISOString();
  const rows = db.prepare(
    `SELECT repo, pr_number, pass_kind, status, started_at, ended_at, metadata_json
       FROM reviewer_passes
      WHERE started_at >= ?
        AND pass_kind IN ('first-pass', 'rereview')`
  ).all(cutoff);

  const attempts = new Map();
  let total = 0;
  const failuresByClass = new Map();

  for (const row of rows) {
    total += 1;
    const failureClass = row.status === 'failed' ? failureClassForPass(row) : 'none';
    const key = JSON.stringify({
      status: row.status || 'unknown',
      failure_class: failureClass,
      pass_kind: row.pass_kind || 'unknown',
    });
    attempts.set(key, (attempts.get(key) || 0) + 1);
    if (row.status === 'failed') {
      failuresByClass.set(failureClass, (failuresByClass.get(failureClass) || 0) + 1);
    }
  }

  if (total === 0) {
    const fallbackRows = db.prepare(
      `SELECT review_status, failure_message, last_attempted_at, failed_at
         FROM reviewed_prs
        WHERE last_attempted_at >= ?
           OR failed_at >= ?`
    ).all(cutoff, cutoff);
    for (const row of fallbackRows) {
      total += 1;
      const failed = row.review_status === 'failed' || row.review_status === 'failed-orphan';
      const failureClass = failed ? classifyFailure(row.failure_message || row.review_status) : 'none';
      const key = JSON.stringify({
        status: failed ? 'failed' : row.review_status || 'unknown',
        failure_class: failureClass,
        pass_kind: 'first-pass',
      });
      attempts.set(key, (attempts.get(key) || 0) + 1);
      if (failed) failuresByClass.set(failureClass, (failuresByClass.get(failureClass) || 0) + 1);
    }
  }

  return {
    total,
    attempts: Array.from(attempts, ([key, value]) => ({ ...JSON.parse(key), value })),
    failureRatios: Array.from(failuresByClass, ([failureClass, failed]) => ({
      failureClass,
      failed,
      attempted: total,
      ratio: total > 0 ? failed / total : 0,
    })),
  };
}

function summarizeFirstPassQueue(db, { nowMs }) {
  const rows = db.prepare(
    `SELECT repo, pr_number, reviewed_at, rereview_requested_at, last_attempted_at
       FROM reviewed_prs
      WHERE pr_state = 'open'
        AND review_status = 'pending'`
  ).all();
  let oldest = null;
  for (const row of rows) {
    const pendingSince = row.rereview_requested_at || row.reviewed_at || row.last_attempted_at;
    const pendingAgeMs = ageMs(nowMs, pendingSince);
    if (pendingAgeMs === null) continue;
    if (!oldest || pendingAgeMs > oldest.ageMs) {
      oldest = {
        repo: row.repo,
        prNumber: row.pr_number,
        pendingSince,
        ageMs: pendingAgeMs,
      };
    }
  }
  return {
    depth: rows.length,
    oldest,
  };
}

function summarizeMergeOutcomes(db) {
  const rows = db.prepare(
    `SELECT COALESCE(pr_state, 'unknown') AS outcome, COUNT(*) AS count
       FROM reviewed_prs
      GROUP BY COALESCE(pr_state, 'unknown')`
  ).all();
  return rows.map((row) => ({ outcome: row.outcome, count: row.count }));
}

function readFollowUpJobs(rootDir) {
  const jobs = [];
  for (const [state, parts] of Object.entries(FOLLOW_UP_JOB_DIRS)) {
    const dir = join(rootDir, ...parts);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const jobPath = join(dir, name);
      let stat;
      try {
        stat = statSync(jobPath);
      } catch {
        continue;
      }
      let job = {};
      try {
        job = parseJson(readFileSync(jobPath, 'utf8'), {});
      } catch {
        job = {};
      }
      jobs.push({ state, jobPath, stat, job });
    }
  }
  return jobs;
}

function jobTimestamp(job, fallbackMs) {
  return job.createdAt
    || job.claimedAt
    || job.completedAt
    || job.failedAt
    || job.stoppedAt
    || new Date(fallbackMs).toISOString();
}

function terminalJobTimestamp(job, fallbackMs) {
  return job.completedAt
    || job.failedAt
    || job.stoppedAt
    || job.claimedAt
    || job.createdAt
    || new Date(fallbackMs).toISOString();
}

function summarizeFollowUpQueues(rootDir, { nowMs, config }) {
  const jobs = readFollowUpJobs(rootDir);
  const states = Object.fromEntries(Object.keys(FOLLOW_UP_JOB_DIRS).map((state) => [state, 0]));
  const throughput = { completed: 0, failed: 0, stopped: 0 };
  let oldestPending = null;
  const throughputCutoffMs = nowMs - config.remediationThroughputWindowMs;

  for (const entry of jobs) {
    states[entry.state] = (states[entry.state] || 0) + 1;
    if (entry.state === 'pending') {
      const pendingSince = jobTimestamp(entry.job, entry.stat.mtimeMs);
      const pendingAgeMs = ageMs(nowMs, pendingSince);
      if (pendingAgeMs !== null && (!oldestPending || pendingAgeMs > oldestPending.ageMs)) {
        oldestPending = {
          jobId: entry.job.jobId || null,
          repo: entry.job.repo || null,
          prNumber: entry.job.prNumber || null,
          pendingSince,
          ageMs: pendingAgeMs,
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(throughput, entry.state)) {
      const endedMs = toMs(terminalJobTimestamp(entry.job, entry.stat.mtimeMs));
      if (endedMs !== null && endedMs >= throughputCutoffMs) {
        throughput[entry.state] += 1;
      }
    }
  }

  return { jobs, states, throughput, oldestPending };
}

function reviewRowsByRepoPr(db) {
  const rows = db.prepare(
    `SELECT repo, pr_number, pr_state, merged_at, closed_at, labels_json
       FROM reviewed_prs`
  ).all();
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.repo}#${row.pr_number}`, row);
  }
  return map;
}

function isReviewSettledStop(job) {
  return job?.remediationPlan?.stop?.code === 'review-settled'
    || job?.stopCode === 'review-settled'
    || job?.stopReason === 'Latest adversarial review verdict is non-blocking; no remediation worker required.';
}

function summarizeMergeStalls({ followUpJobs, reviewRows, nowMs, config }) {
  const stalledAfterMs = config.mergeStalledMaxTicks * config.pipelineTickIntervalMs;
  const candidates = [];
  for (const entry of followUpJobs) {
    if (entry.state !== 'stopped' || !isReviewSettledStop(entry.job)) continue;
    const repo = entry.job.repo;
    const prNumber = Number(entry.job.prNumber);
    if (!repo || !Number.isInteger(prNumber)) continue;
    const reviewRow = reviewRows.get(`${repo}#${prNumber}`);
    if (reviewRow && reviewRow.pr_state !== 'open') continue;
    const stoppedAt = entry.job.stoppedAt
      || entry.job.remediationPlan?.stop?.stoppedAt
      || new Date(entry.stat.mtimeMs).toISOString();
    const stalledMs = ageMs(nowMs, stoppedAt);
    if (stalledMs === null || stalledMs <= stalledAfterMs) continue;
    candidates.push({
      repo,
      prNumber,
      jobId: entry.job.jobId || null,
      stoppedAt,
      stalledMs,
      thresholdMs: stalledAfterMs,
    });
  }
  return {
    thresholdMs: stalledAfterMs,
    candidates,
  };
}

function buildFinding({ code, tier, subject, message, evidence, recommendedAction, observedAt, details = {} }) {
  return {
    agent_id: 'sentinel',
    tier,
    category: 'review-pipeline',
    code,
    subject,
    message,
    evidence,
    recommended_action: recommendedAction,
    observedAt,
    details,
  };
}

function evaluateReviewPipelineFindings(snapshot, { observedAt }) {
  const findings = [];
  const { config } = snapshot;

  for (const ratio of snapshot.reviewer.failureRatios) {
    if (
      ratio.attempted >= config.reviewerDeathRateMinAttempts
      && ratio.ratio > config.reviewerDeathRateThreshold
    ) {
      findings.push(buildFinding({
        code: 'review:reviewer_death_rate_high',
        tier: 'page',
        subject: `Reviewer failure class ${ratio.failureClass} is ${Math.round(ratio.ratio * 100)}% of recent attempts`,
        message: `${ratio.failed}/${ratio.attempted} reviewer attempts failed as ${ratio.failureClass}.`,
        evidence: [`reviews.db reviewer_passes window=${config.reviewerDeathRateWindowMs}ms`],
        recommendedAction: 'Inspect reviewer_passes metadata and the watcher logs for the dominant failure class before the queue starves.',
        observedAt,
        details: ratio,
      }));
    }
  }

  const oldest = snapshot.firstPassQueue.oldest;
  if (oldest && oldest.ageMs > config.queueStarvationMaxAgeMs) {
    findings.push(buildFinding({
      code: 'review:queue_starvation',
      tier: 'page',
      subject: `Oldest pending first-pass review is ${Math.round(oldest.ageMs / 1000)}s old`,
      message: `${oldest.repo}#${oldest.prNumber} has been pending since ${oldest.pendingSince}.`,
      evidence: [`reviews.db reviewed_prs ${oldest.repo}#${oldest.prNumber}`],
      recommendedAction: 'Check adversarial-watcher health and reviewer runtime capacity; retrigger or bounce only after preserving failure evidence.',
      observedAt,
      details: {
        ...oldest,
        thresholdMs: config.queueStarvationMaxAgeMs,
        depth: snapshot.firstPassQueue.depth,
      },
    }));
  }

  const pendingRemediation = snapshot.followUpQueues.states.pending || 0;
  if (pendingRemediation > config.remediationBacklogThreshold) {
    findings.push(buildFinding({
      code: 'review:remediation_backlog',
      tier: 'ticket',
      subject: `${pendingRemediation} pending remediation jobs exceed the configured threshold`,
      message: `follow-up-jobs/pending has ${pendingRemediation} job(s).`,
      evidence: ['data/follow-up-jobs/pending'],
      recommendedAction: 'Inspect adversarial-follow-up capacity and clear stale pending jobs with the documented stop/requeue path.',
      observedAt,
      details: {
        pending: pendingRemediation,
        threshold: config.remediationBacklogThreshold,
        oldestPending: snapshot.followUpQueues.oldestPending,
      },
    }));
  }

  if (snapshot.mergeStalls.candidates.length > 0) {
    const sample = snapshot.mergeStalls.candidates[0];
    findings.push(buildFinding({
      code: 'review:merge_stalled',
      tier: 'page',
      subject: `${snapshot.mergeStalls.candidates.length} clean review verdict(s) remain unmerged past the tick threshold`,
      message: `${sample.repo}#${sample.prNumber} settled at ${sample.stoppedAt} but is still open.`,
      evidence: snapshot.mergeStalls.candidates.map((candidate) => (
        `data/follow-up-jobs/stopped ${candidate.repo}#${candidate.prNumber} job=${candidate.jobId || 'unknown'}`
      )),
      recommendedAction: 'Check merge-agent dispatch records, branch protection, and scoped operator labels for the stalled clean verdict.',
      observedAt,
      details: {
        thresholdMs: snapshot.mergeStalls.thresholdMs,
        candidates: snapshot.mergeStalls.candidates,
      },
    }));
  }

  return findings;
}

function collectReviewPipelineHealth({
  rootDir = process.cwd(),
  now = () => new Date(),
  env = process.env,
  config: configOverrides = {},
} = {}) {
  const observedAt = toIso(now);
  const nowMs = Date.parse(observedAt);
  const config = resolveReviewPipelineHealthConfig(env, configOverrides);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const reviewer = summarizeReviewerAttempts(db, { nowMs, config });
    const firstPassQueue = summarizeFirstPassQueue(db, { nowMs });
    const followUpQueues = summarizeFollowUpQueues(rootDir, { nowMs, config });
    const mergeOutcomes = summarizeMergeOutcomes(db);
    const mergeStalls = summarizeMergeStalls({
      followUpJobs: followUpQueues.jobs,
      reviewRows: reviewRowsByRepoPr(db),
      nowMs,
      config,
    });
    const snapshot = {
      observedAt,
      rootDir,
      config,
      reviewer,
      firstPassQueue,
      followUpQueues: {
        states: followUpQueues.states,
        throughput: followUpQueues.throughput,
        oldestPending: followUpQueues.oldestPending,
      },
      mergeOutcomes,
      mergeStalls,
    };
    return {
      ...snapshot,
      findings: evaluateReviewPipelineFindings(snapshot, { observedAt }),
    };
  } finally {
    db.close();
  }
}

function labelsToString(labels = {}) {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  return entries.length ? `{${entries.join(',')}}` : '';
}

function metricLine(name, labels, value) {
  return `${name}${labelsToString(labels)} ${Number(value) || 0}`;
}

function renderReviewPipelinePrometheus(snapshot) {
  const lines = [];
  const reviewerAttempts = snapshot.reviewer.attempts.length
    ? snapshot.reviewer.attempts
    : [{ status: 'none', failure_class: 'none', pass_kind: 'first-pass', value: 0 }];
  for (const row of reviewerAttempts) {
    lines.push(metricLine('review_pipeline_reviewer_attempts_total', {
      status: row.status,
      failure_class: row.failure_class,
      pass_kind: row.pass_kind,
    }, row.value));
  }
  lines.push(metricLine('review_pipeline_first_pass_queue_depth', {}, snapshot.firstPassQueue.depth));
  lines.push(metricLine(
    'review_pipeline_first_pass_oldest_pending_age_seconds',
    {},
    Math.round((snapshot.firstPassQueue.oldest?.ageMs || 0) / 1000)
  ));
  for (const [state, count] of Object.entries(snapshot.followUpQueues.states)) {
    lines.push(metricLine('review_pipeline_remediation_backlog_jobs', { state }, count));
  }
  lines.push(metricLine(
    'review_pipeline_remediation_oldest_pending_age_seconds',
    {},
    Math.round((snapshot.followUpQueues.oldestPending?.ageMs || 0) / 1000)
  ));
  for (const [state, count] of Object.entries(snapshot.followUpQueues.throughput)) {
    lines.push(metricLine('review_pipeline_remediation_throughput_jobs', {
      state,
      window: `${snapshot.config.remediationThroughputWindowMs}ms`,
    }, count));
  }
  const mergeOutcomes = snapshot.mergeOutcomes.length
    ? snapshot.mergeOutcomes
    : [{ outcome: 'none', count: 0 }];
  for (const outcome of mergeOutcomes) {
    lines.push(metricLine('review_pipeline_merge_outcomes_total', { outcome: outcome.outcome }, outcome.count));
  }
  lines.push(metricLine('review_pipeline_merge_stalled_jobs', {}, snapshot.mergeStalls.candidates.length));
  for (const definition of REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS) {
    const active = snapshot.findings.some((finding) => finding.code === definition.code);
    lines.push(metricLine('review_pipeline_sentinel_finding_active', {
      code: definition.code,
      tier: definition.tier,
    }, active ? 1 : 0));
  }
  return `${lines.join('\n')}\n`;
}

export {
  REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS,
  REVIEW_PIPELINE_HEALTH_METRICS,
  collectReviewPipelineHealth,
  evaluateReviewPipelineFindings,
  renderReviewPipelinePrometheus,
  resolveReviewPipelineHealthConfig,
};
