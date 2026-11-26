import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubOwnerTokens, githubTargetOwner } from './github-owner-token.mjs';
import { remediationWorkerPushProvider } from './remediation-worker-provenance.mjs';
import { expandClassAliasRecord } from './worker-class-aliases.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { isGitHubRateLimitError } from './rate-limit-throttle.mjs';
import { isDeclaredFollowUpReviewerRole, legacyFollowUpReviewerRole } from './follow-up-reviewer-identity.mjs';

export const OWNER_AUTH_HOLD = 'remediation-owner-auth-hold';
const DEFAULT_HQ_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const WORKER_ROLES = expandClassAliasRecord({ codex: 'codex', 'remediator-codex': 'codex',
  'claude-code': 'claude', 'remediator-claude': 'claude', gemini: 'gemini',
  'remediator-gemini': 'gemini', 'remediator-grok': 'grok-agent' });
const ROLE_TOKEN_VARS = { codex: 'CODEX_WORKER_GH_TOKEN', claude: 'CLAUDE_WORKER_GH_TOKEN',
  gemini: 'GEMINI_WORKER_GH_TOKEN', 'grok-agent': 'GROK_WORKER_GH_TOKEN',
  'merge-agent': 'MERGE_AGENT_GH_TOKEN' };

export function ownerAuthHold(repo, capability, reason) {
  const owner = githubTargetOwner(`repos/${repo}`);
  return Object.assign(new Error(`GitHub owner ${owner || 'unknown'} requires ${capability} for ${repo} (${reason}).`),
    { code: OWNER_AUTH_HOLD, owner, capability, reason });
}

function networkEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:GIT_CONFIG|GIT_TRACE|GIT_CURL_VERBOSE|GIT_SSL_NO_VERIFY|GIT_ASKPASS|SSH_ASKPASS|GIT_DIR$|GIT_COMMON_DIR$|GIT_WORK_TREE$)/.test(key)
    && !/(?:^|_)(?:GH|GITHUB)(?:_[A-Z0-9]+)*_TOKEN(?:_|$)/.test(key)
    && !/^(?:ADVERSARIAL_)?REMEDIATION_PUSH_TOKEN(?:_|$)/.test(key)));
}

function scopedGitEnv(env, url, token) {
  const config = [
    ['credential.helper', ''],
    ['credential.interactive', 'false'],
    ['http.extraHeader', ''],
    [`http.${url}.extraHeader`, ''],
    [`http.${url}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
    ['http.followRedirects', 'false'],
    [`http.${url}.followRedirects`, 'false'],
    [`http.${url}.sslVerify`, 'true'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
  ];
  return { ...networkEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0',
    HQ_WORKER_PUSH_CREDENTIAL_PREFLIGHT: '0', GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])) };
}

export function remediationOwner(repo, tokens = githubOwnerTokens) {
  if (!repo) return null; // Standalone publisher callers may supply a local Git remote.
  if (!/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repo) || /\/(?:\.|\.\.)$/.test(repo)
    || !githubTargetOwner(`repos/${repo}`)) {
    throw ownerAuthHold(repo, 'repository identity', 'invalid GitHub repository');
  }
  try { return tokens.routedOwner(`repos/${repo}`); }
  catch { throw ownerAuthHold(repo, 'repository owner routing', 'home owner unreadable'); }
}

function route(repo, capability, env, token, provider = null) {
  const url = `https://github.com/${repo}.git`;
  return {
    url, capability, provider,
    gitEnv: scopedGitEnv(env, url, token),
    ghEnv: { ...networkEnv(env), GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1' },
    workerEnv: currentEnv => ({ ...scopedGitEnv(currentEnv, url, token),
      GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1' }),
    async run(operation) {
      try { return await operation(); }
      catch (error) {
        if (error?.budgetDeferred || isGitHubRateLimitError(error)) throw error;
        const detail = [error?.message, error?.stderr, error?.stdout].join('\n');
        if (/repository not found|\bHTTP[ /](?:401|403|404)\b|returned error: (?:401|403|404)\b|permission .*denied|write access .*not granted|authentication (?:failed|required)|bad credentials|could not read (?:username|password)|refus(?:ed|ing) to allow .*workflow/i.test(detail)) {
          throw ownerAuthHold(repo, capability, 'GitHub refused the selected route');
        }
        throw error;
      }
    },
  };
}

// Read authority follows the review that queued the job. Callers without a
// recorded reviewer must supply a recognized legacy reviewer model.
export async function selectRemediationReadRoute({ repo, reviewerRole, reviewerModel, env = process.env, tokens = githubOwnerTokens }) {
  if (!remediationOwner(repo, tokens)) return null;
  const legacyRole = legacyFollowUpReviewerRole(reviewerModel);
  let role;
  if (reviewerRole !== undefined) {
    if (isDeclaredFollowUpReviewerRole(reviewerRole) && (!legacyRole || legacyRole === reviewerRole)) role = reviewerRole;
  } else {
    role = legacyRole;
  }
  const capability = `contents:read (${role || 'follow-up reader'})`;
  if (!role) throw ownerAuthHold(repo, capability, 'no declared reader role');
  try {
    const token = await tokens.select({ role, target: `repos/${repo}`, env, requireSourceToken: false });
    if (!token) throw new Error('missing token');
    return route(repo, capability, env, token);
  } catch { throw ownerAuthHold(repo, capability, 'owner reader route unavailable'); }
}

// Reuse HQ's broker opt-in, role, bearer and fetch gate. The GitHub adapter
// resolves App identity from config for the exact repository.
const RESOLVE_PUSH_TOKEN = `set -euo pipefail
source "$1"
export HQ_GITHUB_TARGET_REPO="$4" HQ_GITHUB_TARGET_OWNER="$5"
hq_gh_require_local_publication
if ! _hq_token_broker_auth_enabled "$2"; then
  printf '%s\\n' '{"check":"owner route config incomplete or mismatched"}'
  exit 0
fi
_hq_prepare_token_broker_env "$2"
prefix="$(_hq_token_broker_env_prefix "$2")"
provider="\${prefix}_PROVIDER"
role="$(_hq_token_broker_cfg_slug "$2")"
if [[ "$role" != "$8" || "\${!provider:-}" != "$6" || -z "\${OAUTH_BROKER_SHARED_SECRET_FILE:-}" ]]; then
  printf '%s\\n' '{"check":"owner route config incomplete or mismatched"}'
  exit 0
fi
python="$(hq_require_python3_runtime)"
export PYTHONPATH="$HQ_GH_LIB_DIR/python:$HQ_GH_LIB_DIR/../../github-adapter/src\${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
exec "$python" -P "$3" "$role" "$4" "$6" "$7"
`;
const PUSH_TOKEN_RESOLVER = fileURLToPath(new URL('./remediation-publication-token.py', import.meta.url));

export async function selectRemediationPushRoute({ repo, workerClass, requiresWorkflowPush = false,
  env = process.env, execFileImpl, tokens = githubOwnerTokens }) {
  const owner = remediationOwner(repo, tokens);
  if (!owner) return null;
  const selected = remediationWorkerPushProvider(workerClass, env, { requiresWorkflowPush });
  const needsWorkflow = requiresWorkflowPush || selected.requiresWorkflowPush;
  const capability = `${needsWorkflow ? 'contents:write + workflows:write' : 'contents:write'} (${workerClass || 'remediation harness'})`;
  if (!Object.hasOwn(WORKER_ROLES, workerClass) || selected.fellBack) {
    throw ownerAuthHold(repo, capability, 'no declared harness capability');
  }
  const role = selected.requiresWorkflowPush ? 'merge-agent' : WORKER_ROLES[workerClass];
  const tokenVar = ROLE_TOKEN_VARS[role];
  const hqRoot = String(env.HQ_REPO_ROOT || '').trim() || DEFAULT_HQ_ROOT;
  const helper = join(hqRoot, 'modules/worker-pool/lib/hq-gh.sh');
  // Each stage names its failed check in the hold; no token material reaches it.
  const hold = check => ownerAuthHold(repo, capability, `owner publication route: ${check}`);
  let minted;
  try {
    const { stdout } = await execFileImpl('bash', ['-c', RESOLVE_PUSH_TOKEN, 'remediation-owner-auth', helper,
      tokenVar, PUSH_TOKEN_RESOLVER, repo.toLowerCase(), owner, selected.provider, needsWorkflow ? 'workflow' : 'contents', role], {
      cwd: dirname(helper), env: networkEnv(env), timeout: loadAwareTimeoutMs(25_000), maxBuffer: 128 * 1024,
    });
    minted = JSON.parse(stdout);
  } catch {
    throw hold('owner route resolver unavailable');
  }
  if (minted?.check) throw hold(minted.check);
  const expiresAtMs = typeof minted?.expires_at === 'string' ? Date.parse(minted.expires_at) : NaN;
  if (typeof minted?.token !== 'string' || !minted.token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw hold('minted token missing or expired');
  }
  return route(repo, capability, env, minted.token, selected.provider);
}
