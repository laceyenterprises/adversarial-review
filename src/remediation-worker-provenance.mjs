// Worker commit-provenance helpers for the follow-up remediation pipeline.
//
// Extracted VERBATIM from src/follow-up-remediation.mjs (ARC-19 wave12). Groups
// the three concerns that together stamp durable provenance on remediation
// commits: the git identity each worker class commits under
// (remediationWorkerGitIdentity), the Worker-Class provenance trailer the
// commit-msg hook stamps (remediationWorkerTrailerClass + its class constants),
// and the commit-msg hook installation itself (installWorkerProvenanceHook +
// resolveEffectiveGitHooksDir). Behavior-preserving: ROOT is recomputed from
// this module's own location (same src/ dir), matching the monolith's ROOT.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const WORKER_PROVENANCE_HOOK_SRC = join(ROOT, 'hooks', 'worker-provenance-commit-msg');

// Default identity each remediation-worker class commits under. Without
// these, the workspace inherits the operator's global git config and every
// remediation commit looks like the human operator wrote it. The defaults
// are pure constants — no env reads at module-load time — so the resolver
// below can pick up env overrides at call time, even if they are exported
// after this process has started.
const REMEDIATION_WORKER_IDENTITY_DEFAULTS = {
  codex: {
    name: 'Codex Remediation Worker',
    email: 'codex-remediation-worker@laceyenterprises.com',
  },
  'claude-code': {
    name: 'Claude Code Remediation Worker',
    email: 'claude-code-remediation-worker@laceyenterprises.com',
  },
  gemini: {
    name: 'Gemini Remediation Worker',
    email: 'gemini-remediation-worker@laceyenterprises.com',
  },
};

// Broker provider each remediation-worker class authenticates its git push /
// gh calls through. Keyed off the CONCRETE physical spawn class so a
// remediation worker pushes as its OWN harness App (lacey-<harness>-agent[bot]),
// never a fixed merge-agent identity routed in from a different class. This is
// the push-side twin of remediationWorkerGitIdentity above: identity = who the
// commit is authored by AND who the push authenticates as, both keyed on the
// physical harness unless the remediation must modify workflow files.
//
// The slugs are the exact providers the loopback OAuth broker (:4099
// /token?provider=) vends and that the worker-pool builder push path
// (modules/worker-pool/lib/hq-gh.sh: CODEX_WORKER_GH_TOKEN ->
// github-app-codex-agent, CLAUDE_WORKER_GH_TOKEN -> github-app-claude-agent,
// GEMINI_WORKER_GH_TOKEN -> github-app-gemini-agent) already maps for builder
// workers. All three were verified to hold contents:write on
// laceyenterprises/{adversarial-review,agent-os} on 2026-08-08 via a
// throwaway-ref create/delete probe against each App's broker-minted token.
const REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS = {
  codex: 'github-app-codex-agent',
  'claude-code': 'github-app-claude-agent',
  gemini: 'github-app-gemini-agent',
};

// Merge-agent push provider. Used as a loud fallback when a physical harness has
// no known push-capable App of its own, and as the intentional workflow-file
// provider because only merge-agent has workflows:write.
const MERGE_AGENT_FALLBACK_PUSH_PROVIDER = 'github-app-merge-agent';
const WORKFLOW_PUSH_PROVIDER = 'github-app-merge-agent';

// Physical harnesses whose own GitHub App is known (and was verified) to hold
// contents:write on the fleet's PR repos. A harness absent here trips the
// merge-agent fallback (loud + audited) rather than silently failing the push:
// the operator action is to grant the per-harness App push access and add the
// harness here.
const REMEDIATION_PUSH_CAPABLE_HARNESSES = new Set(['codex', 'claude-code', 'gemini']);

// Resolve the broker push provider for a physical harness class. Precedence:
//   1. workflow-file remediation requirement -> merge-agent App
//   2. explicit per-harness override env OAUTH_BROKER_REMEDIATION_<CLASS>_PROVIDER
//      (rotation / staging; still binds the push to THIS harness, so honored).
//   3. the per-harness default, iff the harness is known push-capable.
//   4. the merge-agent fallback (loud + audited) for any harness without a known
//      push-capable App.
// Read at call time (not module-load), mirroring remediationWorkerGitIdentity,
// so a long-running daemon picks up an override without a restart. The legacy
// OAUTH_BROKER_MERGE_AGENT_PROVIDER env is intentionally NOT consulted here — it
// was the #5058 bug vector (a fixed merge-agent provider hijacking every
// harness) and is replaced by this harness-keyed resolution.
function remediationWorkerPushProvider(workerClass, env = process.env, { requiresWorkflowPush = false } = {}) {
  const workflowPushRequired = requiresWorkflowPush
    || String(env.ADVERSARIAL_REMEDIATION_WORKER_REQUIRES_WORKFLOW_PUSH || '').trim().toLowerCase() === 'true';
  if (workflowPushRequired) {
    return {
      provider: WORKFLOW_PUSH_PROVIDER,
      source: 'workflow-push-merge-agent',
      harnessClass: workerClass,
      honored: false,
      fellBack: false,
      warning: null,
      requiresWorkflowPush: true,
    };
  }
  const envSuffix = String(workerClass || '').toUpperCase().replace(/-/g, '_');
  const override = envSuffix
    ? String(env[`OAUTH_BROKER_REMEDIATION_${envSuffix}_PROVIDER`] || '').trim()
    : '';
  if (override) {
    return {
      provider: override,
      source: 'harness-override',
      harnessClass: workerClass,
      honored: true,
      fellBack: false,
      warning: null,
      requiresWorkflowPush: false,
    };
  }
  const harnessProvider = REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS[workerClass] || null;
  if (harnessProvider && REMEDIATION_PUSH_CAPABLE_HARNESSES.has(workerClass)) {
    return {
      provider: harnessProvider,
      source: 'physical-harness',
      harnessClass: workerClass,
      honored: true,
      fellBack: false,
      warning: null,
      requiresWorkflowPush: false,
    };
  }
  const warning =
    `remediation harness ${JSON.stringify(workerClass)} has no known push-capable broker App; ` +
    `falling back to ${MERGE_AGENT_FALLBACK_PUSH_PROVIDER}. The push will NOT authenticate as the ` +
    `physical harness. Operator action: grant the per-harness GitHub App push (contents:write) ` +
    `access on the PR repos, then add the harness to REMEDIATION_PUSH_CAPABLE_HARNESSES.`;
  return {
    provider: MERGE_AGENT_FALLBACK_PUSH_PROVIDER,
    source: 'merge-agent-fallback',
    harnessClass: workerClass,
    honored: false,
    fellBack: true,
    warning,
    requiresWorkflowPush: false,
  };
}

// The Worker-Class trailer this pipeline stamps on commits via the
// commit-msg hook. Different from the worker-model class — encodes
// role+model so audit trails can distinguish remediation work from other
// codex-class work elsewhere (e.g. modules/worker-pool dispatch workers
// also use the codex model but for a different purpose). Kept as a fixed
// constant rather than composed from the workerClass parameter so the
// trailer value is stable across spawn-site refactors.
const REMEDIATION_WORKER_TRAILER_CLASS = 'codex-remediation';

// Gemini remediation provenance class. Distinct from the `gemini` model
// worker class (used elsewhere as a builder), mirroring how
// `codex-remediation` distinguishes remediation work from other codex-class
// work. Stamped on commits via the WORKER_CLASS env the commit-msg hook
// reads, so the audit trail can tell a Gemini remediation commit apart from
// a Gemini-built PR's own commits.
const GEMINI_REMEDIATION_WORKER_TRAILER_CLASS = 'gemini-remediation';

// Map a resolved remediation worker class to the provenance trailer class the
// commit-msg hook stamps. The direct-CLI spawns set this via the spawn env;
// the hq-dispatch path can't (the worker-pool spawns the worker), so the
// remediation prompt tells the worker which trailer to set at commit time —
// buildRemediationPrompt threads this through. Defaults to the codex trailer
// for back-compat with callers that don't specify a class.
function remediationWorkerTrailerClass(workerClass) {
  switch (workerClass) {
    case 'gemini':
      return GEMINI_REMEDIATION_WORKER_TRAILER_CLASS;
    case 'claude-code':
      return 'claude-code-remediation';
    case 'codex':
    default:
      return REMEDIATION_WORKER_TRAILER_CLASS;
  }
}

// Sentinel marker the install path uses to detect "this dest is already our
// hook" without doing brittle byte-for-byte content compares. The marker
// lives on a comment line near the top of hooks/worker-provenance-commit-msg.
const WORKER_PROVENANCE_HOOK_SENTINEL = 'managed-by: adversarial-review-worker-provenance';
// Filename used to preserve a pre-existing commit-msg hook when our wrapper
// is installed on top. The wrapper invokes this chained file before appending
// provenance trailers, so existing commit policy (DCO/signoff, message
// validation, etc.) is preserved instead of silently disabled.
const WORKER_PROVENANCE_CHAINED_HOOK_FILENAME = 'commit-msg.worker-provenance-chain';

// Each class supports an env-var override for ops flexibility:
//
//   REMEDIATION_WORKER_GIT_NAME_<CLASS>   /  REMEDIATION_WORKER_GIT_EMAIL_<CLASS>
//
// where <CLASS> is the upper-snake-case form of the worker class
// (e.g. claude-code → CLAUDE_CODE). Resolved at call time, not module-load
// time, so a long-running consumer can pick up identity changes without
// being restarted.
function remediationWorkerGitIdentity(workerClass, env = process.env) {
  const defaults = REMEDIATION_WORKER_IDENTITY_DEFAULTS[workerClass];
  if (!defaults) {
    throw new Error(
      `unknown remediation worker class: ${JSON.stringify(workerClass)}; ` +
      `cannot determine git identity. Add an entry to ` +
      `REMEDIATION_WORKER_IDENTITY_DEFAULTS in src/follow-up-remediation.mjs.`
    );
  }
  const envSuffix = String(workerClass).toUpperCase().replace(/-/g, '_');
  const name = env[`REMEDIATION_WORKER_GIT_NAME_${envSuffix}`] || defaults.name;
  const email = env[`REMEDIATION_WORKER_GIT_EMAIL_${envSuffix}`] || defaults.email;
  if (!name || !email) {
    throw new Error(
      `remediation worker git identity for ${JSON.stringify(workerClass)} resolved to empty name or email`
    );
  }
  return { name, email };
}

function resolveEffectiveGitHooksDir(workspaceDir, { execFileSyncImpl = execFileSync } = {}) {
  // Ask git itself for the hooks dir so we honor core.hooksPath. Hard-coding
  // `.git/hooks` would silently install a no-op when an operator or repo has
  // configured a custom hooks path, turning the audit trail into a lie.
  try {
    const stdout = execFileSyncImpl('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const relPath = String(stdout).trim();
    if (relPath) {
      return isAbsolute(relPath) ? relPath : resolve(workspaceDir, relPath);
    }
  } catch {
    // git not available, or the workspace isn't a real repo (e.g. a unit test
    // with a bare `.git` placeholder). Fall through to the conservative
    // default; production always runs after `gh repo clone`, so the try
    // branch is the live path.
  }
  return join(workspaceDir, '.git', 'hooks');
}

function installWorkerProvenanceHook(workspaceDir, { execFileSyncImpl = execFileSync } = {}) {
  const hooksDir = resolveEffectiveGitHooksDir(workspaceDir, { execFileSyncImpl });
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }
  const dest = join(hooksDir, 'commit-msg');
  const chainedDest = join(hooksDir, WORKER_PROVENANCE_CHAINED_HOOK_FILENAME);

  // If a commit-msg hook already exists at the dest and it isn't ours, move
  // it aside so our wrapper can chain to it instead of clobbering it. Repo
  // or operator policy (DCO/signoff, message validation, ticket tagging)
  // must survive installation of this wrapper.
  if (existsSync(dest)) {
    let existing = '';
    try {
      existing = readFileSync(dest, 'utf8');
    } catch {
      existing = '';
    }
    const isAlreadyOurs = existing.includes(WORKER_PROVENANCE_HOOK_SENTINEL);
    if (!isAlreadyOurs && !existsSync(chainedDest)) {
      renameSync(dest, chainedDest);
      try {
        chmodSync(chainedDest, 0o755);
      } catch {
        // Some filesystems (e.g. sandboxed test envs) won't allow chmod;
        // the chained hook only needs to be executable for the wrapper to
        // invoke it, and rename preserves the original mode. If chmod
        // fails, leave the existing mode untouched.
      }
    }
    // If the dest is already ours, fall through and overwrite — that's the
    // documented idempotency contract: the deployed hook never drifts from
    // the source on this branch.
  }

  copyFileSync(WORKER_PROVENANCE_HOOK_SRC, dest);
  chmodSync(dest, 0o755);
  return dest;
}

export {
  REMEDIATION_WORKER_IDENTITY_DEFAULTS,
  REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS,
  MERGE_AGENT_FALLBACK_PUSH_PROVIDER,
  REMEDIATION_PUSH_CAPABLE_HARNESSES,
  REMEDIATION_WORKER_TRAILER_CLASS,
  GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
  remediationWorkerTrailerClass,
  remediationWorkerGitIdentity,
  remediationWorkerPushProvider,
  WORKER_PROVENANCE_HOOK_SRC,
  installWorkerProvenanceHook,
};
