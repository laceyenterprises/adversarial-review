import { detectQuotaExhaustion } from './quota-exhaustion.mjs';

// A worker's final narrative can quote source code containing quota-like text.
// Only the observed provider-owned 429 wrapper is quota evidence there.
const CLAUDE_PROVIDER_429 = /^API Error: Request rejected \(429\)\s*[·:—-]\s*This request would exceed your account['’]s rate limit\b/i;

export function detectRemediationQuotaEvidence({ model, stderrText, finalMessageText }) {
  const finalText = String(finalMessageText || '').trimStart();
  const providerArtifact = CLAUDE_PROVIDER_429.test(finalText) ? finalText.trim() : '';
  const quotaLogText = `worker=${model || 'unknown'}\n${stderrText || ''}\n${providerArtifact}`;
  return { quotaLogText, quotaSignal: detectQuotaExhaustion(quotaLogText) };
}
