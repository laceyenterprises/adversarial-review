import { performance } from 'node:perf_hooks';
import { sanitizeCodexReviewPayload, normalizeEffectiveReviewVerdict } from '../../../kernel/verdict.mjs';
import { classifyReviewerFailure } from '../cli-direct/classification.mjs';
import { detectQuotaExhaustion, quotaHoldDecision } from '../../../quota-exhaustion.mjs';
import { createHostSeatClient } from './host-seat-client.mjs';
import { boundedInteger, freeze, readReviewOrder, sameBinding, sha256 } from './review-order.mjs';

// Every dependency call is bounded, including unavailable control-plane reads.
// Timeout aborts the call; it never asserts that a remote/local child has died.
async function bounded(operation, timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new Error('Execution call cancelled or timed out'));
    };
    timer = setTimeout(onAbort, timeoutMs);
    parentSignal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (parentSignal?.aborted) throw new Error('Execution call cancelled');
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), stopped]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

function readUsage(snapshot) {
  if (!Array.isArray(snapshot.usage) || typeof snapshot.usageComplete !== 'boolean'
    || Buffer.byteLength(JSON.stringify(snapshot.usage)) > 256 * 1024) throw new Error('Invalid usage evidence');
  for (const event of snapshot.usage) {
    if (!event || typeof event.eventId !== 'string' || !event.eventId
      || !['estimate', 'harness-native', 'provider', 'unknown'].includes(event.source)
      || !['estimated', 'measured', 'unknown'].includes(event.quality)) throw new Error('Invalid usage event');
  }
  // Preserve native fields, estimates, revisions and disagreements; no sums or
  // invented zeros. The supervisor's durable outbox owns eventual delivery.
  return snapshot.usage;
}

function readArtifacts(artifacts, budget) {
  if (!Array.isArray(artifacts) || artifacts.length > 64) throw new Error('Invalid artifacts');
  let total = 0;
  const names = new Set();
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(artifact.name)
      || names.has(artifact.name) || typeof artifact.content !== 'string') throw new Error('Invalid artifact');
    names.add(artifact.name);
    const bytes = Buffer.byteLength(artifact.content);
    total += bytes;
    if (total > budget) throw new Error('Artifact budget exceeded');
    // Inline UTF-8 blobs avoid trusting peer paths, symlinks or remote URLs.
    return { name: artifact.name, content: artifact.content, bytes, sha256: sha256(artifact.content) };
  });
}

export function createFederationExecutionAdapter({
  seatTransport, supervisor, verifyOrder, readCurrent, signResult,
  controlTimeoutMs = 5000, now = Date.now,
} = {}) {
  for (const callback of [verifyOrder, readCurrent, signResult, supervisor?.run, supervisor?.snapshot]) {
    if (typeof callback !== 'function') throw new TypeError('Missing execution dependency');
  }
  boundedInteger(controlTimeoutMs, 1, 30_000);
  const seats = createHostSeatClient(seatTransport);
  const control = (operation) => bounded(operation, controlTimeoutMs);
  async function signed(payload) {
    const payloadBytes = JSON.stringify(payload);
    const signature = await control((signal) => signResult(payloadBytes, { signal }));
    if (typeof signature !== 'string' || !signature || signature.length > 4096) throw new Error('Result signing failed');
    return Object.freeze({ payloadBytes, signature });
  }

  return Object.freeze({
    // No watcher registration, discovery, publication, remediation or merge port.
    async execute({ orderBytes, signature, grantId, signal: parentSignal } = {}) {
      const { order, binding } = readReviewOrder(orderBytes);
      if (typeof signature !== 'string' || !signature || signature.length > 4096
        || await control((signal) => verifyOrder(orderBytes, signature, { signal })) !== true) {
        throw new Error('Unauthenticated review order');
      }
      const result = {
        version: 1, binding, status: 'stale', review: null, artifacts: [], usage: [],
        usageComplete: true, failureClass: null, retryAt: null, seatRetained: false,
      };
      if (!sameBinding(await control((signal) => readCurrent(binding, { signal })), binding)) return signed(result);
      if (parentSignal?.aborted) throw new Error('Execution cancelled before seat consumption');
      const requestedAt = performance.now();
      const permit = await control((signal) => seats.consume({ grantId, binding, signal }));
      result.seatRetained = true;
      const remainingMs = Math.floor(Math.min(order.budget.timeoutMs, permit.validForMs - (performance.now() - requestedAt)));
      let runFailed = remainingMs <= 0;
      if (!runFailed) {
        try {
          // The injected supervisor journals before spawn and startOrAttaches by
          // permit.startId. It owns process groups, sandbox, grants and late usage.
          await bounded((signal) => supervisor.run({ order, permit, signal }), remainingMs, parentSignal);
        } catch {
          runFailed = true;
        }
      }
      result.status = 'execution-unknown';
      if (runFailed) result.failureClass = 'execution-interrupted';
      result.usageComplete = false;
      let snapshot;
      try {
        snapshot = freeze(structuredClone(await control((signal) => supervisor.snapshot({ permit, signal }))));
        result.usage = readUsage(snapshot);
        if (!sameBinding(snapshot.binding, binding)) throw new Error('Supervisor binding mismatch');
        result.usageComplete = snapshot.usageComplete;
      } catch {
        // Unknown accounting is visible. The durable supervisor outbox must
        // still deliver late/unavailable evidence; never invent zero spend.
        result.failureClass = 'usage-evidence-unavailable';
        return signed(result);
      }
      let failurePhase = 'invalid-execution-evidence';
      try {
        if (typeof snapshot.output !== 'string' || typeof snapshot.diagnostic !== 'string'
          || Buffer.byteLength(snapshot.output) + Buffer.byteLength(snapshot.diagnostic) > order.budget.maxOutputBytes) {
          throw new Error('Output budget exceeded');
        }
        result.artifacts = readArtifacts(snapshot.artifacts, order.budget.maxArtifactBytes);
        if (!runFailed && snapshot.exitCode === 0 && snapshot.terminationProof) {
          const body = sanitizeCodexReviewPayload(snapshot.output);
          const verdict = normalizeEffectiveReviewVerdict(body);
          if (!verdict || verdict === 'unknown') throw new Error('Missing review verdict');
          result.status = 'completed';
          result.review = { body, verdict };
        } else if (snapshot.exitCode !== null && Number.isInteger(snapshot.exitCode) && snapshot.exitCode !== 0) {
          result.status = 'failed';
          result.failureClass = classifyReviewerFailure(snapshot.diagnostic, snapshot.exitCode);
          if (['quota-exhausted', 'cascade', 'provider-overloaded'].includes(result.failureClass)) {
            const nowMs = now();
            const quota = detectQuotaExhaustion(snapshot.diagnostic, { nowMs });
            const resetAt = Date.parse(quota.resetAt) > nowMs ? quota.resetAt : null;
            const hold = quotaHoldDecision({ failed_at: new Date(nowMs).toISOString(), quota_reset_at_utc: resetAt }, { nowMs });
            result.retryAt = new Date(hold.waitUntilMs).toISOString();
            // Account scope is in the immutable binding, independent of host.
            failurePhase = 'credential-pressure-write-failed';
            await control((signal) => seats.defer({ permit, retryAt: result.retryAt, failureClass: result.failureClass, signal }));
          }
        }
        failurePhase = 'origin-read-failed';
        if (!sameBinding(await control((signal) => readCurrent(binding, { signal })), binding)) {
          result.status = 'stale';
          result.review = null;
        }
        if (snapshot.terminationProof) {
          failurePhase = 'seat-release-failed';
          await control((signal) => seats.finish({ permit, terminationProof: snapshot.terminationProof, signal }));
          result.seatRetained = false;
        }
      } catch {
        result.status = 'execution-unknown';
        result.failureClass = failurePhase;
        result.review = null;
      }
      if (performance.now() - requestedAt >= permit.validForMs) {
        result.status = 'stale';
        result.review = null;
      }
      return signed(result);
    },
  });
}
