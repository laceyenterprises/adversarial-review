import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoleConfig, resolveDefaultRemediator } from './role-config.mjs';
import { DEFAULT_REMEDIATOR_ENV, markRemediationConfigError } from './remediation-dispatch-mode.mjs';
import { normalizeRemediationWorkerClass } from './remediation-worker-class-fallback.mjs';
import { loadDomainConfig } from './domain-config.mjs';
import { resolveRemediatorWorkerClassFromDomain } from './domain-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The remediation-worker class the consume path spawns by default when
// nothing else applies. With cross-model symmetry restored (see
// `pickRemediationWorkerClass` below), this constant is the fallback for
// jobs missing a usable `builderTag`. The operator env override below can
// still pin the worker class globally without changing durable job records
// or PR-title routing.
const DEFAULT_REMEDIATION_WORKER_CLASS = 'codex';

// Cross-model (adversarial) remediator routing. The remediator runs as
// the OPPOSITE model from the writer, so a second model both reviews AND
// fixes — the writer's blind spots don't get reinforced by a same-model
// fix that pattern-matches on the same wrong intuitions:
//
//   [codex]       → claude-code remediates (writer is codex)
//   [claude-code] → codex remediates       (writer is claude)
//   [clio-agent]  → claude-code remediates (Clio dispatches codex writers)
//
// Pairs with cross-model REVIEW (adapters/subject/github-pr/routing.mjs):
// reviewer and remediator are both adversarial-by-default.
//
// Operators pin globally via `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex`
// or `=claude-code` — the env override wins over per-tag routing for
// budget-squeeze or model-availability scenarios.
const REMEDIATION_WORKER_BY_BUILDER_TAG = Object.freeze({
  codex: 'claude-code',
  'claude-code': 'codex',
  'clio-agent': 'claude-code',
});
// Cascade-aware default remediator resolver. Consults config.yaml FIRST
// (module → top-level → *.local) and env LAST per SPEC §3 resolution
// order. Returns null when no pin is in effect (the per-builder-tag
// cross-model routing in `pickRemediationWorkerClass` then applies).
//
// `defaultRemediatorWorkerClassFromEnv` is kept as a back-compat alias so
// external callers/tests that import the old name keep working; the body
// delegates to the file-cascade resolver. The `_workerClass` flag on the
// error is preserved for the existing
// `consumeNextFollowUpJob` requeue path.
// CFG-02 round-1 review B6 fix (2026-05-30): do not blindly copy
// `err.got` to `requestedValue`. For env-alias conflicts the loader
// puts a multi-value diagnostic string (e.g.
// `'AGENT_OS_X="a", LEGACY_Y="b"'`) into `err.got` — templating that
// into operator-visible messages produces nonsense. Default to null
// and let downstream code use the loader's structured `err.got`
// directly if it wants the raw diagnostic.
//
// CFG-02 round-1 review B1 (mislabel) is deferred to a follow-up
// CFG ticket: gating on `err.key === 'roles.remediator'` /
// `err.envName ∈ ALIASES` breaks back-compat with downstream
// consumeNextFollowUpJob requeue tests. The gate needs paired
// loader changes (consistent err.key/envName population across all
// throw sites) to be safe; track separately.
function defaultRemediatorWorkerClassFromEnv(env = process.env, opts = {}) {
  try {
    return resolveDefaultRemediator({ env, ...opts });
  } catch (err) {
    throw markRemediationConfigError(err, {
      configKey: DEFAULT_REMEDIATOR_ENV,
      requestedValue: null,
    });
  }
}

// Per-PR remediator routing: pair the writer model with the OPPOSITE model
// so a second model both reviews AND fixes (adversarial-by-default). See
// `REMEDIATION_WORKER_BY_BUILDER_TAG` above for the mapping. The reviewer
// also stays cross-model (see `adapters/subject/github-pr/routing.mjs`).
//
// Operators can override the per-PR derivation via
// `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR` when cost or availability requires
// pinning remediation to a specific worker class — e.g. during a codex
// weekly-budget squeeze, set `=claude-code` to force all remediation through
// claude regardless of the original PR's builderTag.
//
// Historical note: LAC-358 previously hard-routed all remediation to codex
// regardless of builderTag. PR #172 (2026-05-29 AM) attempted to restore
// per-tag derivation but landed at same-model (writer remediates itself).
// This PR (#175, 2026-05-29 PM) flipped it back to cross-model
// (adversarial-by-default) — the writer's blind spots don't get reinforced
// by a same-model fix that pattern-matches on the same wrong intuitions.
// The env override provides the same operator escape hatch in either
// direction.
//
// Fallback semantics: when `builderTag` is missing or unknown, derivation falls
// through to `DEFAULT_REMEDIATION_WORKER_CLASS = 'codex'`. This preserves
// "something runs"; operators can pin via `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR`.
// ARC-08: the role-registry default remediator worker class (SPEC §5,
// `roles.registry.remediator.workerClass`). ARC-12 lands the registry and its
// config schema; until then the strict `roles` schema omits `roles.registry`,
// so `.get` returns the documented fallback and no operator config trips schema
// validation. This is the DEFAULT — domain routing (builder-tag) overrides it,
// and an operator env pin overrides everything.

// Remediator worker-class selection (ARC-08): role-registry default with the
// domain able to override. Precedence, highest first:
//   1. operator env pin (`ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR` / role-config)
//   2. domain override — per-builder-tag cross-model routing
//   3. role-registry default (`roles.registry.remediator.workerClass`)
//   4. documented fallback `DEFAULT_REMEDIATION_WORKER_CLASS` (codex)
// A missing/unknown builderTag falls through to the registry default, matching
// the pre-ARC-08 degraded same-model-to-codex behavior (operator can pin).
function resolveRoleRegistryRemediator({ env = process.env, topPath, loaderImpl, domainId = 'code-pr' } = {}) {
  try {
    const cfg = loadRoleConfig({ env, topPath, loaderImpl, contextKey: 'roles.remediator' });
    const value = normalizeRemediationWorkerClass(
      cfg.get('roles.registry.remediator.workerClass', ''),
    );
    if (value) return value;
  } catch {
    // Registry key/schema not present yet (pre-ARC-12): fall through to the
    // documented default rather than failing the dispatch.
  }
  const domainValue = normalizeRemediationWorkerClass(
    resolveRemediatorWorkerClassFromDomain(loadDomainConfig(ROOT, domainId || 'code-pr')),
  );
  if (domainValue) return domainValue;
  return DEFAULT_REMEDIATION_WORKER_CLASS;
}

function pickRemediationWorkerClass(job, { env = process.env, topPath, loaderImpl } = {}) {
  const envOverride = defaultRemediatorWorkerClassFromEnv(env, { topPath, loaderImpl });
  if (envOverride) return normalizeRemediationWorkerClass(envOverride) || envOverride;
  const builderTag = String(job?.builderTag || '').trim().toLowerCase();
  if (builderTag && Object.prototype.hasOwnProperty.call(REMEDIATION_WORKER_BY_BUILDER_TAG, builderTag)) {
    return REMEDIATION_WORKER_BY_BUILDER_TAG[builderTag];
  }
  return resolveRoleRegistryRemediator({ env, topPath, loaderImpl, domainId: job?.domainId || 'code-pr' });
}

// Reconcile-time GitHub operations must not return unmapped worker
// identities such as clio-agent. A recorded spawned worker model is
// attribution ground truth; operator pins win unless a cap fallback replaced them.
function resolveReconcileWorkerClass(job, worker) {
  const envOverride = defaultRemediatorWorkerClassFromEnv(process.env);
  if (envOverride && !worker?.fallbackFrom) return envOverride;
  const recordedModel = normalizeRemediationWorkerClass(worker?.model);
  if (recordedModel) return recordedModel;
  return pickRemediationWorkerClass(job);
}

export { DEFAULT_REMEDIATION_WORKER_CLASS, defaultRemediatorWorkerClassFromEnv, resolveRoleRegistryRemediator, pickRemediationWorkerClass, resolveReconcileWorkerClass };
