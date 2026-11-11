import { repositoryObservationCache } from '../repository-state-cache.mjs';

const paged = repositoryObservationCache(new Set());

export function isZeroOutputRefusal(error) {
  const text = [error?.message, error?.stderr, error?.stdout,
    typeof error === 'string' ? error : ''].filter(Boolean).join('\n');
  return /\[hq\]\s+dispatch refused: ticket .+ already produced zero output twice\b/i.test(text);
}

// Terminal operator custody, rather than the transient prelaunch retry clock.
// The marker lives on the existing per-head record; no extra attempt budget.
export async function escalateZeroOutputRefusal({
  record, repo, prNumber, headSha, persistImpl, deliverAlertImpl, logger, now,
}) {
  const key = `${repo}#${prNumber}@${headSha}`;
  let next = { ...record, state: 'operator-escalated', owner: 'operator-escalated',
    closureBlocker: 'dispatch-zero-output-refused', prelaunchRefusalSlowRetry: null,
    lastFailureTransient: false };
  const stored = persistImpl(next);
  if (stored?.launchRequestId || stored?.dispatchId || stored?.state !== 'operator-escalated') {
    return { dispatched: false, skipMergeAgent: true, reason: 'closure-owner-changed' };
  }
  if (!next.zeroOutputEscalatedAt && !paged.has(key) && typeof deliverAlertImpl === 'function') {
    try {
      const diagnostic = typeof record.lastError === 'string' ? record.lastError
        : record.lastError?.stderr || record.lastError?.message || record.lastError?.stdout
          || JSON.stringify(record.lastError);
      await deliverAlertImpl(
        `AMA closure for ${key} requires operator action: ${diagnostic}. Automated dispatch stopped.`,
        { event: 'ama_closer.zero_output_operator_escalated', payload: { repo, prNumber, headSha } },
      );
      paged.add(key);
      next = { ...next, zeroOutputEscalatedAt: now || new Date().toISOString() };
      persistImpl(next);
    } catch (error) {
      logger?.warn?.(`Zero-output escalation failed for ${key}: ${error.message}`);
    }
  }
  return { dispatched: false, skipMergeAgent: true, needsOperator: true,
    owner: 'operator-escalated', reason: 'dispatch-zero-output-refused' };
}
