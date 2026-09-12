import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
});

const EVENT_TYPES = Object.freeze([
  'pr_observed',
  'queue_eligible',
  'row_claimed',
  'reviewer_started',
  'reviewer_first_output',
  'reviewer_post_attempt',
  'reviewer_post_success',
  'reviewer_post_failure',
  'settlement_completed',
  'follow_up_created',
  'clean_verdict',
  'rereview_wake',
  'hammer_wake',
  'merge_completed',
  'deploy_observed',
  'smoke_result',
]);

const STAGE_DEFINITIONS = Object.freeze([
  {
    key: 'pr_observed_to_review_eligible',
    label: 'pr_observed -> review_eligible',
    owner: 'watcher',
    from: ['pr_observed'],
    to: ['queue_eligible'],
  },
  {
    key: 'review_eligible_to_row_claimed',
    label: 'review_eligible -> row_claimed',
    owner: 'admission',
    from: ['queue_eligible'],
    to: ['row_claimed'],
  },
  {
    key: 'row_claimed_to_reviewer_first_output',
    label: 'row_claimed -> reviewer_first_output',
    owner: 'reviewer-runtime',
    from: ['row_claimed'],
    to: ['reviewer_first_output', 'reviewer_started'],
  },
  {
    key: 'reviewer_first_output_to_gh_post',
    label: 'reviewer_first_output -> gh_post',
    owner: 'reviewer-runtime',
    from: ['reviewer_first_output', 'reviewer_started'],
    to: ['reviewer_post_success', 'reviewer_post_failure', 'gh_post'],
  },
  {
    key: 'gh_post_to_follow_up_created',
    label: 'gh_post -> follow_up_created',
    owner: 'follow-up',
    from: ['reviewer_post_success', 'gh_post'],
    to: ['follow_up_created'],
  },
  {
    key: 'clean_verdict_to_hammer_wake',
    label: 'clean_verdict -> hammer_wake',
    owner: 'merge',
    from: ['clean_verdict'],
    to: ['hammer_wake'],
  },
  {
    key: 'merge_to_deploy_observed',
    label: 'merge -> deploy_observed',
    owner: 'main-catchup',
    from: ['merge_completed'],
    to: ['deploy_observed'],
  },
]);

function toIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseDurationMs(value, { fallbackMs = DEFAULT_SINCE_MS } = {}) {
  if (value == null || value === '') return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const multiplier = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit];
  return Math.round(amount * multiplier);
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
        error: error?.message || String(error),
      },
    };
  }
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

function subjectKey({ repo, prNumber, domainId, subjectExternalId }) {
  if (repo && Number.isInteger(Number(prNumber))) {
    return `pr:${repo}#${Number(prNumber)}`;
  }
  if (domainId && subjectExternalId) {
    return `domain:${domainId}#${subjectExternalId}`;
  }
  return 'unknown#0';
}

function addSubjectEvent(subjects, {
  repo,
  prNumber,
  domainId,
  subjectExternalId,
  eventType,
  at,
  source,
  inferred = false,
  reason = null,
  payload = {},
}) {
  const atMs = toMs(at);
  if (atMs === null || !eventType) return;
  const key = subjectKey({ repo, prNumber, domainId, subjectExternalId });
  const subject = subjects.get(key) || {
    key,
    repo: repo || null,
    prNumber: Number.isInteger(Number(prNumber)) ? Number(prNumber) : null,
    domainId: domainId || null,
    subjectExternalId: subjectExternalId || null,
    events: [],
  };
  subject.events.push({
    eventType,
    at,
    atMs,
    source,
    inferred,
    reason,
    payload,
  });
  subjects.set(key, subject);
}

function firstEvent(subject, eventTypes) {
  for (const eventType of eventTypes) {
    const match = subject.events
      .filter((event) => event.eventType === eventType)
      .sort((left, right) => left.atMs - right.atMs)[0] || null;
    if (match) return match;
  }
  return null;
}

function addExplicitEvents(db, subjects, { sinceIso }) {
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, domain_id, subject_external_id,
            event_type, at, source, reason, payload_json
       FROM review_latency_events
      WHERE at >= ?
      ORDER BY at ASC, event_id ASC`,
    [sinceIso]
  );
  for (const row of rows) {
    addSubjectEvent(subjects, {
      repo: row.repo,
      prNumber: row.pr_number,
      domainId: row.domain_id,
      subjectExternalId: row.subject_external_id,
      eventType: row.event_type,
      at: row.at,
      source: row.source || 'review_latency_events',
      inferred: false,
      reason: row.reason || null,
      payload: parseJson(row.payload_json, {}),
    });
  }
  return rows.length;
}

function addReviewRowInferredEvents(db, subjects, { sinceIso }) {
  const rows = safeAll(
    db,
    `SELECT repo,
            pr_number,
            reviewed_at,
            rereview_requested_at,
            last_attempted_at,
            posted_at,
            failed_at,
            review_status,
            review_attempts,
            reviewer,
            reviewer_started_at,
            reviewer_head_sha,
            revision_ref,
            merged_at,
            pr_state,
            failure_message
       FROM reviewed_prs
      WHERE reviewed_at >= ?
         OR rereview_requested_at >= ?
         OR last_attempted_at >= ?
         OR posted_at >= ?
         OR failed_at >= ?
         OR reviewer_started_at >= ?
         OR merged_at >= ?`,
    [sinceIso, sinceIso, sinceIso, sinceIso, sinceIso, sinceIso, sinceIso]
  );
  for (const row of rows) {
    const repo = row.repo;
    const prNumber = row.pr_number;
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'pr_observed',
      at: row.reviewed_at,
      source: 'reviewed_prs.reviewed_at',
      inferred: true,
    });
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'queue_eligible',
      at: row.rereview_requested_at || row.reviewed_at,
      source: row.rereview_requested_at ? 'reviewed_prs.rereview_requested_at' : 'reviewed_prs.reviewed_at',
      inferred: true,
      reason: row.rereview_requested_at ? 'rereview-requested' : 'first-pass',
    });
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'rereview_wake',
      at: row.rereview_requested_at,
      source: 'reviewed_prs.rereview_requested_at',
      inferred: true,
      reason: row.rereview_reason || 'rereview-requested',
    });
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'row_claimed',
      at: row.last_attempted_at,
      source: 'reviewed_prs.last_attempted_at',
      inferred: true,
      payload: {
        reviewAttempts: Number(row.review_attempts || 0),
        reviewer: row.reviewer || null,
      },
    });
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'reviewer_started',
      at: row.reviewer_started_at,
      source: 'reviewed_prs.reviewer_started_at',
      inferred: true,
      payload: {
        reviewer: row.reviewer || null,
        headSha: row.reviewer_head_sha || row.revision_ref || null,
      },
    });
    if (row.posted_at) {
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'reviewer_post_success',
        at: row.posted_at,
        source: 'reviewed_prs.posted_at',
        inferred: true,
      });
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'gh_post',
        at: row.posted_at,
        source: 'reviewed_prs.posted_at',
        inferred: true,
      });
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'settlement_completed',
        at: row.posted_at,
        source: 'reviewed_prs.posted_at',
        inferred: true,
      });
    }
    if (row.failed_at) {
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'reviewer_post_failure',
        at: row.failed_at,
        source: 'reviewed_prs.failed_at',
        inferred: true,
        reason: row.failure_message || row.review_status || null,
      });
    }
    if (row.pr_state === 'merged' && row.merged_at) {
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'merge_completed',
        at: row.merged_at,
        source: 'reviewed_prs.merged_at',
        inferred: true,
      });
    }
  }
  return rows.length;
}

function addReviewerPassInferredEvents(db, subjects, { sinceIso }) {
  const rows = safeAll(
    db,
    `SELECT repo,
            pr_number,
            attempt_number,
            reviewer_class,
            reviewer_model,
            pass_kind,
            started_at,
            ended_at,
            status,
            gh_comment_id,
            body_captured_at,
            metadata_json
       FROM reviewer_passes
      WHERE started_at >= ?
         OR ended_at >= ?
         OR body_captured_at >= ?`,
    [sinceIso, sinceIso, sinceIso]
  );
  for (const row of rows) {
    const metadata = parseJson(row.metadata_json, {});
    const payload = {
      attemptNumber: Number(row.attempt_number || 0),
      reviewerClass: row.reviewer_class || null,
      reviewerModel: row.reviewer_model || null,
      passKind: row.pass_kind || null,
      status: row.status || null,
    };
    addSubjectEvent(subjects, {
      repo: row.repo,
      prNumber: row.pr_number,
      eventType: 'reviewer_started',
      at: row.started_at,
      source: 'reviewer_passes.started_at',
      inferred: true,
      payload,
    });
    addSubjectEvent(subjects, {
      repo: row.repo,
      prNumber: row.pr_number,
      eventType: 'reviewer_first_output',
      at: metadata.firstOutputAt || metadata.first_output_at || row.started_at,
      source: metadata.firstOutputAt || metadata.first_output_at
        ? 'reviewer_passes.metadata_json.firstOutputAt'
        : 'reviewer_passes.started_at',
      inferred: true,
      reason: metadata.firstOutputAt || metadata.first_output_at ? null : 'started_at-as-start-proof',
      payload,
    });
    if (row.status === 'completed' || row.gh_comment_id) {
      addSubjectEvent(subjects, {
        repo: row.repo,
        prNumber: row.pr_number,
        eventType: 'reviewer_post_success',
        at: row.body_captured_at || row.ended_at,
        source: row.body_captured_at ? 'reviewer_passes.body_captured_at' : 'reviewer_passes.ended_at',
        inferred: true,
        payload,
      });
      addSubjectEvent(subjects, {
        repo: row.repo,
        prNumber: row.pr_number,
        eventType: 'gh_post',
        at: row.body_captured_at || row.ended_at,
        source: row.body_captured_at ? 'reviewer_passes.body_captured_at' : 'reviewer_passes.ended_at',
        inferred: true,
        payload,
      });
    } else if (row.status === 'failed') {
      addSubjectEvent(subjects, {
        repo: row.repo,
        prNumber: row.pr_number,
        eventType: 'reviewer_post_failure',
        at: row.ended_at,
        source: 'reviewer_passes.ended_at',
        inferred: true,
        reason: metadata.failureClass || metadata.errorClass || null,
        payload,
      });
    }
  }
  return rows.length;
}

function isCleanVerdictJob(job) {
  return job?.remediationPlan?.stop?.code === 'review-settled'
    || job?.stopCode === 'review-settled'
    || job?.stopReason === 'Latest adversarial review verdict is non-blocking; no remediation worker required.';
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

function addFollowUpInferredEvents(rootDir, subjects, { sinceMs }) {
  let count = 0;
  for (const entry of readFollowUpJobs(rootDir)) {
    const job = entry.job || {};
    const repo = job.repo;
    const prNumber = Number(job.prNumber);
    if (!repo || !Number.isInteger(prNumber)) continue;
    const createdAt = job.createdAt || new Date(entry.stat.birthtimeMs || entry.stat.mtimeMs).toISOString();
    const stoppedAt = job.stoppedAt || job.remediationPlan?.stop?.stoppedAt || createdAt;
    const createdAtMs = toMs(createdAt) || 0;
    const stoppedAtMs = toMs(stoppedAt) || 0;
    if (createdAtMs < sinceMs && stoppedAtMs < sinceMs) continue;
    count += 1;
    addSubjectEvent(subjects, {
      repo,
      prNumber,
      eventType: 'follow_up_created',
      at: createdAt,
      source: `follow-up-jobs/${entry.state}`,
      inferred: true,
      payload: {
        state: entry.state,
        jobId: job.jobId || null,
        revisionRef: job.revisionRef || null,
      },
    });
    if (isCleanVerdictJob(job)) {
      addSubjectEvent(subjects, {
        repo,
        prNumber,
        eventType: 'clean_verdict',
        at: stoppedAt,
        source: `follow-up-jobs/${entry.state}`,
        inferred: true,
        reason: 'review-settled',
      });
    }
  }
  return count;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function summarizeStages(subjects) {
  return STAGE_DEFINITIONS.map((definition) => {
    const samples = [];
    for (const subject of subjects.values()) {
      const from = firstEvent(subject, definition.from);
      const to = firstEvent(subject, definition.to);
      if (!from || !to) continue;
      const durationMs = to.atMs - from.atMs;
      if (durationMs < 0) continue;
      samples.push({
        repo: subject.repo,
        prNumber: subject.prNumber,
        durationMs,
        fromAt: from.at,
        toAt: to.at,
        inferred: Boolean(from.inferred || to.inferred),
        sources: [from.source, to.source],
      });
    }
    const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
    const worst = samples.sort((left, right) => right.durationMs - left.durationMs)[0] || null;
    return {
      key: definition.key,
      stage: definition.label,
      owner: definition.owner,
      sampleCount: samples.length,
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
      worstMs: durations.length ? durations[durations.length - 1] : null,
      worstSubject: worst ? {
        repo: worst.repo,
        prNumber: worst.prNumber,
        durationMs: worst.durationMs,
        fromAt: worst.fromAt,
        toAt: worst.toAt,
      } : null,
    };
  });
}

function queueAges(db, { nowMs }) {
  const rows = safeAll(
    db,
    `SELECT repo, pr_number, reviewed_at, rereview_requested_at, last_attempted_at,
            review_status, failed_at, failure_message, reviewer, reviewer_session_uuid,
            reviewer_pgid, reviewer_started_at, reviewer_lease_expires_at
       FROM reviewed_prs
      WHERE COALESCE(pr_state, 'open') = 'open'
        AND review_status IN ('pending', 'pending-upstream', 'reviewing', 'ci-blocked', 'failed', 'failed-orphan')
      ORDER BY COALESCE(rereview_requested_at, reviewed_at, last_attempted_at, failed_at, '') ASC`
  );
  const entries = rows.map((row) => {
    const waitingSince = row.rereview_requested_at || row.reviewed_at || row.last_attempted_at || row.failed_at || null;
    const waitingSinceMs = toMs(waitingSince);
    return {
      repo: row.repo,
      prNumber: Number(row.pr_number),
      status: row.review_status,
      waitingSince,
      ageMs: waitingSinceMs === null ? null : Math.max(0, nowMs - waitingSinceMs),
      reason: waitingReason(row),
      reviewer: row.reviewer || null,
      reviewerSessionUuid: row.reviewer_session_uuid || null,
      reviewerPgid: row.reviewer_pgid || null,
      reviewerStartedAt: row.reviewer_started_at || null,
      reviewerLeaseExpiresAt: row.reviewer_lease_expires_at || null,
    };
  });
  return {
    count: entries.length,
    oldest: entries.filter((entry) => entry.ageMs !== null)
      .sort((left, right) => right.ageMs - left.ageMs)[0] || null,
    entries,
  };
}

function waitingReason(row) {
  if (row.review_status === 'pending' && row.rereview_requested_at) return 'rereview-pending';
  if (row.review_status === 'pending') return row.failed_at ? 'retry-after-reviewer-failure' : 'first-pass-pending';
  if (row.review_status === 'pending-upstream') return 'upstream-backoff';
  if (row.review_status === 'reviewing' && !row.reviewer_pgid) return 'reviewing-without-pgid';
  if (row.review_status === 'reviewing') return 'reviewer-running';
  if (row.review_status === 'ci-blocked') return 'rereview-ci-blocked';
  if (row.review_status === 'failed-orphan') return 'orphaned-reviewer-claim';
  if (row.review_status === 'failed') return classifyFailure(row.failure_message);
  return row.review_status || 'unknown';
}

function classifyFailure(value) {
  const text = String(value || '').toLowerCase();
  if (!text.trim()) return 'unknown';
  if (text.includes('quota') || text.includes('usage cap') || text.includes('rate limit')) return 'quota-or-rate-limit';
  if (text.includes('auth') || text.includes('oauth') || text.includes('token')) return 'auth';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('overloaded') || text.includes('5xx') || text.includes('upstream')) return 'upstream';
  if (text.includes('pgid') || text.includes('orphan') || text.includes('session')) return 'orphan';
  if (text.includes('diff') && text.includes('large')) return 'diff-too-large';
  return 'failed';
}

function topWaitingReasons(queue) {
  const counts = new Map();
  for (const entry of queue.entries) {
    const current = counts.get(entry.reason) || {
      reason: entry.reason,
      count: 0,
      oldestAgeMs: null,
      examples: [],
    };
    current.count += 1;
    if (entry.ageMs !== null && (current.oldestAgeMs === null || entry.ageMs > current.oldestAgeMs)) {
      current.oldestAgeMs = entry.ageMs;
    }
    if (current.examples.length < 3) {
      current.examples.push({ repo: entry.repo, prNumber: entry.prNumber, status: entry.status });
    }
    counts.set(entry.reason, current);
  }
  return Array.from(counts.values())
    .sort((left, right) => right.count - left.count || (right.oldestAgeMs || 0) - (left.oldestAgeMs || 0));
}

function reviewerSlotState(db, { nowMs }) {
  const reviewing = safeAll(
    db,
    `SELECT repo, pr_number, reviewer, reviewer_session_uuid, reviewer_pgid,
            reviewer_started_at, reviewer_lease_expires_at, reviewer_head_sha
       FROM reviewed_prs
      WHERE COALESCE(pr_state, 'open') = 'open'
        AND review_status = 'reviewing'
      ORDER BY reviewer_started_at ASC`
  ).map((row) => ({
    repo: row.repo,
    prNumber: Number(row.pr_number),
    reviewer: row.reviewer || null,
    reviewerSessionUuid: row.reviewer_session_uuid || null,
    reviewerPgid: row.reviewer_pgid || null,
    reviewerStartedAt: row.reviewer_started_at || null,
    ageMs: toMs(row.reviewer_started_at) === null ? null : Math.max(0, nowMs - toMs(row.reviewer_started_at)),
    reviewerLeaseExpiresAt: row.reviewer_lease_expires_at || null,
    reviewerHeadSha: row.reviewer_head_sha || null,
    hasDurablePgid: row.reviewer_pgid !== null && row.reviewer_pgid !== undefined,
  }));
  const runningPasses = safeAll(
    db,
    `SELECT repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
            started_at, worker_run_id, metadata_json
       FROM reviewer_passes
      WHERE status = 'running'
      ORDER BY started_at ASC`
  ).map((row) => ({
    repo: row.repo,
    prNumber: Number(row.pr_number),
    attemptNumber: Number(row.attempt_number || 0),
    reviewerClass: row.reviewer_class || null,
    reviewerModel: row.reviewer_model || null,
    passKind: row.pass_kind || null,
    startedAt: row.started_at,
    ageMs: toMs(row.started_at) === null ? null : Math.max(0, nowMs - toMs(row.started_at)),
    workerRunId: row.worker_run_id || null,
    metadata: parseJson(row.metadata_json, {}),
  }));
  return {
    reviewingRows: reviewing.length,
    runningPasses: runningPasses.length,
    nullPgidRows: reviewing.filter((row) => !row.hasDurablePgid).length,
    rows: reviewing,
    passes: runningPasses,
  };
}

function agyRouteState(db, { sinceIso }) {
  const reviewerRows = safeAll(
    db,
    `SELECT reviewer, COUNT(*) AS count
      FROM reviewed_prs
      WHERE COALESCE(last_attempted_at, reviewed_at) >= ?
        AND (
          lower(COALESCE(reviewer, '')) GLOB '*agy*'
          OR lower(COALESCE(reviewer, '')) GLOB '*gemini*'
        )
      GROUP BY reviewer
      ORDER BY count DESC`,
    [sinceIso]
  );
  const eventRows = safeAll(
    db,
    `SELECT event_type, source, reason, at, payload_json
       FROM review_latency_events
      WHERE at >= ?
        AND (
          lower(COALESCE(source, '')) GLOB '*agy*'
          OR lower(COALESCE(source, '')) GLOB '*gemini*'
          OR lower(COALESCE(payload_json, '')) GLOB '*agy*'
          OR lower(COALESCE(payload_json, '')) GLOB '*gemini*'
        )
      ORDER BY at DESC
      LIMIT 10`,
    [sinceIso]
  );
  return {
    available: reviewerRows.length > 0 || eventRows.length > 0,
    reviewerRows: reviewerRows.map((row) => ({ reviewer: row.reviewer, count: row.count })),
    recentProbeEvents: eventRows.map((row) => ({
      eventType: row.event_type,
      source: row.source || null,
      reason: row.reason || null,
      at: row.at,
      payload: parseJson(row.payload_json, {}),
    })),
  };
}

function recentWakeEvents(subjects) {
  const wakes = [];
  for (const subject of subjects.values()) {
    for (const event of subject.events) {
      if (event.eventType !== 'rereview_wake' && event.eventType !== 'hammer_wake') continue;
      wakes.push({
        eventType: event.eventType,
        repo: subject.repo,
        prNumber: subject.prNumber,
        at: event.at,
        reason: event.reason,
        inferred: event.inferred,
      });
    }
  }
  return wakes.sort((left, right) => (toMs(right.at) || 0) - (toMs(left.at) || 0)).slice(0, 20);
}

function topBottlenecks(stageSummaries, queue) {
  const bottlenecks = [];
  for (const stage of stageSummaries) {
    if (!stage.worstSubject || stage.worstMs === null) continue;
    bottlenecks.push({
      kind: 'stage',
      label: stage.stage,
      repo: stage.worstSubject.repo,
      prNumber: stage.worstSubject.prNumber,
      durationMs: stage.worstMs,
      owner: stage.owner,
    });
  }
  for (const reason of topWaitingReasons(queue).slice(0, 5)) {
    if (reason.oldestAgeMs === null || reason.examples.length === 0) continue;
    bottlenecks.push({
      kind: 'waiting_reason',
      label: reason.reason,
      repo: reason.examples[0].repo,
      prNumber: reason.examples[0].prNumber,
      durationMs: reason.oldestAgeMs,
      owner: 'queue',
      count: reason.count,
    });
  }
  return bottlenecks
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10);
}

function collectReviewLatencyReport({
  rootDir = process.cwd(),
  since = '24h',
  now = () => new Date(),
} = {}) {
  const observedAt = toIso(now);
  const nowMs = toMs(observedAt);
  const sinceMs = nowMs - parseDurationMs(since);
  const sinceIso = new Date(sinceMs).toISOString();
  const { db, status: reviewStateLedger } = openReviewStateReadOnlyDb(rootDir);
  const subjects = new Map();
  const surfaces = {
    explicitEvents: 0,
    reviewedPrRows: 0,
    reviewerPassRows: 0,
    followUpJobs: 0,
  };
  try {
    if (db) {
      surfaces.explicitEvents = addExplicitEvents(db, subjects, { sinceIso });
      surfaces.reviewedPrRows = addReviewRowInferredEvents(db, subjects, { sinceIso });
      surfaces.reviewerPassRows = addReviewerPassInferredEvents(db, subjects, { sinceIso });
    }
    surfaces.followUpJobs = addFollowUpInferredEvents(rootDir, subjects, { sinceMs });
    const stages = summarizeStages(subjects);
    const queue = db ? queueAges(db, { nowMs }) : { count: 0, oldest: null, entries: [] };
    return {
      schema: 'adversarial-review-latency-report/v1',
      observedAt,
      window: { since: sinceIso, until: observedAt, sinceArgument: since },
      reviewStateLedger,
      eventTypes: EVENT_TYPES,
      surfaces,
      stages,
      queue,
      topWaitingReasons: topWaitingReasons(queue),
      reviewerSlots: db
        ? reviewerSlotState(db, { nowMs })
        : { reviewingRows: 0, runningPasses: 0, nullPgidRows: 0, rows: [], passes: [] },
      agyRouteState: db
        ? agyRouteState(db, { sinceIso })
        : { available: false, reviewerRows: [], recentProbeEvents: [] },
      recentWakes: recentWakeEvents(subjects),
      topBottlenecks: topBottlenecks(stages, queue),
    };
  } finally {
    if (db) db.close();
  }
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m${String(remSeconds).padStart(2, '0')}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h${String(remMinutes).padStart(2, '0')}m` : `${hours}h`;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function renderReviewLatencyReport(report) {
  const lines = [];
  lines.push(`window: ${report.window.since}..${report.window.until}`);
  lines.push('');
  lines.push(`${pad('stage', 38)} ${pad('p50', 8)} ${pad('p90', 8)} ${pad('worst', 8)} owner`);
  for (const stage of report.stages) {
    lines.push(
      `${pad(stage.stage, 38)} ` +
      `${pad(formatDuration(stage.p50Ms), 8)} ` +
      `${pad(formatDuration(stage.p90Ms), 8)} ` +
      `${pad(formatDuration(stage.worstMs), 8)} ` +
      `${stage.owner}`
    );
  }
  lines.push('');
  lines.push(`current queue: ${report.queue.count} waiting`);
  if (report.queue.oldest) {
    lines.push(
      `oldest: ${report.queue.oldest.repo}#${report.queue.oldest.prNumber} ` +
      `${formatDuration(report.queue.oldest.ageMs)} (${report.queue.oldest.reason})`
    );
  }
  lines.push(
    `reviewer slots: reviewing=${report.reviewerSlots.reviewingRows} ` +
    `running_passes=${report.reviewerSlots.runningPasses} null_pgid=${report.reviewerSlots.nullPgidRows}`
  );
  lines.push(`AGY route/probe: ${report.agyRouteState.available ? 'available' : 'unobserved'}`);
  lines.push('');
  lines.push('top waiting reasons:');
  for (const reason of report.topWaitingReasons.slice(0, 5)) {
    lines.push(`- ${reason.reason}: ${reason.count} oldest=${formatDuration(reason.oldestAgeMs)}`);
  }
  if (report.topWaitingReasons.length === 0) lines.push('- none');
  lines.push('');
  lines.push('recent wakes:');
  for (const wake of report.recentWakes.slice(0, 10)) {
    lines.push(
      `- ${wake.at} ${wake.eventType} ${wake.repo}#${wake.prNumber}` +
      `${wake.reason ? ` ${wake.reason}` : ''}${wake.inferred ? ' (inferred)' : ''}`
    );
  }
  if (report.recentWakes.length === 0) lines.push('- none');
  lines.push('');
  lines.push('top bottlenecks:');
  report.topBottlenecks.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.label}: ${item.repo}#${item.prNumber} ${formatDuration(item.durationMs)}` +
      `${item.count ? ` count=${item.count}` : ''}`
    );
  });
  if (report.topBottlenecks.length === 0) lines.push('1. none');
  return `${lines.join('\n')}\n`;
}

export {
  EVENT_TYPES,
  collectReviewLatencyReport,
  formatDuration,
  parseDurationMs,
  renderReviewLatencyReport,
};
