import {
  OAuthError,
  resolveClaudeCodeOAuthTransport,
} from './remediation-oauth-preflight.mjs';

export function resolveClaudeReviewerOAuthTransport(env = process.env) {
  const explicitTransportEntries = [
    ['ADVERSARIAL_REVIEW_CLAUDE_REVIEWER_OAUTH_TRANSPORT', env.ADVERSARIAL_REVIEW_CLAUDE_REVIEWER_OAUTH_TRANSPORT],
    ['ADVERSARIAL_REVIEW_CLAUDE_MODEL_OAUTH_TRANSPORT', env.ADVERSARIAL_REVIEW_CLAUDE_MODEL_OAUTH_TRANSPORT],
  ];
  for (const [name, value] of explicitTransportEntries) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) continue;
    if (raw === 'broker') return 'broker';
    if (raw === 'keychain') return 'keychain';
    throw new OAuthError('claude', `${name} must be broker or keychain (found ${JSON.stringify(value)})`);
  }
  const roleFlag = String(env.CLAUDE_REVIEWER_AUTH_VIA_BROKER ?? '').trim().toLowerCase();
  if (roleFlag === 'true') return 'broker';
  if (['false', '0', 'no', 'off', 'keychain'].includes(roleFlag)) return 'keychain';
  return resolveClaudeCodeOAuthTransport(env);
}
