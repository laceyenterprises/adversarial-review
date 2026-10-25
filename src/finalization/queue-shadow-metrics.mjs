// Metrics from durable lifecycle events, never from poll counts or predictions.
import { QUEUE_ACTIONABLE_PHASES } from './ledger-events.mjs';
import { handoffDigest } from './queue-handoff.mjs';

export function buildQueueShadowMetrics(observations, { from, to, source }) {
  const start = Date.parse(from), end = Date.parse(to), hours = (end - start) / 3_600_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new TypeError('queue metrics require a finite increasing window');
  const pairs = new Map(), histories = new Map();
  const unknown = new Set();
  for (const o of observations) {
    if (o.queue?.source !== source || Date.parse(o.observedAt) > end) continue;
    if (o.foldError) {
      if (Date.parse(o.observedAt) >= start) unknown.add(o.dedupeKey ?? o.id ?? handoffDigest(o));
      continue;
    }
    pairs.set(o.dedupeKey ?? o.id ?? handoffDigest(o), o);
    for (const event of o.queue.lifecycle ?? []) {
      if (!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) > end) continue;
      const id = event.entry?.entryId ?? event.entryId;
      const key = handoffDigest([event.lane, id]);
      if (!histories.has(key)) histories.set(key, new Map());
      histories.get(key).set(handoffDigest(event), event);
    }
  }
  const lanes = new Map();
  for (const history of histories.values()) {
    const events = [...history.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)
      || (a.patch?.progressVersion ?? 0) - (b.patch?.progressVersion ?? 0));
    const first = events.find(e => e.type === 'acknowledged');
    if (!first) continue; // No invented arrival or service denominator.
    const laneKey = handoffDigest(first.lane);
    if (!lanes.has(laneKey)) lanes.set(laneKey, { lane: first.lane, entries: 0, arrivals: 0, merges: 0,
      returnsToRemediation: 0, infrastructureParks: 0, totalServiceTimeMs: 0, serviceTimeSamples: 0,
      infrastructureWaitMs: 0, infrastructureParkMs: 0, holdPermissionMs: 0, oldestReadyAgeMs: null });
    const m = lanes.get(laneKey);
    m.entries++;
    const inWindow = at => Date.parse(at) >= start && Date.parse(at) <= end;
    if (inWindow(first.at)) m.arrivals++;
    let entry = first.entry, readinessAt = first.at, serviceStart = null;
    for (let i = 0; i < events.length; i++) {
      const event = events[i], prior = entry;
      if (event.type === 'progress') entry = { ...entry, ...event.patch };
      if (entry.readinessSeq !== prior.readinessSeq) readinessAt = event.at;
      if (entry.phase === 'rebasing' && serviceStart === null) serviceStart = Date.parse(event.at);
      if (entry.phase !== prior.phase) {
        const mergeAt = entry.merge?.mergedAt ?? event.at;
        if (entry.phase === 'merged' && inWindow(mergeAt)) {
          m.merges++;
          if (serviceStart !== null && Date.parse(mergeAt) >= serviceStart) {
            m.totalServiceTimeMs += Date.parse(mergeAt) - serviceStart; m.serviceTimeSamples++;
          }
        }
        if (entry.phase === 'returned-to-closer' && inWindow(event.at)) m.returnsToRemediation++;
        if (entry.phase === 'parked-infrastructure' && inWindow(event.at)) m.infrastructureParks++;
      }
      const until = Date.parse(events[i + 1]?.at ?? to);
      const interval = Math.max(0, Math.min(end, until) - Math.max(start, Date.parse(event.at)));
      if (entry.phase === 'waiting-checks') m.infrastructureWaitMs += interval;
      if (entry.phase === 'parked-infrastructure') m.infrastructureParkMs += interval;
      if (['parked-hold', 'parked-permission'].includes(entry.phase)) m.holdPermissionMs += interval;
    }
    if (QUEUE_ACTIONABLE_PHASES.includes(entry.phase)) m.oldestReadyAgeMs = Math.max(m.oldestReadyAgeMs ?? 0, end - Date.parse(readinessAt));
  }
  return { source, window: { from, to, hours }, unknownPairs: unknown.size,
    observationPairs: [...pairs.values()].filter(o => Date.parse(o.observedAt) >= start).length,
    denominator: 'unique durable entry admissions; rates per requested window hour; completed service rebasing-to-merged',
    timing: 'durable lifecycle timestamps; service includes waits/parking; remediation execution occurs outside the queue and is unmeasured',
    lanes: [...lanes.values()].map(m => ({ ...m, serviceTimeMeanMs: m.serviceTimeSamples ? m.totalServiceTimeMs / m.serviceTimeSamples : null,
      arrivalsPerHour: m.arrivals / hours, mergesPerHour: m.merges / hours,
      returnsToRemediationPerHour: m.returnsToRemediation / hours })) };
}
