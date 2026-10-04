import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { clearNoProgressLane } from './watcher-no-progress-lane.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';

export const OPERATOR_WAKE_LABELS = [
  'merge-agent-requested',
  'retrigger-review',
  'retrigger-remediation',
  'address-all-findings',
  'operator-approved',
];

// Scoped to one discovery pass. Cache promises, including failures, so retrigger
// consumers use the same operator evidence without a second timeline request.
export function createLabelControlObservationCache(operatorSurface) {
  const observations = new Map();
  return (subjectRef, headSha, label) => {
    const key = JSON.stringify([subjectRef.subjectExternalId, headSha, label]);
    if (!observations.has(key)) {
      observations.set(key, Promise.resolve().then(() =>
        operatorSurface.observeLabelControl(subjectRef, headSha, label)));
    }
    return observations.get(key);
  };
}

function readReceipt(receipt, logger) {
  let raw;
  try {
    raw = readFileSync(receipt, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const doc = JSON.parse(raw);
    if (doc?.outcome === 'requested' || doc?.outcome === 'reserved') return doc;
  } catch {
    // Recover a truncated receipt without hiding other filesystem failures.
  }
  logger?.warn?.(`[watcher] corrupt operator label wake receipt ${receipt}; recovering reserved intent`);
  return { outcome: 'reserved' };
}

// Run during discovery, before label consumption and before lane admission.
// Only the existing operator adapter may authorize a revision-scoped event.
export async function observeOperatorLabelWakes({
  rootDir, repo, prNumber, subjectRef, headSha, labelNames, operatorSurface,
  observeLabelControlImpl = operatorSurface?.observeLabelControl?.bind(operatorSurface),
  requestWatcherWakeImpl = requestWatcherWake, logger = console,
  now = Date.now, env = process.env,
}) {
  if (!headSha || typeof observeLabelControlImpl !== 'function') return [];
  const configuredAge = Number(env.ADVERSARIAL_OPERATOR_LABEL_WAKE_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(configuredAge) && configuredAge > 0
    ? configuredAge : 30 * 60 * 1000;
  const wakes = [];
  for (const label of OPERATOR_WAKE_LABELS) {
    if (!labelNames.includes(label)) continue;
    try {
      const control = await observeLabelControlImpl(subjectRef, headSha, label);
      if (!control?.applied || !control.actor || !control.eventId || !control.observedAt
        || control.observedRevisionRef !== headSha) continue;
      const digest = createHash('sha256').update(JSON.stringify([repo, prNumber, control.eventId])).digest('hex');
      const receipt = join(rootDir, 'data', 'operator-label-wakes', `${digest}.json`);
      const audit = { repo, prNumber, label, ...control };
      let existing = readReceipt(receipt, logger);
      if (existing?.outcome === 'requested') continue;
      if (!existing) {
        const observedMs = Date.parse(control.observedAt);
        const ageMs = now() - observedMs;
        if (!Number.isFinite(observedMs) || ageMs < 0 || ageMs > maxAgeMs) continue;
        try {
          writeFileAtomic(receipt, JSON.stringify({ ...audit, outcome: 'reserved' }), { overwrite: false });
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          existing = readReceipt(receipt, logger);
          if (existing?.outcome === 'requested') continue;
        }
      }
      // Request first: a degraded wake path must not repeatedly reset backoff
      // and alert debouncing. Retain reserved intent across any failure.
      const wake = requestWatcherWakeImpl({
        rootDir, repo, prNumber, headSha,
        requestId: `operator-label:${digest}:${randomUUID()}`,
        reason: `operator-label:${label}:${control.eventId}:${digest}`,
      });
      if (!wake?.requested) throw new Error('operator label watcher wake was not requested');
      if (!clearNoProgressLane(rootDir, { repo, prNumber }, { logger })) {
        throw new Error('operator label no-progress reset failed');
      }
      writeFileAtomic(receipt, JSON.stringify({ ...audit, outcome: 'requested' }));
      wakes.push(wake);
    } catch (err) {
      logger?.warn?.(`[watcher] operator label wake failed for ${repo}#${prNumber} label=${label}: ${err?.message || err}`);
    }
  }
  return wakes;
}
