// Diagnostics only. This state never authorizes a merge or releases a lease.
import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

function locked(rootDir, action) {
  const dir = join(rootDir, 'data', 'ama-closure-lag');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'state.lock'), 'a');
  try {
    fsExt.flockSync(fd, 'ex');
    const path = join(dir, 'state.json');
    let state;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { prs: {}, samples: [], breaches: {} }; }
    const result = action(state);
    writeFileAtomic(path, `${JSON.stringify(state)}\n`);
    return result;
  } finally { fsExt.flockSync(fd, 'un'); closeSync(fd); }
}

export function observeCloserBacklog({ rootDir, repo, prNumber, now = Date.now() }) {
  return locked(rootDir, (state) => {
    const key = `${repo}#${prNumber}`;
    state.prs[key] ??= {};
    state.prs[key].closerSeenAt = now;
    // A stale observation is not a current eligible backlog. Active launches
    // are counted independently by the caller and retain their exclusivity.
    return Object.values(state.prs).filter((pr) => pr.closerSeenAt >= now - 600000 && !pr.terminal).length;
  });
}

async function page(text, options) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('offline tests must inject pageImpl');
  const { deliverAlert } = await import('../alert-delivery.mjs');
  return deliverAlert(text, options);
}

export async function observeClosureLag({ rootDir, repo, prNumber, headSha, eligible = false,
  merged = false, closed = false, mergedAt = null, reason = null,
  now = Date.now(), sloMs = null, logger = console, pageImpl = page }) {
  const result = locked(rootDir, (state) => {
    const key = `${repo}#${prNumber}`;
    let pr = state.prs[key];
    if (!pr) pr = state.prs[key] = {};
    if (eligible && pr.eligibleAt == null) {
      Object.assign(pr, { eligibleAt: now, headSha, terminal: false });
    }
    if (reason) pr.reason = reason;
    pr.reason ??= 'merge-pending';
    const events = [];
    if (merged || closed) {
      if (merged && pr.eligibleAt != null && !pr.terminal) {
        const end = Date.parse(mergedAt) || now;
        const lagMs = Math.max(0, end - pr.eligibleAt);
        events.push({ event: 'ama.closure_lag', repo, pr: prNumber, headSha: pr.headSha,
          eligible_at: new Date(pr.eligibleAt).toISOString(), merged_at: new Date(end).toISOString(), lag_ms: lagMs });
        state.samples.push({ at: now, lagMs, pr: key, reason: pr.reason });
      }
      pr.terminal = true;
      pr.terminalAt = now;
      delete pr.closerSeenAt;
    }
    for (const [name, value] of Object.entries(state.prs)) {
      if (value.terminalAt < now - 86400000) delete state.prs[name];
    }
    state.samples = state.samples.filter((sample) => sample.at >= now - 86400000).slice(-10000);
    const pending = Object.entries(state.prs).filter(([, value]) => value.eligibleAt != null && !value.terminal);
    const lags = [...state.samples.map((sample) => sample.lagMs), ...pending.map(([, value]) => Math.max(0, now - value.eligibleAt))].sort((a, b) => a - b);
    const p95 = lags.length ? lags[Math.ceil(lags.length * 0.95) - 1] : 0;
    events.push({ event: 'ama.closure_queue_depth', value: pending.length, p95_lag_ms: p95 });
    const blockers = pending.map(([name, value]) => ({ pr: name, reason: value.reason, lag_ms: now - value.eligibleAt }));
    const breaches = [];
    const addBreach = (id, details) => {
      if (!state.breaches[id]) {
        const event = { event: 'ama.closure_lag.slo_breach', severity: 'SEV1', id, occurred_at: new Date(now).toISOString(), ...details };
        state.breaches[id] = { event, paged: false };
        events.push(event);
      }
      if (!state.breaches[id].paged) breaches.push(state.breaches[id].event);
    };
    if (sloMs != null) state.sloMs = Math.max(1, Number(sloMs) || 1800000);
    const limit = state.sloMs || 1800000;
    if (p95 > limit) addBreach('p95', { p95_lag_ms: p95, slo_ms: limit, blockers,
      completed: state.samples.filter((sample) => sample.lagMs > limit).map(({ pr, reason, lagMs }) => ({ pr, reason, lag_ms: lagMs })) });
    else if (state.breaches.p95?.paged) delete state.breaches.p95;
    for (const blocker of blockers) {
      if (blocker.lag_ms > 3600000) addBreach(`pr:${blocker.pr}`, blocker);
    }
    return { events, breaches };
  });
  for (const event of result.events) {
    const sink = event.severity === 'SEV1' ? (logger?.error || logger?.info) : logger?.info;
    sink?.call(logger, JSON.stringify(event));
  }
  for (const event of result.breaches) {
    try {
      await pageImpl(`SEV1 AMA closure lag: ${JSON.stringify(event)}`, { event: event.event, payload: event });
      locked(rootDir, (state) => { if (state.breaches[event.id]) state.breaches[event.id].paged = true; });
    } catch (error) { logger?.error?.(`AMA closure-lag page failed: ${error.message}`); }
  }
  return result;
}

export function closureLagAlertId(payload) {
  return `ama-closure-lag-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
