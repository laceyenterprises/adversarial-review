// Per-role comms delivery identity (v2 app architecture §5, ARC-12).
//
// In v1, "which bot posts as which reviewer" was fused into the SUBJECT
// adapter's routing table (`adapters/subject/github-pr/routing.mjs`), where each
// cross-model route carried a `botTokenEnv`. The v2 architecture moves that bot
// identity into the COMMS adapter's delivery config, keyed by ROLE ID, so:
//
//   - the kernel and the role registry never see tokens (the registry declares
//     roles by worker class / persona only — no token, model id, or CLI path);
//   - delivery identity is resolved at post time from the verdict's
//     `reviewerRoleId`, not re-derived from a builder-class routing table.
//
// This module is the token-side home. It maps a role id → the bot identity that
// posts its comments: a GitHub bot-token ENV VAR NAME (never a token value) plus
// the bot login that name resolves to. The map is delivery config supplied to
// the comms adapter; this module validates it and resolves one entry.

import {
  COMMENT_BOT_LOGIN_BY_TOKEN_ENV,
  resolveCommentBotTokenEnv,
} from './pr-comments.mjs';
import { loadRoleRegistry } from '../../../role-registry.mjs';
import { loadRoleConfig } from '../../../role-config.mjs';

const DELIVERY_IDENTITY_KEY = 'roles.delivery_identity';

// Bot-login → token-env inverse of `COMMENT_BOT_LOGIN_BY_TOKEN_ENV`, so an
// identity entry may be declared by either side and normalize to both.
const TOKEN_ENV_BY_BOT_LOGIN = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMENT_BOT_LOGIN_BY_TOKEN_ENV).map(([tokenEnv, login]) => [login, tokenEnv]),
  ),
);

export class DeliveryIdentityError extends Error {
  constructor(message, { roleId = null } = {}) {
    super(message);
    this.name = 'DeliveryIdentityError';
    if (roleId) this.roleId = roleId;
  }
}

/**
 * Normalize one delivery-identity entry to `{ botTokenEnv, botLogin }`. An entry
 * may declare either side:
 *   - `{ botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' }` → login derived,
 *   - `{ botLogin: 'codex-reviewer-lacey' }` → token env derived,
 *   - `{ workerClass: 'codex' }` → token env + login derived (bridges the v1
 *     worker-class → token map during migration),
 *   - a bare string is treated as `botTokenEnv`.
 * `botLogin` may be null when a custom token env has no known login mapping;
 * `botTokenEnv` is always required (it is the credential selector).
 *
 * @param {string} roleId
 * @param {unknown} entry
 * @returns {{ roleId: string, botTokenEnv: string, botLogin: string | null }}
 */
export function normalizeDeliveryIdentityEntry(roleId, entry) {
  const raw = typeof entry === 'string' ? { botTokenEnv: entry } : (entry || {});
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DeliveryIdentityError(
      `delivery identity for role ${JSON.stringify(roleId)} must be an object or token-env string`,
      { roleId },
    );
  }

  let botTokenEnv = String(raw.botTokenEnv ?? '').trim();
  let botLogin = String(raw.botLogin ?? '').trim();
  const workerClass = String(raw.workerClass ?? '').trim();

  if (!botTokenEnv && workerClass) {
    botTokenEnv = resolveCommentBotTokenEnv(workerClass) || '';
  }
  if (!botTokenEnv && botLogin) {
    botTokenEnv = TOKEN_ENV_BY_BOT_LOGIN[botLogin] || '';
  }
  if (!botTokenEnv) {
    throw new DeliveryIdentityError(
      `delivery identity for role ${JSON.stringify(roleId)} resolves no botTokenEnv ` +
        `(declare botTokenEnv, botLogin, or workerClass)`,
      { roleId },
    );
  }
  if (!botLogin) {
    botLogin = COMMENT_BOT_LOGIN_BY_TOKEN_ENV[botTokenEnv] || '';
  }

  return { roleId, botTokenEnv, botLogin: botLogin || null };
}

/**
 * Resolve the bot identity a role posts under. Throws when the role has no
 * identity binding — a review must never fall back to an ambiguous or default
 * posting identity.
 *
 * @param {string} roleId
 * @param {{ [roleId: string]: unknown } | null | undefined} identityByRole
 * @returns {{ roleId: string, botTokenEnv: string, botLogin: string | null }}
 */
export function resolveDeliveryIdentity(roleId, identityByRole) {
  const id = String(roleId ?? '').trim();
  if (!id) {
    throw new DeliveryIdentityError('a role id is required to resolve delivery identity');
  }
  const map = identityByRole || {};
  if (!Object.prototype.hasOwnProperty.call(map, id)) {
    throw new DeliveryIdentityError(
      `no comms delivery identity configured for role ${JSON.stringify(id)}; ` +
        `known roles: [${Object.keys(map).sort().join(', ')}]`,
      { roleId: id },
    );
  }
  return normalizeDeliveryIdentityEntry(id, map[id]);
}

/**
 * Validate an entire delivery-identity map (every entry normalizes) and,
 * optionally, that every role id in `requireRoleIds` has an entry. Returns the
 * normalized map keyed by role id. Wire this beside the role-registry validator
 * so a registry role with no posting identity fails at load, not at first post.
 *
 * @param {{ [roleId: string]: unknown } | null | undefined} identityByRole
 * @param {{ requireRoleIds?: readonly string[] }} [options]
 * @returns {{ [roleId: string]: { roleId: string, botTokenEnv: string, botLogin: string | null } }}
 */
export function validateDeliveryIdentityMap(identityByRole, { requireRoleIds = [] } = {}) {
  const map = identityByRole || {};
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new DeliveryIdentityError('delivery identity map must be an object keyed by role id');
  }
  const normalized = {};
  for (const [roleId, entry] of Object.entries(map)) {
    normalized[roleId] = normalizeDeliveryIdentityEntry(roleId, entry);
  }
  for (const roleId of requireRoleIds) {
    const id = String(roleId ?? '').trim();
    if (id && !Object.prototype.hasOwnProperty.call(normalized, id)) {
      throw new DeliveryIdentityError(
        `role ${JSON.stringify(id)} has no comms delivery identity binding`,
        { roleId: id },
      );
    }
  }
  return normalized;
}

export const __testing = { TOKEN_ENV_BY_BOT_LOGIN };

/**
 * Boot-time validator for comms delivery identity (review #631). Loads the
 * role registry to get its role ids and the `roles.delivery_identity` config
 * map, then asserts (via `validateDeliveryIdentityMap`) that every registered
 * role has a well-formed posting identity binding — so a registry role with no
 * comms identity fails loud at startup, not after an expensive review runs and
 * the daemon crashes at the final comment-delivery step. No-op when the
 * registry is empty (production default). Lives here (comms layer) rather than
 * in role-registry.mjs so the low-level registry never imports the comms
 * adapter (which would create an import cycle).
 *
 * @param {object} [options] - forwarded to loadRoleRegistry/loadRoleConfig
 */
export function validateStartupDeliveryIdentity(options = {}) {
  const { env = process.env, topPath, modulePaths, loaderImpl } = options;
  const registry = loadRoleRegistry(options);
  const roleIds = Object.keys(registry?.roles ?? {});
  if (roleIds.length === 0) return; // nothing to bind
  const cfg = loadRoleConfig({ env, topPath, modulePaths, loaderImpl, contextKey: DELIVERY_IDENTITY_KEY });
  const identityByRole = cfg.get(DELIVERY_IDENTITY_KEY, {});
  validateDeliveryIdentityMap(identityByRole, { requireRoleIds: roleIds });
}
