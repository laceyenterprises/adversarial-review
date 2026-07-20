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
  REMEDIATION_WORKER_TRAILER_CLASS,
  GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
  remediationWorkerTrailerClass,
  remediationWorkerGitIdentity,
  WORKER_PROVENANCE_HOOK_SRC,
  installWorkerProvenanceHook,
};
