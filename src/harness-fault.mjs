// Execution failures are not adversarial verdicts. A wall-clock expiry alone
// remains unknown: only explicit workspace-wait evidence makes it refundable.
export function isHarnessFault(value) {
  const text = String(value || '').toLowerCase().replaceAll('_', '-');
  return /\b(?:provision-failed|checkout-failed|workspace-(?:wait|unavailable|timeout)|controller-setup-failed|helper-(?:bootstrap-failed|timeout)|quota-exhausted|provider-quota-exhausted|credential-outage|oauth-broken|token-refresh-pending|hcp-unavailable|attestation-sign-failed|infra-runtime-missing-library)\b/.test(text)
    || /(?:wall-clock|wall clock)[\s\S]{0,160}(?:waiting for|workspace wait)/.test(text)
    || /(?:waiting for|workspace wait)[\s\S]{0,160}(?:wall-clock|wall clock)/.test(text);
}
