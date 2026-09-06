export const MERGE_CAPABILITY_ENFORCEMENT_MODES = Object.freeze(['observe', 'enforce']);

const BUILDER_TOKEN_CLASSES = new Set([
  'builder',
  'builder-class',
  'codex',
  'claude-code',
  'gemini',
  'clio-agent',
  'codex-agent',
  'claude-agent',
  'gemini-agent',
  'github-app-codex-agent',
  'github-app-claude-agent',
  'github-app-gemini-agent',
  'lacey-codex-agent',
  'lacey-claude-agent',
  'lacey-gemini-agent',
]);

const MERGE_CAPABLE_TOKEN_CLASSES = new Set([
  'merge-agent',
  'hammer',
  'hammer-claude',
  'the-hammer',
  'github-app-merge-agent',
  'lacey-merge-agent',
  'the-hammer-lacey',
]);

const EXPLICIT_CLASS_ENV_NAMES = [
  'AGENT_OS_GITHUB_TOKEN_CLASS',
  'AGENT_OS_MERGE_TOKEN_CLASS',
  'GITHUB_TOKEN_CLASS',
  'GH_TOKEN_CLASS',
  'HQ_GITHUB_TOKEN_CLASS',
  'OAUTH_BROKER_TOKEN_CLASS',
];

const PROVIDER_ENV_NAMES = [
  'OAUTH_BROKER_PROVIDER',
  'OAUTH_BROKER_GITHUB_APP_PROVIDER',
  'OAUTH_BROKER_MERGE_AGENT_PROVIDER',
  'OAUTH_BROKER_HAMMER_PROVIDER',
  'OAUTH_BROKER_CODEX_PROVIDER',
  'OAUTH_BROKER_CLAUDE_PROVIDER',
  'OAUTH_BROKER_GEMINI_PROVIDER',
  'OAUTH_BROKER_CODEX_REVIEWER_PROVIDER',
  'OAUTH_BROKER_CLAUDE_REVIEWER_PROVIDER',
  'OAUTH_BROKER_GEMINI_REVIEWER_PROVIDER',
];

function normalizeTokenClass(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

export function normalizeMergeCapabilityEnforcementMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return MERGE_CAPABILITY_ENFORCEMENT_MODES.includes(normalized) ? normalized : 'observe';
}

export function resolveMergeCredentialClass({ credentialClass = null, env = process.env } = {}) {
  const explicit = normalizeTokenClass(credentialClass);
  if (explicit) return { tokenClass: explicit, source: 'argument' };

  for (const name of EXPLICIT_CLASS_ENV_NAMES) {
    const tokenClass = normalizeTokenClass(env?.[name]);
    if (tokenClass) return { tokenClass, source: `env:${name}` };
  }
  for (const name of PROVIDER_ENV_NAMES) {
    const provider = normalizeTokenClass(env?.[name]);
    if (provider && (BUILDER_TOKEN_CLASSES.has(provider) || MERGE_CAPABLE_TOKEN_CLASSES.has(provider))) {
      return { tokenClass: provider, source: `env:${name}` };
    }
  }
  return { tokenClass: '', source: null };
}

export function isBuilderMergeCredentialClass(value) {
  return BUILDER_TOKEN_CLASSES.has(normalizeTokenClass(value));
}

export function isMergeCapableCredentialClass(value) {
  return MERGE_CAPABLE_TOKEN_CLASSES.has(normalizeTokenClass(value));
}

export function evaluateMergeCapabilityEnforcement({
  enforcement = 'observe',
  credentialClass = null,
  env = process.env,
  logger = console,
  surface = 'merge',
  repo = null,
  prNumber = null,
  head = null,
  mergeMethod = null,
} = {}) {
  const mode = normalizeMergeCapabilityEnforcementMode(enforcement);
  const resolved = resolveMergeCredentialClass({ credentialClass, env });
  const builder = isBuilderMergeCredentialClass(resolved.tokenClass);
  const action = builder && mode === 'enforce' ? 'deny' : builder ? 'would-deny' : 'allow';
  const allowed = action !== 'deny';
  if (builder) {
    logger?.warn?.(JSON.stringify({
      schemaVersion: 1,
      event: 'merge_capability_enforcement',
      mode,
      action,
      surface,
      repo,
      prNumber,
      headSha: head,
      mergeMethod,
      tokenClass: resolved.tokenClass,
      tokenSource: resolved.source,
      reason: 'builder-token-merge-refused',
    }));
  }
  return {
    allowed,
    mode,
    action,
    builder,
    tokenClass: resolved.tokenClass,
    tokenSource: resolved.source,
    reason: builder ? 'builder-token-merge-refused' : null,
  };
}

export function resolveMergeCapabilityEnforcementFromEnv(env = process.env) {
  return normalizeMergeCapabilityEnforcementMode(
    env?.AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_MERGE_CAPABILITY_ENFORCEMENT
      || env?.MERGE_CAPABILITY_ENFORCEMENT
      || 'observe',
  );
}
