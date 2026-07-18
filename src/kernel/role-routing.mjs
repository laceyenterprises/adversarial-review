// Pure kernel logic for the role-registry routing constraint (v2 app
// architecture §5, ARC-12). The v1 rule "the reviewer must differ from the
// builder class" survives here as `never-review-own-builder-class`, evaluated
// against `SubjectState.builderClass` and a role's declared worker class.
//
// This module is runtime-free, side-effect-free, and token-free: it takes the
// already-loaded, already-validated `RoleRegistry` (see `../role-registry.mjs`)
// plus a subject's builder class and answers "may this role review this
// subject?". It imports nothing from the routing/adapter layers so the family
// knowledge that clio-agent PRs are written by codex stays injectable rather
// than hardcoded in the kernel — the caller passes a `builderClassFamily`
// resolver when it wants the richer family equivalence; the default only folds
// the one legacy `claude`/`claude-code` alias so a `claude-code` worker never
// reviews a `claude`-tagged PR (and vice-versa).
//
// Contract shapes (`RoleRegistry`, `RoleDefinition`, `RoleTaskKind`) live in
// `./contracts.d.ts`.

/**
 * @typedef {import('./contracts.js').RoleRegistry} RoleRegistry
 * @typedef {import('./contracts.js').RoleDefinition} RoleDefinition
 * @typedef {import('./contracts.js').RoleTaskKind} RoleTaskKind
 * @typedef {import('./contracts.js').SubjectState} SubjectState
 */

// The only alias the kernel folds by default: the OS worker class is
// `claude-code`, but PR builder tags and the legacy reviewer enum both used the
// bare `claude`. Everything else compares by its literal token so the kernel
// stays free of the routing layer's richer family table (clio-agent → codex,
// etc.), which the caller injects via `builderClassFamily` when needed.
const DEFAULT_FAMILY_ALIASES = Object.freeze({
  claude: 'claude-code',
});
const DEFAULT_REVIEW_ROLE_PRIORITY = 100;

/**
 * Normalize a builder-class / worker-class token to a comparison family. Lower-
 * cases, trims, and folds the default `claude` → `claude-code` alias. Returns
 * `null` for an empty/blank token so an unknown builder class never
 * accidentally equals another blank one.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function defaultBuilderClassFamily(value) {
  const token = String(value ?? '').trim().toLowerCase();
  if (token === '') return null;
  return DEFAULT_FAMILY_ALIASES[token] ?? token;
}

function resolveFamily(resolver, value) {
  const familyOf = typeof resolver === 'function' ? resolver : defaultBuilderClassFamily;
  const family = familyOf(value);
  const normalized = family == null ? '' : String(family).trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

function reviewerRolePriority(role) {
  const priority = role?.priority;
  return Number.isInteger(priority) ? priority : DEFAULT_REVIEW_ROLE_PRIORITY;
}

/**
 * The class token a role "is" for the never-review-own-builder-class check: its
 * declared `workerClass`. Persona-backed roles carry no worker class and are
 * never excluded by builder-class identity (a foundry persona is not a fleet
 * worker class); the constraint simply does not apply to them.
 *
 * @param {RoleDefinition | null | undefined} role
 * @returns {string | null}
 */
export function roleReviewerClass(role) {
  const workerClass = String(role?.workerClass ?? '').trim();
  return workerClass === '' ? null : workerClass;
}

/**
 * Decide whether `role` may review a subject built by `subjectBuilderClass`.
 * Returns a structured decision (not a bare boolean) so callers can log WHY a
 * seat was excluded.
 *
 * The constraint refuses only when `neverReviewOwnBuilderClass` is on AND the
 * role's worker-class family equals the subject's builder-class family. A role
 * with no worker class (persona-backed), a subject with no builder class, or a
 * disabled constraint all resolve to `allowed: true` — the kernel never blocks
 * on data it does not have.
 *
 * @param {{
 *   role: RoleDefinition,
 *   subjectBuilderClass: string | null | undefined,
 *   neverReviewOwnBuilderClass?: boolean,
 *   builderClassFamily?: (value: unknown) => string | null,
 * }} params
 * @returns {{ allowed: boolean, reason: string,
 *   roleFamily: string | null, subjectFamily: string | null }}
 */
export function roleMayReviewSubject({
  role,
  subjectBuilderClass,
  neverReviewOwnBuilderClass = true,
  builderClassFamily,
} = {}) {
  const roleFamily = resolveFamily(builderClassFamily, roleReviewerClass(role));
  const subjectFamily = resolveFamily(builderClassFamily, subjectBuilderClass);
  const base = { roleFamily, subjectFamily };

  if (!neverReviewOwnBuilderClass) {
    return { allowed: true, reason: 'constraint-disabled', ...base };
  }
  if (roleFamily === null) {
    // Persona-backed (or worker-class-less) role: the builder-class identity
    // constraint does not apply.
    return { allowed: true, reason: 'role-has-no-worker-class', ...base };
  }
  if (subjectFamily === null) {
    return { allowed: true, reason: 'subject-has-no-builder-class', ...base };
  }
  if (roleFamily === subjectFamily) {
    return { allowed: false, reason: 'own-builder-class', ...base };
  }
  return { allowed: true, reason: 'cross-class', ...base };
}

/**
 * The registry roles that may review the given subject, in explicit priority
 * order. Lower numeric `role.priority` values run first; omitted priorities
 * default to 100; ties preserve registry order. Filters to `taskKind: 'review'`
 * roles first, then applies {@link roleMayReviewSubject}. `subjectBuilderClass`
 * is read from the passed subject (either a raw builder-class string or a
 * `SubjectState`).
 *
 * @param {{
 *   registry: RoleRegistry,
 *   subject: SubjectState | { builderClass?: string | null } | string | null,
 *   builderClassFamily?: (value: unknown) => string | null,
 * }} params
 * @returns {{ roleId: string, role: RoleDefinition,
 *   decision: ReturnType<typeof roleMayReviewSubject> }[]}
 */
export function selectEligibleReviewerRoles({ registry, subject, builderClassFamily } = {}) {
  const roles = registry?.roles;
  if (!roles || typeof roles !== 'object') return [];
  const neverReviewOwnBuilderClass = registry?.routing?.neverReviewOwnBuilderClass !== false;
  const subjectBuilderClass = typeof subject === 'string'
    ? subject
    : (subject?.builderClass ?? null);

  const eligible = [];
  let registryIndex = 0;
  for (const [roleId, role] of Object.entries(roles)) {
    const currentIndex = registryIndex;
    registryIndex += 1;
    if (role?.taskKind !== 'review') continue;
    const decision = roleMayReviewSubject({
      role,
      subjectBuilderClass,
      neverReviewOwnBuilderClass,
      builderClassFamily,
    });
    if (decision.allowed) {
      eligible.push({ roleId, role, decision, registryIndex: currentIndex });
    }
  }
  eligible.sort((a, b) => {
    const aPriority = reviewerRolePriority(a.role);
    const bPriority = reviewerRolePriority(b.role);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.registryIndex - b.registryIndex;
  });
  return eligible.map((entry) => ({
    roleId: entry.roleId,
    role: entry.role,
    decision: entry.decision,
  }));
}
