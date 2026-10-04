// Diagnostics only. This state never authorizes a merge or releases a lease.
import fsExt from 'fs-ext';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const flock = promisify(fsExt.flock);

async function locked(rootDir, action, logger = console) {
  const dir = join(rootDir, 'data', 'ama-closure-lag');
  await mkdir(dir, { recursive: true });
  const lock = await open(join(dir, 'state.lock'), 'a');
  let acquired = false;
  try {
    const deadline = Date.now() + 1000;
    for (;;) {
      try { await flock(lock.fd, 'exnb'); acquired = true; break; }
      catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code) || Date.now() >= deadline) throw error;
        // Never occupy a libuv worker waiting for the holder's async IO.
        await delay(25);
      }
    }
    const path = join(dir, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) {
        const quarantine = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
        await rename(path, quarantine);
        logger?.error?.(`AMA closure-lag corrupt state quarantined: ${quarantine}`);
      } else if (error.code !== 'ENOENT') throw error;
      state = { prs: {}, samples: [], breaches: {} };
    }
    const before = JSON.stringify(state);
    const result = action(state);
    for (const id of Object.keys(state.breaches)) {
      if (id.startsWith('pr:')) {
        const pr = state.prs[id.slice(3)];
        if (!pr || pr.terminal || pr.eligibleAt == null) delete state.breaches[id];
      }
    }
    if (JSON.stringify(state) === before) return result;
    const tmpPath = join(dir, `.state.${randomUUID()}.tmp`);
    try {
      const tmp = await open(tmpPath, 'wx', 0o644);
      try { await tmp.writeFile(`${JSON.stringify(state)}\n`); await tmp.sync(); }
      finally { await tmp.close(); }
      await rename(tmpPath, path);
      // As with writeFileAtomic, parent-directory durability is best-effort.
      try {
        const parent = await open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      } catch { /* the replacement is already visible */ }
    } finally { await rm(tmpPath, { force: true }); }
    return result;
  } finally {
    try { if (acquired) await flock(lock.fd, 'un'); }
    finally { await lock.close(); }
  }
}

export async function observeCloserBacklog({ rootDir, repo, prNumber, now = Date.now(), logger = console }) {
  return locked(rootDir, (state) => {
    const key = `${repo}#${prNumber}`;
    state.prs[key] ??= {};
    if (state.prs[key].terminal) state.prs[key] = {};
    state.prs[key].closerSeenAt = now;
    // A stale observation is not a current eligible backlog. Active launches
    // are counted independently by the caller and retain their exclusivity.
    return Object.values(state.prs).filter((pr) => pr.closerSeenAt >= now - 600000 && !pr.terminal).length;
  }, logger);
}

async function page(text, options) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('offline tests must inject pageImpl');
  const { deliverAlert } = await import('../alert-delivery.mjs');
  return deliverAlert(text, options);
}

export async function observeClosureLag({ rootDir, repo, prNumber, headSha, eligible = null,
  merged = false, closed = false, mergedAt = null, reason = null,
  now = Date.now(), sloMs = null, logger = console, pageImpl = page }) {
  const result = await locked(rootDir, (state) => {
    const key = `${repo}#${prNumber}`;
    let pr = state.prs[key];
    if (!pr) pr = state.prs[key] = {};
    if (!merged && !closed && (eligible === false || (headSha && pr.headSha && headSha !== pr.headSha) || (eligible && pr.terminal))) {
      pr = state.prs[key] = { headSha };
      delete state.breaches[`pr:${key}`];
    }
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
    const blockers = pending.map(([name, value]) => ({ pr: name, reason: String(value.reason).slice(0, 160), lag_ms: now - value.eligibleAt }));
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
    const completed = state.samples.filter((sample) => sample.lagMs > limit).map(({ pr, reason, lagMs }) => ({ pr, reason, lag_ms: lagMs }));
    const top = (items) => items.sort((a, b) => b.lag_ms - a.lag_ms).slice(0, 5)
      .map((item) => ({ ...item, pr: String(item.pr).slice(0, 120), reason: String(item.reason).slice(0, 160) }));
    if (p95 > limit) addBreach('p95', { p95_lag_ms: p95, slo_ms: limit,
      blockers: top([...blockers]), blockers_omitted: Math.max(0, blockers.length - 5),
      completed: top(completed), completed_omitted: Math.max(0, completed.length - 5) });
    else delete state.breaches.p95;
    for (const blocker of blockers) {
      if (blocker.lag_ms > 3600000) addBreach(`pr:${blocker.pr}`, blocker);
    }
    return { events, breaches };
  }, logger);
  for (const event of result.events) {
    const sink = event.severity === 'SEV1' ? (logger?.error || logger?.info) : logger?.info;
    sink?.call(logger, JSON.stringify(event));
  }
  for (const event of result.breaches) {
    try {
      await pageImpl(`SEV1 AMA closure lag: ${JSON.stringify(event)}`.slice(0, 3500), { event: event.event, payload: event });
      await locked(rootDir, (state) => { if (state.breaches[event.id]) state.breaches[event.id].paged = true; });
    } catch (error) { logger?.error?.(`AMA closure-lag page failed: ${error.message}`); }
  }
  return result;
}

export function closureLagAlertId(payload) {
  return `ama-closure-lag-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
