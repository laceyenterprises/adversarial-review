import { detectQuotaExhaustion } from './quota-exhaustion.mjs';

// A worker's final narrative can quote source code containing quota-like text.
// Only the observed provider-owned 429 wrapper is quota evidence there.
const CLAUDE_PROVIDER_429 = /^API Error: Request rejected \(429\)\s*[·:—-]\s*This request would exceed your account['’]s rate limit\b/i;

// Longest a quota hold may park a job without live revalidation, however far
// out the provider-reported reset is. REMFALLBACK-01 also measures a reset
// against it: a cap that outlasts this window is a reason to change remediator
// classes, not to keep holding the capped one.
export const MAX_QUOTA_HOLD_WINDOW_MS = 60 * 60 * 1000;

export function detectRemediationQuotaEvidence({ model, stderrText, finalMessageText }) {
  const finalText = String(finalMessageText || '').trimStart();
  const providerArtifact = CLAUDE_PROVIDER_429.test(finalText) ? finalText.trim() : '';
  const quotaLogText = `worker=${model || 'unknown'}\n${stderrText || ''}\n${providerArtifact}`;
  return { quotaLogText, quotaSignal: detectQuotaExhaustion(quotaLogText) };
}

// Quota-harness / worker-model labels → the remediator worker class they cap.
// Log-derived harness labels say `claude`; worker records say `claude-code`.
const REMEDIATOR_CLASS_BY_QUOTA_LABEL = Object.freeze({
  codex: 'codex',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  gemini: 'gemini',
});

export function remediatorClassForQuotaLabel(value) {
  const label = String(value || '').trim().toLowerCase().replace(/-remediation$/, '');
  return REMEDIATOR_CLASS_BY_QUOTA_LABEL[label] || null;
}

// The remediator class a quota-hold retry entry says was capped. The recorded
// worker class wins over the log-derived harness label, which can be `unknown`.
function cappedClassOfRetryEntry(entry) {
  const meta = entry?.retryMetadata || {};
  return remediatorClassForQuotaLabel(meta.workerClass)
    || remediatorClassForQuotaLabel(entry?.worker?.model)
    || remediatorClassForQuotaLabel(meta.harness);
}

// REMFALLBACK-01 job-local cap evidence: the reset each capped remediator's
// provider reported, as recorded on the job's quota holds. It needs no fleet
// read, so it still holds when `hq fleet quota status` is down. The latest hold
// per class wins, and a reset that has already passed is no evidence at all.
// Returns Map<class, { workerClass, resetAt, resetMs, requeuedAt, pastHoldWindow }>,
// where `pastHoldWindow` means the reset is further out than one hold window.
export function remediatorQuotaEvidence(job, { nowMs = Date.now() } = {}) {
  const latest = new Map();
  for (const entry of job?.remediationPlan?.retryHistory || []) {
    if (entry?.retryMetadata?.code !== 'quota-exhausted') continue;
    const workerClass = cappedClassOfRetryEntry(entry);
    if (workerClass) latest.set(workerClass, entry);
  }
  const evidence = new Map();
  for (const [workerClass, entry] of latest) {
    const meta = entry.retryMetadata;
    const resetMs = Date.parse(String(meta.providerResetAt || meta.resetAt || ''));
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    evidence.set(workerClass, {
      workerClass,
      resetAt: new Date(resetMs).toISOString(),
      resetMs,
      requeuedAt: entry.requeuedAt || null,
      pastHoldWindow: resetMs > nowMs + MAX_QUOTA_HOLD_WINDOW_MS,
    });
  }
  return evidence;
}
