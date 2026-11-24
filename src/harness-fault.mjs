export const SOCKET_PATH_HARNESS_FAULT = 'harness-fault:socket-path';

export function isSocketPathFailure(output) {
  return /sun_path|AF_UNIX path too long|(?:socket|listen|bind)[^\r\n]{0,256}(?:ENAMETOOLONG|path (?:is )?too long)|ENAMETOOLONG[^\r\n]{0,256}(?:socket|\.sock\b)/i.test(output);
}

// Execution failures are not adversarial verdicts. A wall-clock expiry alone
// remains unknown: only explicit workspace-wait evidence makes it refundable.
export function isHarnessFault(value) {
  const text = String(value || '').toLowerCase().replaceAll('_', '-');
  return text === SOCKET_PATH_HARNESS_FAULT
    || /\b(?:provision-failed|checkout-failed|workspace-(?:wait|unavailable|timeout)|controller-setup-failed|helper-(?:bootstrap-failed|timeout)|quota-exhausted|provider-quota-exhausted|credential-outage|oauth-broken|token-refresh-pending|hcp-unavailable|attestation-sign-failed|infra-runtime-missing-library)\b/.test(text)
    || /(?:wall-clock|wall clock)[\s\S]{0,160}(?:waiting for|workspace wait)/.test(text)
    || /(?:waiting for|workspace wait)[\s\S]{0,160}(?:wall-clock|wall clock)/.test(text);
}
