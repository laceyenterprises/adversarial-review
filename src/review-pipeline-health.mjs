import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { PROVIDER_OVERLOADED_FAILURE_CLASS } from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import { ROUND_BUDGET_BY_RISK_CLASS } from './follow-up-jobs.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS, quotaHoldDecision } from './quota-exhaustion.mjs';

const DEFAULT_REVIEWER_DEATH_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_REVIEWER_DEATH_RATE_THRESHOLD = 0.5;
const DEFAULT_REVIEWER_DEATH_RATE_MIN_ATTEMPTS = 3;
const DEFAULT_REVIEW_UNKNOWN_RATE_THRESHOLD = 0.30;
const DEFAULT_REVIEW_UNKNOWN_RATE_WINDOW_MINUTES = 15;
const DEFAULT_REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR = 5;
const MIN_REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR = 3;
const DEFAULT_REVIEW_UNKNOWN_RATE_DISTINCT_PR_FLOOR = 2;
const DEFAULT_QUEUE_STARVATION_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_REMEDIATION_BACKLOG_THRESHOLD = 5;
const DEFAULT_MERGE_STALLED_MAX_TICKS = 3;
const DEFAULT_PIPELINE_TICK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REMEDIATION_THROUGHPUT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_AMA_CLOSER_LEASE_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_RUNNING_REVIEWER_PASS_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_DAG_AUTOWALK_MAX_LOG_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DISPATCH_SPAWN_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LAUNCHD_TIMEOUT_MS = 2_000;
const DEFAULT_LABEL_PREFIX = 'ai.laceyenterprises';

const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  in_progress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
});

const REVIEW_PIPELINE_HEALTH_METRICS = Object.freeze([
  'review_pipeline_health_collector_up',
  'review_pipeline_outage_active',
  'review_pipeline_outage_attempts_not_charged',
  'review_pipeline_reviewer_attempts_total',
  'review_pipeline_failed_attempts_distinct_prs',
  'review_pipeline_reviewer_degradation_active',
  'review_pipeline_first_pass_queue_depth',
  'review_pipeline_first_pass_oldest_pending_age_seconds',
  'review_pipeline_remediation_backlog_jobs',
  'review_pipeline_remediation_oldest_pending_age_seconds',
  'review_pipeline_remediation_throughput_jobs',
  'review_pipeline_merge_outcomes_total',
  'review_pipeline_merge_stalled_jobs',
  'review_pipeline_stale_ama_closer_leases',
  'review_pipeline_zombie_reviewer_passes',
  'review_pipeline_round_budget_anomalies',
  'review_pipeline_launchd_service_up',
  'review_pipeline_dispatch_spawn_failures',
  'review_pipeline_dag_autowalk_healthy',
  'review_pipeline_sentinel_finding_active',
]);

const REVIEW_PIPELINE_HEALTH_METRIC_HELP = Object.freeze({
  review_pipeline_health_collector_up: 'Whether the collector could open the review-state ledger.',
  review_pipeline_outage_active: 'Whether review attempts are paused by an active outage signal.',
  review_pipeline_outage_attempts_not_charged: 'Current count of outage-transient reviewer failures that preserved the attempt budget.',
  review_pipeline_reviewer_attempts_total: 'Windowed reviewer attempt count by status, failure class, and pass kind.',
  review_pipeline_failed_attempts_distinct_prs: 'Windowed distinct PR count contributing failed reviewer attempts by failure class.',
  review_pipeline_reviewer_degradation_active: 'Active reviewer degradation/backoff PR count by failure class and state.',
  review_pipeline_first_pass_queue_depth: 'Current count of pending first-pass or rereview rows.',
  review_pipeline_first_pass_oldest_pending_age_seconds: 'Age in seconds of the oldest pending first-pass or rereview row.',
  review_pipeline_remediation_backlog_jobs: 'Current follow-up remediation job count by state.',
  review_pipeline_remediation_oldest_pending_age_seconds: 'Age in seconds of the oldest pending remediation job.',
  review_pipeline_remediation_throughput_jobs: 'Terminal remediation jobs observed in the configured throughput window.',
  review_pipeline_merge_outcomes_total: 'Current review-ledger PR outcome count by state.',
  review_pipeline_merge_stalled_jobs: 'Current count of clean review-settled jobs still waiting on merge.',
  review_pipeline_stale_ama_closer_leases: 'Current count of AMA closer leases stuck pending or dispatched past the configured age.',
  review_pipeline_zombie_reviewer_passes: 'Current count of reviewer_passes rows stuck running past the configured age.',
  review_pipeline_round_budget_anomalies: 'Current count of remediation jobs whose rounds exceed or misuse their risk-class budget.',
  review_pipeline_launchd_service_up: 'Whether required local pipeline launchd services are loaded.',
  review_pipeline_dispatch_spawn_failures: 'Recent dispatch daemon stderr lines matching closer/hammer spawn failure patterns.',
  review_pipeline_dag_autowalk_healthy: 'Whether the dag-autowalk LaunchAgent has a healthy exit/log recency state.',
  review_pipeline_sentinel_finding_active: 'Whether a Sentinel finding code is active in the current snapshot.',
});

const REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS = Object.freeze([
  {
    code: 'review:review_state_ledger_unreadable',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: null,
    defaultThreshold: null,
    thresholdDescription: 'reviews.db exists but cannot be opened read-only',
  },
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
    code: 'review:unknown_failure_rate_high',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'reviewUnknownRateThreshold',
    defaultThreshold: DEFAULT_REVIEW_UNKNOWN_RATE_THRESHOLD,
    windowKey: 'reviewUnknownRateWindowMs',
    defaultWindowMs: DEFAULT_REVIEW_UNKNOWN_RATE_WINDOW_MINUTES * 60 * 1000,
  },
  {
    code: 'review:reviewer_degradation_active',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: null,
    defaultThreshold: null,
    thresholdDescription: 'one or more PRs are currently held by provider overload or quota exhaustion',
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
  {
    code: 'review:ama_closer_lease_stale',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'amaCloserLeaseMaxAgeMs',
    defaultThreshold: DEFAULT_AMA_CLOSER_LEASE_MAX_AGE_MS,
  },
  {
    code: 'review:reviewer_pass_zombie',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'runningReviewerPassMaxAgeMs',
    defaultThreshold: DEFAULT_RUNNING_REVIEWER_PASS_MAX_AGE_MS,
  },
  {
    code: 'review:round_budget_anomaly',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: null,
    defaultThreshold: null,
    thresholdDescription: 'remediation round count exceeds the risk-class budget or final-pass awaiting-rereview persists after budget exhaustion',
  },
  {
    code: 'review:daemon_liveness',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: null,
    defaultThreshold: null,
    thresholdDescription: 'adversarial watcher, follow-up daemon, or dispatch daemon launchd service is not loaded',
  },
  {
    code: 'review:dispatch_spawn_failures',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'dispatchSpawnFailureWindowMs',
    defaultThreshold: DEFAULT_DISPATCH_SPAWN_FAILURE_WINDOW_MS,
  },
  {
    code: 'review:dag_autowalk_launchd_unhealthy',
    tier: 'page',
    category: 'review-pipeline',
    thresholdKey: 'dagAutowalkMaxLogAgeMs',
    defaultThreshold: DEFAULT_DAG_AUTOWALK_MAX_LOG_AGE_MS,
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

function parseIntegerAtLeast(value, fallback, min) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveReviewPipelineHealthConfig(env = process.env, overrides = {}) {
  return {
    hostChecksEnabled: parseBoolean(
      overrides.hostChecksEnabled
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS,
      false
    ),
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
    reviewUnknownRateThreshold: parseNumber(
      overrides.reviewUnknownRateThreshold
        ?? env.REVIEW_UNKNOWN_RATE_THRESHOLD,
      DEFAULT_REVIEW_UNKNOWN_RATE_THRESHOLD
    ),
    reviewUnknownRateWindowMinutes: parsePositiveInteger(
      overrides.reviewUnknownRateWindowMinutes
        ?? env.REVIEW_UNKNOWN_RATE_WINDOW_MINUTES,
      DEFAULT_REVIEW_UNKNOWN_RATE_WINDOW_MINUTES
    ),
    reviewUnknownRateSampleFloor: parseIntegerAtLeast(
      overrides.reviewUnknownRateSampleFloor
        ?? env.REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR,
      DEFAULT_REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR,
      MIN_REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR
    ),
    reviewUnknownRateDistinctPrFloor: parseIntegerAtLeast(
      overrides.reviewUnknownRateDistinctPrFloor
        ?? env.REVIEW_UNKNOWN_RATE_DISTINCT_PR_FLOOR,
      DEFAULT_REVIEW_UNKNOWN_RATE_DISTINCT_PR_FLOOR,
      1
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
    amaCloserLeaseMaxAgeMs: parsePositiveInteger(
      overrides.amaCloserLeaseMaxAgeMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_AMA_CLOSER_LEASE_MAX_AGE_MS,
      DEFAULT_AMA_CLOSER_LEASE_MAX_AGE_MS
    ),
    runningReviewerPassMaxAgeMs: parsePositiveInteger(
      overrides.runningReviewerPassMaxAgeMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_RUNNING_REVIEWER_PASS_MAX_AGE_MS,
      DEFAULT_RUNNING_REVIEWER_PASS_MAX_AGE_MS
    ),
    dagAutowalkMaxLogAgeMs: parsePositiveInteger(
      overrides.dagAutowalkMaxLogAgeMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_MAX_LOG_AGE_MS,
      DEFAULT_DAG_AUTOWALK_MAX_LOG_AGE_MS
    ),
    dispatchSpawnFailureWindowMs: parsePositiveInteger(
      overrides.dispatchSpawnFailureWindowMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DISPATCH_SPAWN_FAILURE_WINDOW_MS,
      DEFAULT_DISPATCH_SPAWN_FAILURE_WINDOW_MS
    ),
    launchdTimeoutMs: parsePositiveInteger(
      overrides.launchdTimeoutMs
        ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_LAUNCHD_TIMEOUT_MS,
      DEFAULT_LAUNCHD_TIMEOUT_MS
    ),
    get reviewUnknownRateWindowMs() {
      return this.reviewUnknownRateWindowMinutes * 60 * 1000;
    },
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
  if (
    text.includes(QUOTA_EXHAUSTED_FAILURE_CLASS) ||
    text.includes('usage cap') ||
    text.includes('usage limit')
  ) return QUOTA_EXHAUSTED_FAILURE_CLASS;
  if (
    text.includes(PROVIDER_OVERLOADED_FAILURE_CLASS) ||
    /\b529\b/.test(text) ||
    /\boverloaded[_ -]?error\b/.test(text) ||
    /\boverloaded\b[\s\S]{0,160}\b(provider|model|backend|upstream|server|service|api)\b/.test(text) ||
    /\b(provider|model|backend|upstream|server|service|api)\b[\s\S]{0,160}\boverloaded\b/.test(text)
  ) return PROVIDER_OVERLOADED_FAILURE_CLASS;
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
  return classifyFailure(
    metadata.failureClass
    || metadata.failure_class
    || metadata.errorClass
    || metadata.error_class
    || metadata.failureCode
    || metadata.failure_code
    || metadata.failureMessage
    || metadata.message
    || metadata.error
    || row?.status
  );
}

function isMissingSchemaError(error) {
  const message = String(error?.message || '');
  return error?.code === 'SQLITE_ERROR'
    && (message.includes('no such table') || message.includes('no such column'));
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

function openReviewStateReadOnlyDb(rootDir) {
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(dbPath)) {
    return {
      db: null,
      status: { path: dbPath, exists: false, readable: false, error: 'missing' },
    };
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = 1');
    return {
      db,
      status: { path: dbPath, exists: true, readable: true, error: null },
    };
  } catch (error) {
    return {
      db: null,
      status: {
        path: dbPath,
        exists: true,
        readable: false,
        error: error?.code || error?.message || 'open-failed',
      },
    };
  }
}

function summarizeReviewerAttempts(db, { nowMs, config }) {
  const cutoff = new Date(nowMs - config.reviewerDeathRateWindowMs).toISOString();
  const unknownRateCutoff = new Date(nowMs - config.reviewUnknownRateWindowMs).toISOString();
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, pass_kind, status, started_at, ended_at, metadata_json
       FROM reviewer_passes
      WHERE started_at >= ?
        AND pass_kind IN ('first-pass', 'rereview')`,
    [cutoff]
  );

  const attempts = new Map();
  let total = 0;
  let settled = 0;
  let failed = 0;
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
      failed += 1;
      settled += 1;
      failuresByClass.set(failureClass, (failuresByClass.get(failureClass) || 0) + 1);
    } else if (row.status === 'completed') {
      settled += 1;
    }
  }

  if (total === 0) {
    const fallbackRows = safeAll(
      db,
      `SELECT repo, pr_number, review_status, failure_message, last_attempted_at, failed_at
         FROM reviewed_prs
        WHERE last_attempted_at >= ?
           OR failed_at >= ?`,
      [cutoff, cutoff]
    );
    for (const row of fallbackRows) {
      total += 1;
      const rowFailed = row.review_status === 'failed' || row.review_status === 'failed-orphan';
      const failureClass = rowFailed ? classifyFailure(row.failure_message || row.review_status) : 'none';
      const key = JSON.stringify({
        status: rowFailed ? 'failed' : row.review_status || 'unknown',
        failure_class: failureClass,
        pass_kind: 'first-pass',
      });
      attempts.set(key, (attempts.get(key) || 0) + 1);
      if (rowFailed) {
        failuresByClass.set(failureClass, (failuresByClass.get(failureClass) || 0) + 1);
      }
    }
    failed = fallbackRows.filter((row) => row.review_status === 'failed' || row.review_status === 'failed-orphan').length;
    settled = fallbackRows.filter((row) => (
      row.review_status === 'posted'
      || row.review_status === 'failed'
      || row.review_status === 'failed-orphan'
    )).length;
  }

  const unknownWindowRows = safeAll(
    db,
    `SELECT repo, pr_number, metadata_json
       FROM reviewer_passes
      WHERE started_at >= ?
        AND status = 'failed'
        AND pass_kind IN ('first-pass', 'rereview')`,
    [unknownRateCutoff]
  );
  let unknownWindowFailed = 0;
  const unknownWindowDistinctPrsByClass = new Map();
  const unknownWindowDistinctPrs = new Set();
  for (const row of unknownWindowRows) {
    const failureClass = failureClassForPass(row);
    if (!unknownWindowDistinctPrsByClass.has(failureClass)) unknownWindowDistinctPrsByClass.set(failureClass, new Set());
    unknownWindowDistinctPrsByClass.get(failureClass).add(`${row.repo}#${row.pr_number}`);
    if (failureClass === 'unknown') {
      unknownWindowFailed += 1;
      unknownWindowDistinctPrs.add(`${row.repo}#${row.pr_number}`);
    }
  }
  const totalWindowFailures = unknownWindowRows.length;

  return {
    total,
    settled,
    failed,
    failureRatio: settled > 0 ? failed / settled : 0,
    attempts: Array.from(attempts, ([key, value]) => ({ ...JSON.parse(key), value })),
    failureRatios: Array.from(failuresByClass, ([failureClass, failed]) => ({
      failureClass,
      failed,
      attempted: settled,
      ratio: settled > 0 ? failed / settled : 0,
    })),
    failedDistinctPrs: Array.from(unknownWindowDistinctPrsByClass, ([failureClass, prKeys]) => ({
      failureClass,
      distinctPrs: prKeys.size,
    })),
    unknownRateWindow: {
      failed: unknownWindowFailed,
      totalFailures: totalWindowFailures,
      ratio: totalWindowFailures > 0 ? unknownWindowFailed / totalWindowFailures : 0,
      distinctPrs: unknownWindowDistinctPrs.size,
      windowMs: config.reviewUnknownRateWindowMs,
    },
  };
}

function decodeCascadeStateRepo(encodedRepo) {
  try {
    return decodeURIComponent(encodedRepo);
  } catch {
    return encodedRepo;
  }
}

function parseCascadeStateIdentity(fileName) {
  if (!fileName.endsWith('.json')) return null;
  const stem = fileName.slice(0, -'.json'.length);
  const separator = stem.lastIndexOf('__');
  if (separator <= 0) return null;
  const prNumber = Number(stem.slice(separator + 2));
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return {
    repo: decodeCascadeStateRepo(stem.slice(0, separator)),
    prNumber,
  };
}

function readActiveTransientBackoffs(rootDir, { nowMs }) {
  const stateDir = join(rootDir, 'data', 'cascade-state');
  if (!existsSync(stateDir)) return [];
  const entries = [];
  for (const fileName of readdirSync(stateDir)) {
    const identity = parseCascadeStateIdentity(fileName);
    if (!identity) continue;
    const filePath = join(stateDir, fileName);
    let state;
    try {
      state = parseJson(readFileSync(filePath, 'utf8'), null);
    } catch {
      continue;
    }
    if (!state) continue;
    const nextRetryRaw = state.nextRetryAfter;
    if (!nextRetryRaw) continue;
    const nextRetryMs = Date.parse(nextRetryRaw);
    if (Number.isNaN(nextRetryMs) || nextRetryMs <= nowMs) continue;
    const failureClass = String(state.lastFailureClass || 'cascade').trim() || 'cascade';
    entries.push({
      ...identity,
      failureClass,
      state: 'transient-backoff',
      since: state.lastFailureAt || null,
      retryAfter: new Date(nextRetryMs).toISOString(),
      source: 'cascade-state',
      consecutiveTransientFailures: Number(state.consecutiveTransientFailures ?? state.consecutiveCascadeFailures ?? 0),
      transientFailureBreakdown: state.transientFailureBreakdown || {},
    });
  }
  return entries;
}

function readActiveQuotaHolds(db, { nowMs }) {
  if (!db) return [];
  const rows = safeAll(
    db,
    `SELECT repo,
            pr_number,
            review_status,
            pr_state,
            failed_at,
            last_attempted_at,
            failure_message,
            quota_reset_at_utc,
            infra_auto_recover_attempts
       FROM reviewed_prs
      WHERE review_status = 'failed'
        AND COALESCE(pr_state, 'open') = 'open'
        AND lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%'`
  );
  const entries = [];
  for (const row of rows) {
    const hold = quotaHoldDecision(row, { nowMs });
    if (!hold.hold) continue;
    entries.push({
      repo: row.repo,
      prNumber: row.pr_number,
      failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
      state: 'quota-hold',
      since: row.failed_at || row.last_attempted_at || null,
      retryAfter: new Date(hold.waitUntilMs).toISOString(),
      source: hold.source,
      infraAutoRecoverAttempts: Number(row.infra_auto_recover_attempts || 0),
    });
  }
  return entries;
}

function readOutageTransientRows(db) {
  if (!db) return [];
  return safeAll(
    db,
    `SELECT repo,
            pr_number,
            review_status,
            pr_state,
            failed_at,
            last_attempted_at,
            failure_message,
            quota_reset_at_utc,
            review_attempts
       FROM reviewed_prs
      WHERE COALESCE(pr_state, 'open') = 'open'
        AND review_status IN ('pending', 'pending-upstream')
        AND lower(COALESCE(failure_message, '')) LIKE '[outage-transient:%'`
  );
}

function outageReasonFromMessage(message) {
  const match = String(message || '').match(/^\[outage-transient:([^\]]+)\]/i);
  return match?.[1] || 'unknown';
}

function summarizeOutage(db) {
  const rows = readOutageTransientRows(db);
  const reasons = new Map();
  const examples = [];
  for (const row of rows) {
    const reason = outageReasonFromMessage(row.failure_message);
    reasons.set(reason, Number(reasons.get(reason) || 0) + 1);
    if (examples.length < 5) {
      examples.push({
        repo: row.repo,
        prNumber: row.pr_number,
        reason,
        reviewStatus: row.review_status,
        since: row.failed_at || row.last_attempted_at || null,
        reviewAttempts: Number(row.review_attempts || 0),
      });
    }
  }
  const active = rows.length > 0;
  return {
    active,
    reason: rows.length === 0 ? null : (reasons.size === 1 ? Array.from(reasons.keys())[0] : 'multiple'),
    reviews_paused: rows.length > 0,
    attempts_not_charged: rows.length,
    reasons: Array.from(reasons, ([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
    examples,
  };
}

function summarizeReviewerDegradation(rootDir, db, { nowMs }) {
  const entries = [
    ...readActiveTransientBackoffs(rootDir, { nowMs }),
    ...readActiveQuotaHolds(db, { nowMs }),
  ].sort((left, right) => (
    String(left.failureClass).localeCompare(String(right.failureClass)) ||
    String(left.repo).localeCompare(String(right.repo)) ||
    Number(left.prNumber) - Number(right.prNumber)
  ));
  const byClass = new Map();
  for (const entry of entries) {
    const failureClass = entry.failureClass || 'unknown';
    if (!byClass.has(failureClass)) {
      byClass.set(failureClass, {
        failureClass,
        active: 0,
        states: {},
        earliestRetryAfter: null,
        latestRetryAfter: null,
        examples: [],
      });
    }
    const summary = byClass.get(failureClass);
    summary.active += 1;
    summary.states[entry.state] = Number(summary.states[entry.state] || 0) + 1;
    const retryAfterMs = Date.parse(entry.retryAfter || '');
    if (!Number.isNaN(retryAfterMs)) {
      const retryAfterIso = new Date(retryAfterMs).toISOString();
      const earliestMs = Date.parse(summary.earliestRetryAfter || '');
      const latestMs = Date.parse(summary.latestRetryAfter || '');
      if (Number.isNaN(earliestMs) || retryAfterMs < earliestMs) {
        summary.earliestRetryAfter = retryAfterIso;
      }
      if (Number.isNaN(latestMs) || retryAfterMs > latestMs) {
        summary.latestRetryAfter = retryAfterIso;
      }
    }
    if (summary.examples.length < 5) {
      summary.examples.push({
        repo: entry.repo,
        prNumber: entry.prNumber,
        state: entry.state,
        retryAfter: entry.retryAfter,
        source: entry.source,
      });
    }
  }
  return {
    active: entries.length,
    byClass: Array.from(byClass.values()).sort((left, right) => left.failureClass.localeCompare(right.failureClass)),
    entries,
  };
}

function summarizeFirstPassQueue(db, { nowMs }) {
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, reviewed_at, rereview_requested_at, last_attempted_at
       FROM reviewed_prs
      WHERE pr_state = 'open'
        AND review_status = 'pending'`
  );
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
  const rows = safeAll(
    db,
    `SELECT COALESCE(pr_state, 'unknown') AS outcome, COUNT(*) AS count
       FROM reviewed_prs
      GROUP BY COALESCE(pr_state, 'unknown')`
  );
  return rows.map((row) => ({ outcome: row.outcome, count: row.count }));
}

function readFollowUpJobs(rootDir) {
  const jobs = [];
  for (const [state, parts] of Object.entries(FOLLOW_UP_JOB_DIRS)) {
    const dir = join(rootDir, ...parts);
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
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
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, pr_state, merged_at, closed_at, labels_json
       FROM reviewed_prs`
  );
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
    if (!reviewRow || reviewRow.pr_state !== 'open') continue;
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

function readAmaCloserLeases(rootDir, { nowMs, config }) {
  const dir = join(rootDir, 'data', 'ama-closer-leases');
  const stale = [];
  let total = 0;
  if (!existsSync(dir)) return { total, stale };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { total, stale };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const leasePath = join(dir, name);
    let stat;
    let lease;
    try {
      stat = statSync(leasePath);
      lease = parseJson(readFileSync(leasePath, 'utf8'), null);
    } catch {
      continue;
    }
    if (!lease) continue;
    total += 1;
    const status = String(lease.status || '').trim();
    if (!['pending', 'dispatched'].includes(status)) continue;
    if (lease.terminalOutcome !== null && lease.terminalOutcome !== undefined) continue;
    const anchor = lease.updatedAt || lease.acquiredAt || new Date(stat.mtimeMs).toISOString();
    const staleMs = ageMs(nowMs, anchor);
    if (staleMs === null || staleMs <= config.amaCloserLeaseMaxAgeMs) continue;
    stale.push({
      leasePath,
      repo: lease.repo || null,
      prNumber: lease.prNumber || null,
      headSha: lease.headSha || null,
      lrqId: lease.lrqId || null,
      status,
      acquiredAt: lease.acquiredAt || null,
      updatedAt: lease.updatedAt || null,
      ageMs: staleMs,
      thresholdMs: config.amaCloserLeaseMaxAgeMs,
    });
  }
  return { total, stale };
}

function summarizeZombieReviewerPasses(db, { nowMs, config }) {
  const cutoff = new Date(nowMs - config.runningReviewerPassMaxAgeMs).toISOString();
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, attempt_number, pass_kind, reviewer_class, started_at, metadata_json
       FROM reviewer_passes
      WHERE status = 'running'
        AND started_at < ?
      ORDER BY started_at ASC`,
    [cutoff]
  );
  return {
    thresholdMs: config.runningReviewerPassMaxAgeMs,
    rows: rows.map((row) => ({
      repo: row.repo,
      prNumber: row.pr_number,
      attemptNumber: row.attempt_number,
      passKind: row.pass_kind,
      reviewerClass: row.reviewer_class,
      startedAt: row.started_at,
      ageMs: ageMs(nowMs, row.started_at),
      metadata: parseJson(row.metadata_json, {}),
    })),
  };
}

function normalizeRiskClassForBudget(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUND_BUDGET_BY_RISK_CLASS, normalized) ? normalized : 'medium';
}

function roundNumbersForJob(job) {
  const numbers = [];
  const currentRound = Number(job?.remediationPlan?.currentRound ?? job?.currentRound);
  if (Number.isInteger(currentRound) && currentRound > 0) numbers.push(currentRound);
  for (const round of job?.remediationPlan?.rounds || []) {
    const value = Number(round?.round);
    if (Number.isInteger(value) && value > 0) numbers.push(value);
  }
  return numbers;
}

function isAwaitingRereviewJob(job) {
  const texts = [
    job?.status,
    job?.completion?.status,
    job?.remediationReply?.status,
    job?.remediationPlan?.nextAction?.type,
    job?.remediationPlan?.nextAction?.status,
    job?.remediationPlan?.state,
  ].map((value) => String(value || '').toLowerCase());
  return texts.some((text) => text.includes('awaiting-rereview'));
}

function summarizeRoundBudgetAnomalies(followUpJobs) {
  const anomalies = [];
  for (const entry of followUpJobs) {
    const job = entry.job || {};
    const repo = job.repo || null;
    const prNumber = Number(job.prNumber);
    if (!repo || !Number.isInteger(prNumber)) continue;
    const riskClass = normalizeRiskClassForBudget(job.riskClass);
    const budget = ROUND_BUDGET_BY_RISK_CLASS[riskClass];
    const rounds = roundNumbersForJob(job);
    const highestRound = rounds.length ? Math.max(...rounds) : 0;
    const consumedRounds = rounds.length;
    const awaitingRereview = isAwaitingRereviewJob(job);
    const codes = [];
    if (highestRound > budget || consumedRounds > budget) codes.push('round-count-exceeds-risk-budget');
    if (awaitingRereview && highestRound >= budget) codes.push('awaiting-rereview-on-budget-exhausted-final-pass');
    if (!codes.length) continue;
    anomalies.push({
      repo,
      prNumber,
      jobId: job.jobId || null,
      state: entry.state,
      riskClass,
      budget,
      highestRound,
      consumedRounds,
      awaitingRereview,
      codes,
      jobPath: entry.jobPath,
    });
  }
  return { anomalies };
}

function launchdPrint(label, { timeoutMs, execFileSyncImpl = execFileSync } = {}) {
  try {
    const stdout = execFileSyncImpl('launchctl', ['print', `gui/${process.getuid?.()}/${label}`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { label, loaded: true, raw: stdout, error: null };
  } catch (error) {
    return {
      label,
      loaded: false,
      raw: String(error?.stdout || error?.stderr || ''),
      error: error?.message || 'launchctl-print-failed',
    };
  }
}

function parseLaunchdLastExit(raw) {
  const text = String(raw || '');
  const match = text.match(/(?:last exit code|LastExitStatus|last exit status)\s*[:=]\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function currentUserName(env = process.env) {
  return env.USER || env.LOGNAME || userInfo().username;
}

function launchdLabelSet(env = process.env) {
  const labelPrefix = env.AGENT_OS_LAUNCHD_LABEL_PREFIX || DEFAULT_LABEL_PREFIX;
  const owner = env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_OWNER_USER || currentUserName(env);
  return {
    owner,
    watcher: env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_WATCHER_LABEL || `${labelPrefix}.adversarial-watcher.${owner}`,
    followUp: env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL || `${labelPrefix}.adversarial-follow-up.${owner}`,
    dispatchDaemon: env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DISPATCH_DAEMON_LABEL || `${labelPrefix}.cwp-dispatch-daemon.${owner}`,
    dagAutowalk: env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_LABEL || `${labelPrefix}.dag-autowalk.${owner}`,
  };
}

function summarizeLaunchdServices({ env, config, execFileSyncImpl }) {
  const labels = launchdLabelSet(env);
  const serviceEntries = [
    ['adversarial-watcher', labels.watcher],
    ['adversarial-follow-up', labels.followUp],
    ['cwp-dispatch-daemon', labels.dispatchDaemon],
  ];
  const services = serviceEntries.map(([name, label]) => ({
    name,
    ...launchdPrint(label, { timeoutMs: config.launchdTimeoutMs, execFileSyncImpl }),
  }));
  const dag = launchdPrint(labels.dagAutowalk, { timeoutMs: config.launchdTimeoutMs, execFileSyncImpl });
  return {
    owner: labels.owner,
    services,
    dagAutowalk: {
      ...dag,
      lastExitCode: parseLaunchdLastExit(dag.raw),
    },
  };
}

function tailRecentLines(path, maxBytes = 64 * 1024) {
  if (!existsSync(path)) return { path, exists: false, lines: [], mtimeMs: null };
  const stat = statSync(path);
  const raw = readFileSync(path, { encoding: 'utf8' });
  const sliced = raw.length > maxBytes ? raw.slice(raw.length - maxBytes) : raw;
  return {
    path,
    exists: true,
    lines: sliced.split(/\r?\n/).filter((line) => line.trim()),
    mtimeMs: stat.mtimeMs,
  };
}

function dispatchSpawnFailurePattern() {
  return /(entitlement-auth|rate[- ]?limit|403|exit\s+65|spawn[\s\S]{0,120}(hammer|closer|ama|merge-agent)|(hammer|closer|ama|merge-agent)[\s\S]{0,120}(spawn|failed|exit))/i;
}

function summarizeDispatchSpawnFailures(hqRoot, { nowMs, config }) {
  const logPath = join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  const log = tailRecentLines(logPath);
  const pattern = dispatchSpawnFailurePattern();
  const matches = [];
  if (log.exists) {
    for (const line of log.lines) {
      if (!pattern.test(line)) continue;
      matches.push(line.slice(0, 800));
    }
  }
  const logAgeMs = log.mtimeMs === null ? null : Math.max(0, nowMs - log.mtimeMs);
  return {
    logPath,
    logExists: log.exists,
    logAgeMs,
    windowMs: config.dispatchSpawnFailureWindowMs,
    matches: logAgeMs !== null && logAgeMs <= config.dispatchSpawnFailureWindowMs ? matches.slice(-20) : [],
  };
}

function summarizeDagAutowalkHealth({ env, hqRoot, nowMs, config, launchd }) {
  const owner = launchd.owner;
  const defaultErrLog = join(homedir(), 'Library', 'Logs', `${DEFAULT_LABEL_PREFIX}.dag-autowalk.${owner}.tick.err.log`);
  const defaultOutLog = join(homedir(), 'Library', 'Logs', `${DEFAULT_LABEL_PREFIX}.dag-autowalk.${owner}.tick.out.log`);
  const errLogPath = env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_ERR_LOG || defaultErrLog;
  const outLogPath = env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_OUT_LOG || defaultOutLog;
  const err = tailRecentLines(errLogPath, 16 * 1024);
  const out = tailRecentLines(outLogPath, 16 * 1024);
  const freshestMtime = Math.max(err.mtimeMs || 0, out.mtimeMs || 0);
  const logAgeMs = freshestMtime > 0 ? Math.max(0, nowMs - freshestMtime) : null;
  const healthy = launchd.dagAutowalk.loaded
    && (launchd.dagAutowalk.lastExitCode === null || launchd.dagAutowalk.lastExitCode === 0)
    && logAgeMs !== null
    && logAgeMs <= config.dagAutowalkMaxLogAgeMs;
  return {
    hqRoot,
    label: launchd.dagAutowalk.label,
    loaded: launchd.dagAutowalk.loaded,
    lastExitCode: launchd.dagAutowalk.lastExitCode,
    errLogPath,
    outLogPath,
    logAgeMs,
    thresholdMs: config.dagAutowalkMaxLogAgeMs,
    healthy,
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

  if (
    snapshot.reviewStateLedger?.exists === true
    && snapshot.reviewStateLedger?.readable !== true
  ) {
    findings.push(buildFinding({
      code: 'review:review_state_ledger_unreadable',
      tier: 'page',
      subject: 'Review-state ledger exists but pipeline-health cannot open it',
      message: `reviews.db at ${snapshot.reviewStateLedger.path} is unreadable: ${snapshot.reviewStateLedger.error || 'open-failed'}.`,
      evidence: [snapshot.reviewStateLedger.path],
      recommendedAction: 'Confirm data/reviews.db is a regular file with read access for the collector identity; inspect details.error for sqlite-side corruption before retrying.',
      observedAt,
      details: {
        ...snapshot.reviewStateLedger,
      },
    }));
  }

  if (
    snapshot.reviewer.settled >= config.reviewerDeathRateMinAttempts
    && snapshot.reviewer.failureRatio > config.reviewerDeathRateThreshold
  ) {
    findings.push(buildFinding({
      code: 'review:reviewer_death_rate_high',
      tier: 'page',
      subject: `Reviewer failures are ${Math.round(snapshot.reviewer.failureRatio * 100)}% of recent settled attempts`,
      message: `${snapshot.reviewer.failed}/${snapshot.reviewer.settled} completed or failed reviewer attempts ended in failure.`,
      evidence: [`reviews.db reviewer_passes window=${config.reviewerDeathRateWindowMs}ms`],
      recommendedAction: 'Inspect reviewer_passes metadata and the watcher logs for the failure breakdown before the queue starves.',
      observedAt,
      details: {
        failed: snapshot.reviewer.failed,
        attempted: snapshot.reviewer.settled,
        ratio: snapshot.reviewer.failureRatio,
        excludedStatuses: ['running', 'cancelled'],
        failureRatios: snapshot.reviewer.failureRatios,
      },
    }));
  }

  if (
    snapshot.reviewer.unknownRateWindow.totalFailures >= config.reviewUnknownRateSampleFloor
    && snapshot.reviewer.unknownRateWindow.distinctPrs >= config.reviewUnknownRateDistinctPrFloor
    && snapshot.reviewer.unknownRateWindow.ratio > config.reviewUnknownRateThreshold
  ) {
    findings.push(buildFinding({
      code: 'review:unknown_failure_rate_high',
      tier: 'page',
      subject: `Unknown-classified failures are ${Math.round(snapshot.reviewer.unknownRateWindow.ratio * 100)}% of recent reviewer failures`,
      message: `${snapshot.reviewer.unknownRateWindow.failed}/${snapshot.reviewer.unknownRateWindow.totalFailures} failures in the last ${config.reviewUnknownRateWindowMinutes} minute(s) were classified unknown across ${snapshot.reviewer.unknownRateWindow.distinctPrs} distinct PR(s).`,
      evidence: [
        `reviews.db reviewer_passes window=${config.reviewUnknownRateWindowMs}ms`,
        `unknown failures=${snapshot.reviewer.unknownRateWindow.failed}/${snapshot.reviewer.unknownRateWindow.totalFailures}`,
      ],
      recommendedAction: 'Inspect the unknown-class reviewer failures and recent classifier misses before retries accumulate behind a blind spot.',
      observedAt,
      details: {
        failed: snapshot.reviewer.unknownRateWindow.failed,
        totalFailures: snapshot.reviewer.unknownRateWindow.totalFailures,
        ratio: snapshot.reviewer.unknownRateWindow.ratio,
        distinctPrs: snapshot.reviewer.unknownRateWindow.distinctPrs,
        threshold: config.reviewUnknownRateThreshold,
        sampleFloor: config.reviewUnknownRateSampleFloor,
        distinctPrFloor: config.reviewUnknownRateDistinctPrFloor,
        windowMs: config.reviewUnknownRateWindowMs,
      },
    }));
  }

  const surfacedReviewerDegradationEntries = snapshot.reviewerDegradation.entries.filter((entry) => (
    entry.failureClass === PROVIDER_OVERLOADED_FAILURE_CLASS ||
    entry.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS
  ));
  if (surfacedReviewerDegradationEntries.length > 0) {
    const surfacedClassSet = new Set(surfacedReviewerDegradationEntries.map((entry) => entry.failureClass));
    const surfacedByClass = snapshot.reviewerDegradation.byClass
      .filter((row) => surfacedClassSet.has(row.failureClass));
    const classSummary = surfacedByClass
      .map((row) => `${row.failureClass}=${row.active}`)
      .join(', ');
    findings.push(buildFinding({
      code: 'review:reviewer_degradation_active',
      tier: 'page',
      subject: `Reviewer lane has ${surfacedReviewerDegradationEntries.length} active provider degradation hold(s)`,
      message: `Active reviewer degradation classes: ${classSummary}.`,
      evidence: surfacedReviewerDegradationEntries.map((entry) => (
        `${entry.repo}#${entry.prNumber} ${entry.failureClass}/${entry.state} retryAfter=${entry.retryAfter || 'unknown'}`
      )),
      recommendedAction: 'Inspect failure_class and state: provider-overloaded means HTTP 529/backend capacity short backoff; quota-exhausted means hold until retryAfter or route around the capped reviewer.',
      observedAt,
      details: {
        active: surfacedReviewerDegradationEntries.length,
        byClass: surfacedByClass,
        entries: surfacedReviewerDegradationEntries,
      },
    }));
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

  if (snapshot.amaCloserLeases.stale.length > 0) {
    const sample = snapshot.amaCloserLeases.stale[0];
    findings.push(buildFinding({
      code: 'review:ama_closer_lease_stale',
      tier: 'page',
      subject: `${snapshot.amaCloserLeases.stale.length} AMA closer lease(s) are stale`,
      message: `${sample.repo || 'unknown'}#${sample.prNumber || 'unknown'} has a ${sample.status} closer lease older than ${Math.round(sample.thresholdMs / 60000)} minute(s).`,
      evidence: snapshot.amaCloserLeases.stale.map((lease) => `${lease.leasePath} status=${lease.status} lrq=${lease.lrqId || 'none'}`),
      recommendedAction: 'Inspect the AMA closer dispatch/audit records and merge-agent lane before manually clearing any lease.',
      observedAt,
      details: {
        thresholdMs: config.amaCloserLeaseMaxAgeMs,
        stale: snapshot.amaCloserLeases.stale,
      },
    }));
  }

  if (snapshot.zombieReviewerPasses.rows.length > 0) {
    const sample = snapshot.zombieReviewerPasses.rows[0];
    findings.push(buildFinding({
      code: 'review:reviewer_pass_zombie',
      tier: 'page',
      subject: `${snapshot.zombieReviewerPasses.rows.length} reviewer pass(es) are still running past the threshold`,
      message: `${sample.repo}#${sample.prNumber} attempt ${sample.attemptNumber} has been running since ${sample.startedAt}.`,
      evidence: snapshot.zombieReviewerPasses.rows.map((row) => (
        `reviews.db reviewer_passes ${row.repo}#${row.prNumber} attempt=${row.attemptNumber} pass=${row.passKind}`
      )),
      recommendedAction: 'Compare reviewer_passes rows with watcher process/session evidence; repair through the documented adversarial-review recovery path only after preserving logs.',
      observedAt,
      details: snapshot.zombieReviewerPasses,
    }));
  }

  if (snapshot.roundBudget.anomalies.length > 0) {
    const sample = snapshot.roundBudget.anomalies[0];
    findings.push(buildFinding({
      code: 'review:round_budget_anomaly',
      tier: 'page',
      subject: `${snapshot.roundBudget.anomalies.length} remediation job(s) violate the risk-class round budget`,
      message: `${sample.repo}#${sample.prNumber} has round=${sample.highestRound} budget=${sample.budget} risk=${sample.riskClass}.`,
      evidence: snapshot.roundBudget.anomalies.map((row) => (
        `${row.jobPath} ${row.codes.join(',')} round=${row.highestRound} budget=${row.budget}`
      )),
      recommendedAction: 'Inspect the follow-up job and merge-agent prompt path for the final-pass awaiting-rereview bug class before requeueing.',
      observedAt,
      details: snapshot.roundBudget,
    }));
  }

  const downServices = snapshot.launchd.services.filter((service) => !service.loaded);
  if (downServices.length > 0) {
    findings.push(buildFinding({
      code: 'review:daemon_liveness',
      tier: 'page',
      subject: `${downServices.length} pipeline daemon launchd service(s) are not loaded`,
      message: downServices.map((service) => `${service.name} (${service.label})`).join(', '),
      evidence: downServices.map((service) => service.label),
      recommendedAction: 'Use launchctl print and the service runbook to inspect the owner-scoped LaunchAgent; avoid repair commands until the owner and restart path are confirmed.',
      observedAt,
      details: {
        owner: snapshot.launchd.owner,
        services: snapshot.launchd.services,
      },
    }));
  }

  if (snapshot.dispatchSpawnFailures.matches.length > 0) {
    findings.push(buildFinding({
      code: 'review:dispatch_spawn_failures',
      tier: 'page',
      subject: `${snapshot.dispatchSpawnFailures.matches.length} recent dispatch daemon spawn-failure log line(s) matched`,
      message: `Dispatch daemon stderr contains recent closer/hammer spawn failure signals in ${snapshot.dispatchSpawnFailures.logPath}.`,
      evidence: snapshot.dispatchSpawnFailures.matches.slice(-10),
      recommendedAction: 'Inspect the dispatch daemon error log for entitlement-auth, rate-limit 403, or exit 65 before launching new closer/remediation work.',
      observedAt,
      details: snapshot.dispatchSpawnFailures,
    }));
  }

  if (!snapshot.dagAutowalk.healthy) {
    findings.push(buildFinding({
      code: 'review:dag_autowalk_launchd_unhealthy',
      tier: 'page',
      subject: 'dag-autowalk LaunchAgent is not healthy',
      message: `dag-autowalk loaded=${snapshot.dagAutowalk.loaded} lastExit=${snapshot.dagAutowalk.lastExitCode ?? 'unknown'} logAgeMs=${snapshot.dagAutowalk.logAgeMs ?? 'unknown'}.`,
      evidence: [snapshot.dagAutowalk.label, snapshot.dagAutowalk.errLogPath, snapshot.dagAutowalk.outLogPath],
      recommendedAction: 'Check dag-autowalk launchd state and recent logs; this is the post-merge DAG advancement backstop.',
      observedAt,
      details: snapshot.dagAutowalk,
    }));
  }

  return findings;
}

function collectReviewPipelineHealth({
  rootDir = process.cwd(),
  hqRoot = process.env.HQ_ROOT || join(homedir(), 'agent-os-hq'),
  now = () => new Date(),
  env = process.env,
  config: configOverrides = {},
  execFileSyncImpl = execFileSync,
} = {}) {
  const observedAt = toIso(now);
  const nowMs = Date.parse(observedAt);
  const config = resolveReviewPipelineHealthConfig(env, configOverrides);
  const { db, status: reviewStateLedger } = openReviewStateReadOnlyDb(rootDir);
  try {
    const reviewer = db
      ? summarizeReviewerAttempts(db, { nowMs, config })
      : {
          total: 0,
          settled: 0,
          failed: 0,
          failureRatio: 0,
          attempts: [],
          failureRatios: [],
          failedDistinctPrs: [],
          unknownRateWindow: {
            failed: 0,
            totalFailures: 0,
            ratio: 0,
            distinctPrs: 0,
            windowMs: config.reviewUnknownRateWindowMs,
          },
        };
    const firstPassQueue = db
      ? summarizeFirstPassQueue(db, { nowMs })
      : { depth: 0, oldest: null };
    const followUpQueues = summarizeFollowUpQueues(rootDir, { nowMs, config });
    const reviewerDegradation = summarizeReviewerDegradation(rootDir, db, { nowMs });
    const outage = db
      ? summarizeOutage(db)
      : {
          active: false,
          reason: null,
          reviews_paused: false,
          attempts_not_charged: 0,
          reasons: [],
          examples: [],
        };
    const mergeOutcomes = db ? summarizeMergeOutcomes(db) : [];
    const mergeStalls = summarizeMergeStalls({
      followUpJobs: followUpQueues.jobs,
      reviewRows: db ? reviewRowsByRepoPr(db) : new Map(),
      nowMs,
      config,
    });
    const amaCloserLeases = readAmaCloserLeases(rootDir, { nowMs, config });
    const zombieReviewerPasses = db
      ? summarizeZombieReviewerPasses(db, { nowMs, config })
      : { thresholdMs: config.runningReviewerPassMaxAgeMs, rows: [] };
    const roundBudget = summarizeRoundBudgetAnomalies(followUpQueues.jobs);
    const launchd = config.hostChecksEnabled
      ? summarizeLaunchdServices({ env, config, execFileSyncImpl })
      : { owner: currentUserName(env), services: [], dagAutowalk: { label: null, loaded: true, lastExitCode: 0 } };
    const dispatchSpawnFailures = config.hostChecksEnabled
      ? summarizeDispatchSpawnFailures(hqRoot, { nowMs, config })
      : { logPath: join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log'), logExists: false, logAgeMs: null, windowMs: config.dispatchSpawnFailureWindowMs, matches: [] };
    const dagAutowalk = config.hostChecksEnabled
      ? summarizeDagAutowalkHealth({ env, hqRoot, nowMs, config, launchd })
      : { hqRoot, label: null, loaded: true, lastExitCode: 0, errLogPath: null, outLogPath: null, logAgeMs: null, thresholdMs: config.dagAutowalkMaxLogAgeMs, healthy: true };
    const snapshot = {
      observedAt,
      rootDir,
      hqRoot,
      config,
      reviewer,
      reviewerDegradation,
      outage,
      firstPassQueue,
      followUpQueues: {
        states: followUpQueues.states,
        throughput: followUpQueues.throughput,
        oldestPending: followUpQueues.oldestPending,
      },
      reviewStateLedger,
      mergeOutcomes,
      mergeStalls,
      amaCloserLeases,
      zombieReviewerPasses,
      roundBudget,
      launchd,
      dispatchSpawnFailures,
      dagAutowalk,
    };
    return {
      ...snapshot,
      findings: evaluateReviewPipelineFindings(snapshot, { observedAt }),
    };
  } finally {
    db?.close();
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
  const emittedMetricMetadata = new Set();
  const pushMetric = (name, labels, value) => {
    if (!emittedMetricMetadata.has(name)) {
      emittedMetricMetadata.add(name);
      lines.push(`# HELP ${name} ${REVIEW_PIPELINE_HEALTH_METRIC_HELP[name] || 'Review pipeline health metric.'}`);
      lines.push(`# TYPE ${name} gauge`);
    }
    lines.push(metricLine(name, labels, value));
  };
  pushMetric('review_pipeline_health_collector_up', {}, snapshot.reviewStateLedger?.readable ? 1 : 0);
  pushMetric('review_pipeline_outage_active', {}, snapshot.outage?.active ? 1 : 0);
  pushMetric('review_pipeline_outage_attempts_not_charged', {}, snapshot.outage?.attempts_not_charged || 0);
  const reviewerAttempts = snapshot.reviewer.attempts.length
    ? snapshot.reviewer.attempts
    : [{ status: 'none', failure_class: 'none', pass_kind: 'first-pass', value: 0 }];
  for (const row of reviewerAttempts) {
    pushMetric('review_pipeline_reviewer_attempts_total', {
      status: row.status,
      failure_class: row.failure_class,
      pass_kind: row.pass_kind,
    }, row.value);
  }
  const failedDistinctPrs = snapshot.reviewer.failedDistinctPrs.length
    ? snapshot.reviewer.failedDistinctPrs
    : [{ failureClass: 'none', distinctPrs: 0 }];
  for (const row of failedDistinctPrs) {
    pushMetric('review_pipeline_failed_attempts_distinct_prs', {
      failure_class: row.failureClass,
      window: `${snapshot.config.reviewUnknownRateWindowMs}ms`,
    }, row.distinctPrs);
  }
  const reviewerDegradationByClass = snapshot.reviewerDegradation?.byClass?.length
    ? snapshot.reviewerDegradation.byClass
    : [{ failureClass: 'none', states: { none: 0 } }];
  for (const row of reviewerDegradationByClass) {
    for (const [state, count] of Object.entries(row.states || { none: 0 })) {
      pushMetric('review_pipeline_reviewer_degradation_active', {
        failure_class: row.failureClass,
        state,
      }, count);
    }
  }
  pushMetric('review_pipeline_first_pass_queue_depth', {}, snapshot.firstPassQueue.depth);
  pushMetric(
    'review_pipeline_first_pass_oldest_pending_age_seconds',
    {},
    Math.round((snapshot.firstPassQueue.oldest?.ageMs || 0) / 1000)
  );
  for (const [state, count] of Object.entries(snapshot.followUpQueues.states)) {
    pushMetric('review_pipeline_remediation_backlog_jobs', { state }, count);
  }
  pushMetric(
    'review_pipeline_remediation_oldest_pending_age_seconds',
    {},
    Math.round((snapshot.followUpQueues.oldestPending?.ageMs || 0) / 1000)
  );
  for (const [state, count] of Object.entries(snapshot.followUpQueues.throughput)) {
    pushMetric('review_pipeline_remediation_throughput_jobs', {
      state,
      window: `${snapshot.config.remediationThroughputWindowMs}ms`,
    }, count);
  }
  const mergeOutcomes = snapshot.mergeOutcomes.length
    ? snapshot.mergeOutcomes
    : [{ outcome: 'none', count: 0 }];
  for (const outcome of mergeOutcomes) {
    pushMetric('review_pipeline_merge_outcomes_total', { outcome: outcome.outcome }, outcome.count);
  }
  pushMetric('review_pipeline_merge_stalled_jobs', {}, snapshot.mergeStalls.candidates.length);
  pushMetric('review_pipeline_stale_ama_closer_leases', {}, snapshot.amaCloserLeases?.stale?.length || 0);
  pushMetric('review_pipeline_zombie_reviewer_passes', {}, snapshot.zombieReviewerPasses?.rows?.length || 0);
  pushMetric('review_pipeline_round_budget_anomalies', {}, snapshot.roundBudget?.anomalies?.length || 0);
  const launchdServices = snapshot.launchd?.services?.length
    ? snapshot.launchd.services
    : [{ name: 'none', label: 'none', loaded: false }];
  for (const service of launchdServices) {
    pushMetric('review_pipeline_launchd_service_up', {
      service: service.name,
      label: service.label,
    }, service.loaded ? 1 : 0);
  }
  pushMetric('review_pipeline_dispatch_spawn_failures', {}, snapshot.dispatchSpawnFailures?.matches?.length || 0);
  pushMetric('review_pipeline_dag_autowalk_healthy', {}, snapshot.dagAutowalk?.healthy ? 1 : 0);
  for (const definition of REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS) {
    const active = snapshot.findings.some((finding) => finding.code === definition.code);
    pushMetric('review_pipeline_sentinel_finding_active', {
      code: definition.code,
      tier: definition.tier,
    }, active ? 1 : 0);
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
  summarizeRoundBudgetAnomalies,
  summarizeZombieReviewerPasses,
};
