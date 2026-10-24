// Thin migration boundary, composed only by future lane routing. Frozen legacy
// dispatch and hammer-review-handoff retain their existing behavior.
import { isDeepStrictEqual } from 'node:util';
import { handoffDigest, normalizeQueueHandoff } from '../finalization/queue-handoff.mjs';

export function createCloserQueueHandoffBoundary({ handoffService }) {
  return {
    async handoff(input, { releaseResources, deadline } = {}) {
      const h = normalizeQueueHandoff(input);
      const ack = await handoffService.submit(h, { deadline });
      const confirmed = handoffService.readAcknowledgement(h);
      if (!ack || ack.status !== 'acknowledged' || ack.payloadDigest !== handoffDigest(h)
        || !isDeepStrictEqual(ack, confirmed)) throw new Error('closer handoff unacknowledged');
      // Resource release must itself tolerate retries: a crash after release or
      // a lost reply can replay the same confirmed acknowledgement.
      if (releaseResources) await releaseResources(ack);
      return { outcome: 'queue-handoff-acknowledged', ack };
    },
    async dispatch(key, dispatchCloser) {
      // A storage-only MGQ-01 ack is insufficient. This read requires the full
      // validated handoff receipt; read failures propagate without dispatch.
      const ack = handoffService.readAcknowledgement(key);
      if (ack) return { outcome: 'queue-handoff-acknowledged', ack };
      return dispatchCloser();
    },
  };
}
