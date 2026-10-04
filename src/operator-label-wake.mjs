import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
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

// Run during discovery, before label consumption and before lane admission.
// Only the existing operator adapter may authorize a revision-scoped event.
export async function observeOperatorLabelWakes({
  rootDir, repo, prNumber, subjectRef, headSha, labelNames, operatorSurface,
  requestWatcherWakeImpl = requestWatcherWake, logger = console,
}) {
  if (!headSha || typeof operatorSurface?.observeLabelControl !== 'function') return [];
  const wakes = [];
  for (const label of OPERATOR_WAKE_LABELS) {
    if (!labelNames.includes(label)) continue;
    const control = await operatorSurface.observeLabelControl(subjectRef, headSha, label);
    if (!control?.applied || !control.actor || !control.eventId || !control.observedAt
      || control.observedRevisionRef !== headSha) continue;
    const digest = createHash('sha256').update(JSON.stringify([repo, prNumber, control.eventId])).digest('hex');
    const receipt = join(rootDir, 'data', 'operator-label-wakes', `${digest}.json`);
    const audit = { repo, prNumber, label, ...control };
    try {
      writeFileAtomic(receipt, JSON.stringify({ ...audit, outcome: 'reserved' }), { overwrite: false });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A crash between reservation and wake must not permanently lose intent.
      if (JSON.parse(readFileSync(receipt, 'utf8')).outcome === 'requested') continue;
    }
    try {
      // This is operator evidence, independent of the capped handler decisions.
      if (!clearNoProgressLane(rootDir, { repo, prNumber }, { logger })) {
        throw new Error('operator label no-progress reset failed');
      }
      const wake = requestWatcherWakeImpl({
        rootDir, repo, prNumber, headSha,
        requestId: `operator-label:${digest}`,
        reason: `operator-label:${label}:${control.eventId}`,
      });
      if (!wake?.requested) throw new Error('operator label watcher wake was not requested');
      writeFileAtomic(receipt, JSON.stringify({ ...audit, outcome: 'requested' }));
      wakes.push(wake);
    } catch (err) {
      rmSync(receipt, { force: true });
      throw err;
    }
  }
  return wakes;
}
