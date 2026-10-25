import { openReviewStateReadOnlyDb } from './pipeline-health-db.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { parseAmaAuditDocument } from './ama/audit.mjs';
/** Read-only, bounded projection for Sentinel. No launch exit is real work. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILES = 20000;
const MAX_DOCUMENTS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const code = (value) => /^[a-z][a-z0-9_.-]{0,79}$/.test(value || '') && !/^(?:gh[pousr]_|github_pat_|sk-)/.test(value) ? value : 'unknown';
const stamp = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const identity = (row) => `${row.repo}#${row.prNumber ?? row.pr_number}`;
const item = (row, at) => ({ repo: row.repo, prNumber: Number(row.prNumber ?? row.pr_number), at: stamp(at) });
const newest = (rows) => rows.filter((row) => row.at).sort((a, b) => b.at.localeCompare(a.at));
const lane = () => ({ available: true, waiting: [], lastRealEvent: null, lastRuns: [] });

function files(directory, suffix = '.json') {
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.length > MAX_FILES) throw new Error('scan-limit');
  return names.filter((name) => name.endsWith(suffix)).map((name) => {
    const path = join(directory, name);
    try { return { path, name, stat: statSync(path) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }).filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

function documents(directory, parse = JSON.parse) {
  const entries = files(directory);
  const records = entries.slice(0, MAX_DOCUMENTS).map((entry) => {
    if (entry.stat.size > MAX_BYTES) throw new Error('document-limit');
    try { return { ...entry, value: parse(readFileSync(entry.path, 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }).filter(Boolean);
  return { records, truncated: entries.length > MAX_DOCUMENTS };
}

function rows(db, sql, limit = MAX_ROWS) {
  if (!db) throw new Error('review-state-unavailable');
  const result = db.prepare(`${sql} LIMIT ${limit + 1}`).all();
  if (limit === MAX_ROWS && result.length > MAX_ROWS) throw new Error('row-limit');
  return result.slice(0, limit);
}

function observe(target, fn) {
  try { fn(); }
  catch { target.available = false; target.error = 'evidence-unavailable'; }
}

function finish(target, events, runs, truncated = false) {
  target.lastRealEvent = newest(events)[0] || null;
  target.lastRuns = newest(runs).slice(0, 5);
  target.scanTruncated = truncated;
  if ([...events, ...runs].some((row) => !row.at)) {
    target.available = false;
    target.error = 'invalid-event-time';
  }
  // A bounded historical tail can prove a success, but cannot prove absence.
  if (truncated && (!target.lastRealEvent || target.lastRuns.length < 5)) {
    target.available = false;
    target.error = 'history-truncated';
  }
  target.waiting = [...new Map(target.waiting.map((row) => [identity(row), row])).values()];
}

export function collectLaneLivenessEvidence({ db, rootDir, hqRoot, nowMs = Date.now() }) {
  const lanes = { hammer: lane(), daemon: lane(), remediation: lane(), review: lane() };
  let open = new Map();
  try {
    open = new Map(rows(db, `SELECT repo, pr_number, pr_state, labels_json, review_status,
      reviewed_at, last_attempted_at, revision_ref, reviewer_head_sha FROM reviewed_prs
      WHERE COALESCE(pr_state, 'open') = 'open'`).map((row) => [identity(row), row]));
  } catch {
    for (const target of Object.values(lanes)) { target.available = false; target.error = 'review-state-unavailable'; }
  }
  // Local labels are undated. Preserve unknown-label demand, as the other
  // local pipeline counters do; a stale label must not suppress a dead lane.
  const current = (row) => open.get(identity(row));
  const currentHead = (row) => {
    const pr = current(row);
    const head = pr?.revision_ref || pr?.reviewer_head_sha;
    return pr && (!head || !row.headSha || head.startsWith(row.headSha) || row.headSha.startsWith(head));
  };
  observe(lanes.review, () => {
    for (const row of open.values()) {
      if (['pending', 'reviewing'].includes(row.review_status)) {
        lanes.review.waiting.push(item(row, row.reviewed_at || row.last_attempted_at));
      }
    }
    const events = rows(db, `SELECT repo, pr_number, at FROM review_latency_events
      WHERE event_type = 'reviewer_post_success' ORDER BY at DESC`, 1).map((row) => ({
      ...item(row, row.at), kind: 'reviewer_post_success', outcome: 'succeeded',
    }));
    const runs = rows(db, `SELECT repo, pr_number, at, event_type FROM review_latency_events
      WHERE event_type IN ('reviewer_post_success', 'reviewer_post_failure', 'reviewer_reaped')
      ORDER BY at DESC`, 5).map((row) => ({ ...item(row, row.at),
      outcome: row.event_type === 'reviewer_post_success' ? 'succeeded' : 'failed',
      reason: code(row.event_type),
    }));
    finish(lanes.review, events, runs);
  });
  observe(lanes.remediation, () => {
    const events = [], runs = [];
    let truncated = false;
    for (const state of ['pending', 'in-progress', 'completed', 'failed', 'stopped']) {
      const scan = documents(join(rootDir, 'data', 'follow-up-jobs', state));
      if (['pending', 'in-progress'].includes(state) && scan.truncated) throw new Error('demand-truncated');
      truncated ||= scan.truncated;
      for (const { value: job } of scan.records) {
        if (['pending', 'in-progress'].includes(state) && current(job)) {
          const retry = Date.parse(job.remediationPlan?.retryAfter);
          if (!Number.isFinite(retry) || retry <= nowMs) lanes.remediation.waiting.push(item(job, job.createdAt || job.pendingAt));
        }
        if (!['completed', 'failed', 'stopped'].includes(state)) continue;
        const at = job.completedAt || job.failedAt || job.stoppedAt;
        // A resulting head may be the unchanged input head. Only the producer's
        // published-worker proof establishes a push (never a local-only commit).
        const sha = job.completion?.workerPushedHeadSha;
        const pushed = state === 'completed' && /^[a-f0-9]{40}$/.test(sha || '') && sha !== job.revisionRef;
        const reason = job.failure?.failureClass || job.failureClass || (pushed ? 'pushed' : 'no_work_done');
        const run = { ...item(job, at), outcome: pushed ? 'succeeded' : 'failed', reason: code(reason) };
        runs.push(run);
        if (pushed) events.push({ ...run, kind: 'remediation_push', commitSha: sha });
      }
    }
    finish(lanes.remediation, events, runs, truncated);
  });
  // Both merge lanes share the existing AMA audit, distinguished by the
  // producer's path. Hammer success additionally requires an executed receipt
  // for exactly the same repository, PR and head.
  const mergeEvents = { hammer: [], daemon: [] }, mergeRuns = { hammer: [], daemon: [] };
  try {
    const receipts = documents(join(hqRoot, 'dispatch', 'audit', 'automation-merge-actions'));
    const merged = new Map(receipts.records.filter(({ value }) => value.merged === true && value.producerClass === 'closer-hammer')
      .map(({ value }) => [`${identity(value)}@${value.headSha}`, value]));
    const audits = documents(join(hqRoot, 'dispatch', 'audit', 'adversarial-merge-authority'), parseAmaAuditDocument);
    for (const { value: audit } of audits.records) {
      for (const attempt of audit.attempts || []) {
        const name = attempt.path === 'daemon-merge' || attempt.attemptPhase === 'daemon-merged' ? 'daemon'
          : String(attempt.attemptPhase || '').startsWith('hammer-') || attempt.path === 'hammer' ? 'hammer' : null;
        if (!name || ['in_progress', 'eligible', 'deferred'].includes(attempt.outcome)) continue;
        const receipt = merged.get(`${identity(audit)}@${audit.headSha}`);
        const succeeded = attempt.outcome === 'succeeded' && (name === 'daemon' || Boolean(receipt));
        const run = { ...item(audit, attempt.mergedAt || attempt.closedAt || attempt.startedAt),
          outcome: succeeded ? 'succeeded' : 'failed', reason: code(attempt.failureClass || attempt.reason || attempt.outcome) };
        mergeRuns[name].push(run);
        if (succeeded) mergeEvents[name].push({ ...run, at: name === 'hammer' ? stamp(receipt.executedAt) : run.at,
          kind: name === 'hammer' ? 'hammer_merge' : 'daemon_merge', headSha: audit.headSha });
      }
    }
    for (const name of ['hammer', 'daemon']) finish(lanes[name], mergeEvents[name], mergeRuns[name], audits.truncated || (name === 'hammer' && receipts.truncated));
  } catch {
    for (const name of ['hammer', 'daemon']) { lanes[name].available = false; lanes[name].error = 'audit-unavailable'; }
  }
  observe(lanes.hammer, () => {
    const leases = documents(join(rootDir, 'data', 'ama-closer-leases'));
    if (leases.truncated) throw new Error('demand-truncated');
    for (const { value: lease } of leases.records) {
      if (currentHead(lease) && ['pending', 'dispatched'].includes(lease.status) && !lease.terminalOutcome) {
        lanes.hammer.waiting.push(item(lease, current(lease)?.reviewed_at || lease.acquiredAt || lease.updatedAt));
      }
    }
    for (const entry of files(join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts'), '.md')) {
      const match = /^(.*)-pr-(\d+)-([a-f0-9]{7,64})(?:-hammer-scratch-[a-z0-9]+)?\.md$/i.exec(entry.name);
      if (!match) continue;
      for (const row of open.values()) {
        if (row.repo.replaceAll('/', '-') === match[1] && Number(row.pr_number) === Number(match[2])
          && currentHead({ repo: row.repo, prNumber: row.pr_number, headSha: match[3] })) {
          lanes.hammer.waiting.push(item(row, row.reviewed_at || new Date(entry.stat.mtimeMs).toISOString()));
        }
      }
    }
  });
  observe(lanes.daemon, () => {
    const scan = documents(join(rootDir, 'data', 'daemon-merge-parks'));
    if (scan.truncated) throw new Error('demand-truncated');
    for (const { value: park } of scan.records) {
      // A daemon park that explicitly hands off to hammer is not daemon demand.
      if (currentHead(park)
        && !['verdict-not-eligible', 'daemon-route-disagreement'].includes(park.reason)) {
        lanes.daemon.waiting.push(item(park, current(park)?.reviewed_at || park.firstObservedAt || park.lastObservedAt));
      }
    }
  });
  for (const target of Object.values(lanes)) {
    target.waiting = [...new Map(target.waiting.map((row) => [identity(row), row])).values()];
    if (target.waiting.some((row) => !row.at)) { target.available = false; target.error = 'invalid-demand-time'; }
    target.held = null;
    target.labelsUnknown = true;
  }
  return { version: 1, observedAt: new Date(nowMs).toISOString(), lanes };
}

/** Local-only mode must never import the full collector's writable daemon graph. */
export function collectReviewLaneLiveness({ rootDir, hqRoot = resolveHqRoot(), now = () => new Date() }) {
  const { db } = openReviewStateReadOnlyDb(rootDir);
  try {
    return collectLaneLivenessEvidence({ db, rootDir, hqRoot, nowMs: now().getTime() });
  } finally { db?.close(); }
}
