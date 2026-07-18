// Role registry loader + validator (v2 app architecture §5, ARC-12).
//
// The `roles.registry` config subtree is a keyed map of role id → role
// definition. The config loader (`config-loader.mjs`) validates STRUCTURE only
// (known entry keys, string types). This module owns the SEMANTIC contract and
// fails loud at load:
//
//   - `promptSet` is a required non-empty string.
//   - exactly one of `workerClass` / `persona` is set.
//   - `taskKind` ∈ {review, remediation}; `completionShape` ∈
//     {decision-only, branch-push}.
//   - optional `priority` is a non-negative integer for reviewer fallback
//     precedence (lower first, equal/omitted keep registry order).
//   - a `workerClass` MUST be a member of the hq-published worker-class roster
//     (`hq-worker-classes.mjs`) — never a hardcoded list. An unknown class
//     fails at load (SPEC §6 "two registries drift" mitigation).
//
// The registry never carries tokens, model ids, or CLI paths: per-role GitHub
// bot identity is comms-adapter delivery config keyed by role id
// (`adapters/comms/github-pr-comments/delivery-identity.mjs`). The kernel's
// never-review-own-builder-class constraint (`kernel/role-routing.mjs`)
// consumes the validated registry this module returns.
//
// `roles.registry` defaults to `{}` (no roles), so the whole surface is inert
// until a domain opts in (ARC-13). An empty registry validates without ever
// touching the worker-class roster, so a checkout with no reachable roster
// still boots.

import { AgentOSConfigError } from './config-loader.mjs';
import { loadRoleConfig } from './role-config.mjs';
import { publishedWorkerClassSet } from './hq-worker-classes.mjs';

export const ROLE_TASK_KINDS = Object.freeze(['review', 'remediation']);
export const ROLE_COMPLETION_SHAPES = Object.freeze(['decision-only', 'branch-push']);

const REGISTRY_KEY = 'roles.registry';
const NEVER_REVIEW_OWN_BUILDER_CLASS_KEY = 'roles.routing.never-review-own-builder-class';

function str(value) {
  return String(value ?? '').trim();
}

function configError(key, message, extra = {}) {
  return new AgentOSConfigError(message, { key, ...extra });
}

/**
 * Validate and normalize a single role definition. `workerClassSet` is the
 * hq-published roster (a Set); it is consulted only when the role declares a
 * `workerClass`, so a persona-only registry validates without a roster.
 *
 * @param {string} roleId
 * @param {unknown} raw
 * @param {{ workerClassSet: Set<string> | null }} ctx
 * @returns {import('./kernel/contracts.js').RoleDefinition}
 */
export function validateRoleDefinition(roleId, raw, { workerClassSet = null } = {}) {
  const base = `${REGISTRY_KEY}.${roleId}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError(base, `${base}: role definition must be a mapping`);
  }

  const promptSet = str(raw.promptSet);
  if (!promptSet) {
    throw configError(`${base}.promptSet`, `${base}.promptSet is required (non-empty string)`);
  }

  const workerClass = str(raw.workerClass);
  const persona = str(raw.persona);
  if (workerClass && persona) {
    throw configError(
      base,
      `${base}: set exactly one of workerClass / persona, not both ` +
        `(workerClass=${JSON.stringify(workerClass)}, persona=${JSON.stringify(persona)})`,
    );
  }
  if (!workerClass && !persona) {
    throw configError(base, `${base}: a role must declare exactly one of workerClass / persona`);
  }

  const taskKind = str(raw.taskKind);
  if (!ROLE_TASK_KINDS.includes(taskKind)) {
    throw configError(
      `${base}.taskKind`,
      `${base}.taskKind must be one of: ${ROLE_TASK_KINDS.join(', ')}; got ${JSON.stringify(raw.taskKind ?? null)}`,
      { expected: ROLE_TASK_KINDS.join(', '), got: raw.taskKind ?? null, allowed: ROLE_TASK_KINDS },
    );
  }

  const completionShape = str(raw.completionShape);
  if (!ROLE_COMPLETION_SHAPES.includes(completionShape)) {
    throw configError(
      `${base}.completionShape`,
      `${base}.completionShape must be one of: ${ROLE_COMPLETION_SHAPES.join(', ')}; got ${JSON.stringify(raw.completionShape ?? null)}`,
      {
        expected: ROLE_COMPLETION_SHAPES.join(', '),
        got: raw.completionShape ?? null,
        allowed: ROLE_COMPLETION_SHAPES,
      },
    );
  }

  const hasPriority = raw.priority !== undefined && raw.priority !== null;
  const priority = raw.priority;
  if (hasPriority && (!Number.isInteger(priority) || priority < 0)) {
    throw configError(
      `${base}.priority`,
      `${base}.priority must be a non-negative integer; got ${JSON.stringify(raw.priority)}`,
      { expected: 'non-negative integer', got: raw.priority ?? null },
    );
  }

  if (workerClass) {
    // The roster is required precisely when a role names a worker class. A
    // null set means the caller could not resolve the hq-published roster;
    // rather than silently accept an unvalidated class (the "hardcoded list"
    // anti-pattern), fail loud.
    if (!workerClassSet) {
      throw configError(
        `${base}.workerClass`,
        `${base}.workerClass=${JSON.stringify(workerClass)} cannot be validated: ` +
          'the hq-published worker-class roster is unavailable',
      );
    }
    if (!workerClassSet.has(workerClass)) {
      const known = [...workerClassSet].sort();
      throw configError(
        `${base}.workerClass`,
        `${base}.workerClass=${JSON.stringify(workerClass)} is not in the hq-published ` +
          `worker-class roster: [${known.join(', ')}]`,
        { expected: `one of ${JSON.stringify(known)}`, got: workerClass, allowed: known },
      );
    }
  }

  return {
    id: roleId,
    promptSet,
    ...(workerClass ? { workerClass } : {}),
    ...(persona ? { persona } : {}),
    taskKind,
    completionShape,
    ...(hasPriority ? { priority } : {}),
  };
}

/**
 * Validate a raw `roles.registry` map + routing flag into a `RoleRegistry`.
 * The worker-class roster is resolved lazily — only when at least one role
 * declares a `workerClass` — via `resolveWorkerClassSet()`, so a persona-only
 * or empty registry never requires a reachable roster.
 *
 * @param {unknown} rawRegistry
 * @param {{
 *   neverReviewOwnBuilderClass?: boolean,
 *   workerClassSet?: Set<string> | null,
 *   resolveWorkerClassSet?: () => Set<string>,
 * }} [ctx]
 * @returns {import('./kernel/contracts.js').RoleRegistry}
 */
export function validateRoleRegistry(rawRegistry, {
  neverReviewOwnBuilderClass = true,
  workerClassSet = null,
  resolveWorkerClassSet = null,
} = {}) {
  const registry = rawRegistry ?? {};
  if (typeof registry !== 'object' || Array.isArray(registry)) {
    throw configError(REGISTRY_KEY, `${REGISTRY_KEY} must be a mapping of role id → role definition`);
  }

  const entries = Object.entries(registry);
  const needsRoster = entries.some(([, raw]) => str(raw?.workerClass) !== '');
  let roster = workerClassSet;
  if (needsRoster && !roster && typeof resolveWorkerClassSet === 'function') {
    roster = resolveWorkerClassSet();
  }

  const roles = {};
  for (const [roleId, raw] of entries) {
    if (!str(roleId)) {
      throw configError(REGISTRY_KEY, `${REGISTRY_KEY}: role id must be a non-empty string`);
    }
    roles[roleId] = validateRoleDefinition(roleId, raw, { workerClassSet: roster });
  }

  return {
    roles,
    routing: { neverReviewOwnBuilderClass: neverReviewOwnBuilderClass !== false },
  };
}

/**
 * Load and validate the role registry through the standard role-config cascade
 * (module → top → *.local → env). Returns a validated `RoleRegistry`.
 *
 * Tests inject `workerClasses` (an array/Set) to stay hermetic against the host
 * roster, or `loaderImpl` to stub config loading. Production leaves both unset:
 * config comes from the cascade and the roster from
 * `resolvePublishedWorkerClasses` (published registry + snapshot fallback).
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   topPath?: string,
 *   modulePaths?: string[],
 *   loaderImpl?: unknown,
 *   workerClasses?: readonly string[] | Set<string> | null,
 *   workerClassOptions?: object,
 * }} [options]
 * @returns {import('./kernel/contracts.js').RoleRegistry}
 */
export function loadRoleRegistry({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
  workerClasses = null,
  workerClassOptions = {},
} = {}) {
  const cfg = loadRoleConfig({ env, topPath, modulePaths, loaderImpl, contextKey: REGISTRY_KEY });
  const rawRegistry = cfg.get(REGISTRY_KEY, {});
  const neverReviewOwnBuilderClass = cfg.get(NEVER_REVIEW_OWN_BUILDER_CLASS_KEY, true) !== false;

  const injected = workerClasses
    ? (workerClasses instanceof Set ? workerClasses : new Set(workerClasses))
    : null;

  return validateRoleRegistry(rawRegistry, {
    neverReviewOwnBuilderClass,
    workerClassSet: injected,
    resolveWorkerClassSet: injected
      ? null
      : () => publishedWorkerClassSet({ env, ...workerClassOptions }),
  });
}

/**
 * Boot-time validator: throws with a `FATAL config:`-shaped `AgentOSConfigError`
 * when the role registry is malformed or references an unknown worker class.
 * Wire alongside `validateStartupRoleConfig` in daemon startup.
 *
 * @param {Parameters<typeof loadRoleRegistry>[0]} [options]
 */
export function validateStartupRoleRegistry(options = {}) {
  loadRoleRegistry(options);
}
