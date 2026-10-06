// UNTRUSTEDPR-01 — the one intake predicate that keeps the review watcher, the
// remediators and the hammer from ever acting on a PR from a fork or from an
// author the fleet does not trust. adversarial-review is a public repository,
// so anyone can open a PR against it; nothing downstream of PR discovery may
// spawn a worker, post a comment or touch a label for such a PR.
//
// A PR is trusted iff BOTH
//   (a) its head repository is the base repository (no forks), AND
//   (b) its author is trusted: authorAssociation OWNER / MEMBER / COLLABORATOR,
//       OR the author is one of the fleet's own identities.
//
// "The fleet's own identities" reuses existing registries rather than adding a
// config key: every `entitlements.<id>.gh_bot_login` (the worker / reviewer /
// merge-agent / hammer App logins), `roles.adversarial.operator_logins`, and
// the dependency bots `bot-author.mjs` already routes (dependabot, renovate,
// github-actions — repo-installed Apps whose PRs dependency-bot adjudication
// depends on).
//
// One live fallback: GitHub reports the operator's own PRs as CONTRIBUTOR when
// org membership is private, so an author that fails both checks above is
// trusted if the repository grants them write access
// (`GET /repos/{repo}/collaborators/{login}/permission` is admin/maintain/write).
// That is the literal meaning of COLLABORATOR. A lookup error is "unknown",
// which is untrusted — the PR is re-evaluated on the next discovery tick.
//
// Untrusted PRs are skipped silently: one audit line, no page, no comment, no
// label. The same actor check gates who may drive work through a label.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isUnroutableBotAuthor } from './bot-author.mjs';
import { loadRoleConfig } from './role-config.mjs';

const execFileAsync = promisify(execFile);

export const TRUSTED_AUTHOR_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const DEFAULT_PERMISSION_TTL_MS = 10 * 60 * 1000;
// Process-wide: the watcher builds a fresh subject adapter per repo per poll.
const sharedPermissionCache = new Map();

/**
 * Canonical lower-case login. GitHub renders one App account three ways:
 * REST `name[bot]`, `gh` CLI `app/name`, GraphQL Bot `name` (typename `Bot`).
 * `[bot]` is synthesised ONLY for the latter two — GitHub logins cannot contain
 * brackets, so no human account can forge an App identity this way.
 */
export function normalizeActorLogin(login, { typename = null } = {}) {
  const raw = String(login || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('app/')) return `${raw.slice('app/'.length)}[bot]`;
  if (typename === 'Bot' && !raw.endsWith('[bot]')) return `${raw}[bot]`;
  return raw;
}

/**
 * Pull the trust evidence out of any PR shape this repo reads: REST `pulls`
 * (`head.repo`, `author_association`, `user`), `gh pr list --json`
 * (`isCrossRepository`, `author`) or GraphQL (`authorAssociation`).
 * `sameRepo` is null when the payload carries no head-repository evidence.
 */
export function prTrustEvidence(repoPath, pr) {
  const baseRepo = String(pr?.base?.repo?.full_name || repoPath || '').trim().toLowerCase();
  let sameRepo = null;
  if (pr?.head && Object.hasOwn(pr.head, 'repo')) {
    // A null head.repo is a deleted fork: not provably the base repository.
    const headRepo = String(pr.head.repo?.full_name || '').trim().toLowerCase();
    sameRepo = Boolean(headRepo) && headRepo === baseRepo;
  } else if (typeof pr?.isCrossRepository === 'boolean') {
    sameRepo = !pr.isCrossRepository;
  }
  const author = pr?.user || pr?.author || null;
  const association = String(pr?.author_association || pr?.authorAssociation || '').trim().toUpperCase();
  return {
    repo: repoPath,
    prNumber: Number(pr?.number),
    headSha: String(pr?.head?.sha || pr?.headRefOid || '') || null,
    sameRepo,
    authorLogin: normalizeActorLogin(author?.login, { typename: author?.__typename || author?.type }),
    authorAssociation: association || null,
  };
}

/** Is this actor trusted to drive fleet work? Pure. */
export function isTrustedActor(login, {
  association = null,
  allowlist = new Set(),
  permission = null,
} = {}) {
  const actor = normalizeActorLogin(login);
  if (!actor || actor === 'unknown') return { trusted: false, reason: 'actor-unknown' };
  if (TRUSTED_AUTHOR_ASSOCIATIONS.includes(String(association || '').toUpperCase())) {
    return { trusted: true, reason: 'author-association' };
  }
  if (allowlist.has(actor) || isUnroutableBotAuthor(actor)) {
    return { trusted: true, reason: 'allowlisted-identity' };
  }
  if (WRITE_PERMISSIONS.has(String(permission || '').toLowerCase())) {
    return { trusted: true, reason: 'write-permission' };
  }
  return { trusted: false, reason: 'author-not-trusted' };
}

/** THE intake predicate. Pure; `authorPermission` is the optional live fallback. */
export function isTrustedPr(evidence, { allowlist = new Set(), authorPermission = null } = {}) {
  if (evidence?.sameRepo !== true) {
    return { trusted: false, reason: evidence?.sameRepo === false ? 'fork-pr' : 'head-repo-unknown' };
  }
  return isTrustedActor(evidence.authorLogin, {
    association: evidence.authorAssociation,
    allowlist,
    permission: authorPermission,
  });
}

/**
 * May this PR comment's text reach an agent prompt? Only when its author is
 * associated with the repository or is one of the fleet's own identities —
 * anyone can comment on a public PR.
 */
export function isTrustedCommentAuthor(comment, { allowlist = new Set() } = {}) {
  const author = comment?.author;
  const login = typeof author === 'string' ? author : author?.login;
  return isTrustedActor(normalizeActorLogin(login, { typename: comment?.authorType || author?.__typename }), {
    association: comment?.authorAssociation || comment?.author_association,
    allowlist,
  }).trusted;
}

/** Union of the fleet's configured identities. Never throws. */
export function resolveTrustedIdentityAllowlist({
  env = process.env,
  loadRoleConfigImpl = loadRoleConfig,
  log = console,
} = {}) {
  const logins = new Set();
  try {
    const cfg = loadRoleConfigImpl({ env, contextKey: 'entitlements.*.gh_bot_login' });
    const entitlements = cfg.get('entitlements', {}) || {};
    for (const entry of Object.values(entitlements)) {
      for (const login of String(entry?.gh_bot_login || '').split(',')) {
        const normalized = normalizeActorLogin(login);
        if (normalized) logins.add(normalized);
      }
    }
    const operators = cfg.get('roles.adversarial.operator_logins', []);
    for (const login of Array.isArray(operators) ? operators : []) {
      const normalized = normalizeActorLogin(login);
      if (normalized) logins.add(normalized);
    }
  } catch (err) {
    log.warn?.(`[untrusted-pr-gate] identity registry unreadable; allowlist is empty: ${err?.message || err}`);
  }
  return logins;
}

function isNotFound(err) {
  return err?.status === 404 || /\bHTTP 404\b|\b404\b.*Not Found/i.test(`${err?.stderr || ''} ${err?.message || ''}`);
}

/**
 * Cached `(repo, login) -> permission` lookup. A 404 is a definitive "none"
 * and is cached; any other error returns null (unknown) and is NOT cached.
 */
export function createRepoPermissionResolver({
  execFileImpl = execFileAsync,
  fetchPermissionImpl = null,
  ttlMs = DEFAULT_PERMISSION_TTL_MS,
  nowMs = () => Date.now(),
  cache = sharedPermissionCache,
} = {}) {
  const fetchPermission = fetchPermissionImpl || (async (repo, login) => {
    const { stdout } = await execFileImpl('gh', [
      'api',
      `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      '--jq',
      '.permission',
    ], { maxBuffer: 1024 * 1024 });
    return String(stdout || '').trim();
  });
  return async function resolvePermission(repo, login) {
    const actor = normalizeActorLogin(login);
    // App accounts are never repository collaborators; the allowlist decides.
    if (!repo || !actor || actor.endsWith('[bot]')) return null;
    const key = `${String(repo).toLowerCase()}\u0000${actor}`;
    const cached = cache.get(key);
    if (cached && nowMs() - cached.at < ttlMs) return cached.permission;
    let permission;
    try {
      permission = String((await fetchPermission(repo, actor)) || 'none').trim().toLowerCase();
    } catch (err) {
      if (!isNotFound(err)) return null;
      permission = 'none';
    }
    cache.set(key, { permission, at: nowMs() });
    return permission;
  };
}

const auditedSkips = new Set();

/** One audit line per (subject, head, reason) per process. */
export function auditUntrustedSkip({ repo, prNumber, headSha = null, actor = null, reason, surface }, { log = console } = {}) {
  const key = `${surface}|${repo}#${prNumber}@${headSha || '-'}|${actor || '-'}|${reason}`;
  if (auditedSkips.has(key)) return;
  if (auditedSkips.size > 5000) auditedSkips.clear();
  auditedSkips.add(key);
  log.log?.(
    `[untrusted-pr-gate] skip surface=${surface} pr=${repo}#${prNumber} head=${headSha || '-'} `
    + `actor=${actor || '-'} reason=${reason}`
  );
}

/**
 * The gate as callers use it: lazily-resolved allowlist + cached permission
 * fallback. `evaluatePr` / `evaluateActor` only hit the network for an author
 * that is neither associated nor allowlisted.
 */
export function createPrTrustGate({
  env = process.env,
  allowlist = null,
  resolvePermission = null,
  execFileImpl = execFileAsync,
  log = console,
} = {}) {
  let resolvedAllowlist = allowlist;
  const getAllowlist = () => {
    if (!resolvedAllowlist) resolvedAllowlist = resolveTrustedIdentityAllowlist({ env, log });
    return resolvedAllowlist;
  };
  const permissionOf = resolvePermission || createRepoPermissionResolver({ execFileImpl });

  async function evaluateActor(repo, login, { association = null } = {}) {
    const verdict = isTrustedActor(login, { association, allowlist: getAllowlist() });
    if (verdict.trusted || verdict.reason !== 'author-not-trusted') return verdict;
    return isTrustedActor(login, { association, allowlist: getAllowlist(), permission: await permissionOf(repo, login) });
  }

  async function evaluatePr(repoPath, pr) {
    const evidence = prTrustEvidence(repoPath, pr);
    if (evidence.sameRepo !== true) return { ...isTrustedPr(evidence), evidence };
    return { ...(await evaluateActor(repoPath, evidence.authorLogin, { association: evidence.authorAssociation })), evidence };
  }

  return { evaluatePr, evaluateActor };
}
