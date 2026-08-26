// ASR-02 — the security-surface classifier.
//
// One question, answered from PR metadata alone: does this PR need a security
// review, and why? Three independent triggers, unioned:
//
//   1. bot-author      — a dependency/CI bot opened it.
//   2. sensitive-path  — it touches auth, secrets, sandbox profiles,
//                        entitlements, worker-class definitions, sudoers, or
//                        launchd plists. Author-independent.
//   3. manifest-change — it touches a dependency manifest or lockfile.
//                        Author-independent, and that is the whole point: the
//                        dependency arrives with the same privileges whether
//                        dependabot or a person introduced it (SPEC.md,
//                        "Manifest changes route on the file, not the author").
//
// Each trigger is reported as its own reason. ASR-05 specialises the review on
// them — a bot-author review reads a lockfile diff, a sensitive-path review
// reads an auth change — so `bot-author` and `manifest-change` must stay
// distinguishable and must never collapse into a boolean.
//
// THIS MODULE RETURNS TRIGGERS, NEVER VERDICTS. It decides what gets looked at,
// not what is wrong. There is no severity here and there must never be: severity
// is ASR-05's, and the blocking threshold is ASR-06's. A router that pre-judges
// is a router that suppresses.
//
// Purity is a hard constraint: no I/O, no network, no DB, no clock. Everything
// below is a table plus string matching, so the classifier can be called from a
// watcher tick, a test, or a dry-run CLI with identical results.

import { isUnroutableBotAuthor } from './bot-author.mjs';

export const SECURITY_TRIGGER = Object.freeze({
  BOT_AUTHOR: 'bot-author',
  SENSITIVE_PATH: 'sensitive-path',
  MANIFEST_CHANGE: 'manifest-change',
});

// ---------------------------------------------------------------------------
// Dependency manifests and lockfiles — SPEC.md "Manifests in scope".
// ---------------------------------------------------------------------------

// Matched on the BASENAME, case-insensitively, at any depth. Depth matters:
// a vendored `frontend/server/package.json` is as much a dependency edit as the
// root one. Case-insensitivity is deliberate slack — `Cargo.toml` and `Pipfile`
// are conventionally capitalised and a repo that lowercases them still ships the
// same dependencies.
const MANIFEST_BASENAMES = Object.freeze(new Map([
  ['package.json', 'npm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'npm'],
  ['pnpm-lock.yaml', 'npm'],

  ['pyproject.toml', 'python'],
  ['poetry.lock', 'python'],
  ['pipfile', 'python'],
  ['pipfile.lock', 'python'],
  ['setup.py', 'python'],
  ['setup.cfg', 'python'],

  ['go.mod', 'go'],
  ['go.sum', 'go'],

  ['cargo.toml', 'rust'],
  ['cargo.lock', 'rust'],

  // `compose.yml` is the Compose Spec's current name; SPEC.md's `dev/compose.yml`
  // is one instance of it, and pinning the directory would miss the same file
  // one level over.
  ['compose.yml', 'container'],
  ['compose.yaml', 'container'],

  ['.gitmodules', 'repo'],
]));

// Basename patterns, for the entries SPEC.md writes as globs.
const MANIFEST_BASENAME_PATTERNS = Object.freeze([
  // `requirements.txt`, `requirements-dev.txt`, `constraints.txt`, ...
  { pattern: /^(?:requirements|constraints)[^/]*\.txt$/, ecosystem: 'python' },
  // `Dockerfile`, `Dockerfile.prod`, ...
  { pattern: /^dockerfile[^/]*$/, ecosystem: 'container' },
  // `docker-compose.yml`, `docker-compose.override.yaml`, ...
  { pattern: /^docker-compose[^/]*\.ya?ml$/, ecosystem: 'container' },
]);

// Full-path patterns, for manifests defined by WHERE they are rather than what
// they are called.
const MANIFEST_PATH_PATTERNS = Object.freeze([
  // Third-party action pins are a live supply-chain vector (SPEC.md). GitHub
  // honours BOTH `.yml` and `.yaml` here, so matching only `.yml` — the
  // extension SPEC.md happens to write — would leave a real hole: a
  // `.github/workflows/deploy.yaml` pinning `some-org/action@main` would route
  // as an ordinary code change. Only the repo-root `.github/workflows/`
  // directory is live, so the prefix is anchored.
  { pattern: /^\.github\/workflows\/[^/]+\.ya?ml$/, ecosystem: 'ci' },
]);

// ---------------------------------------------------------------------------
// Security-sensitive paths.
// ---------------------------------------------------------------------------

// Path-segment TOKENS, not substrings. A path is split on every non-alphanumeric
// character and each resulting token is compared whole.
//
// Whole-token comparison is the load-bearing part, not a stylistic choice. A
// substring match on `auth` fires on `AUTHOR_TAGGING.md`, `pr-author.mjs`,
// `src/ama/rebase-authority.mjs`, and `src/ama/reviewer-authority.mjs` — four
// live paths in this repo, none of which has anything to do with authentication.
// A router whose sensitive-path trigger fires on the word "author" in a repo
// full of author-tagging and merge-authority code is a router operators learn to
// ignore.
const SENSITIVE_TOKENS = Object.freeze(new Map(Object.entries({
  auth: 'auth',
  authn: 'auth',
  authz: 'auth',
  oauth: 'auth',
  login: 'auth',
  signin: 'auth',
  // No `session`. In a web codebase it means an authentication session; in this
  // fleet it means an agent/reviewer session, and all six `session` paths in
  // this repo are session-ledger plumbing with no auth surface at all. Listing
  // it would buy six standing false positives and zero true ones. Revisit if
  // ASR ever routes a repo where sessions are credentials.
  permission: 'auth',
  permissions: 'auth',
  acl: 'auth',
  rbac: 'auth',
  iam: 'auth',

  secret: 'secrets',
  secrets: 'secrets',
  credential: 'secrets',
  credentials: 'secrets',
  keychain: 'secrets',
  keyring: 'secrets',
  vault: 'secrets',
  password: 'secrets',
  passwords: 'secrets',
  passwd: 'secrets',
  htpasswd: 'secrets',
  apikey: 'secrets',
  privatekey: 'secrets',
  key: 'secrets',
  keys: 'secrets',
  // `token` is knowingly over-inclusive HERE: this repo also uses "token" for
  // LLM accounting (`reviewer-token-pricing.mjs`), so it will route some files
  // that hold no credential. That direction is the cheap one. A missed
  // credential path is an unreviewed credential change; a surplus one is a fast
  // pass, and the matched token travels in the reason so ASR-05 can proportion
  // its effort instead of re-deriving why the file was routed.
  token: 'secrets',
  tokens: 'secrets',

  sandbox: 'sandbox-profile',
  entitlement: 'entitlements',
  entitlements: 'entitlements',
  sudoers: 'sudoers',
  launchd: 'launchd',
  launchagents: 'launchd',
  launchdaemons: 'launchd',
})));

// Extensions that are sensitive whatever the file is called.
const SENSITIVE_EXTENSIONS = Object.freeze(new Map(Object.entries({
  '.sb': 'sandbox-profile',
  '.entitlements': 'entitlements',
  '.plist': 'launchd',
  '.pem': 'secrets',
  '.key': 'secrets',
  '.p12': 'secrets',
  '.pfx': 'secrets',
  '.jks': 'secrets',
  '.keystore': 'secrets',
  '.asc': 'secrets',
  '.gpg': 'secrets',
})));

// Whole basenames that carry credentials without a sensitive token in them.
const SENSITIVE_BASENAMES = Object.freeze(new Map(Object.entries({
  '.npmrc': 'secrets',
  '.netrc': 'secrets',
  '.pypirc': 'secrets',
  '.envrc': 'secrets',
  id_rsa: 'secrets',
  id_dsa: 'secrets',
  id_ecdsa: 'secrets',
  id_ed25519: 'secrets',
  authorized_keys: 'auth',
  known_hosts: 'auth',
})));

// Directory segments that make everything beneath them sensitive.
const SENSITIVE_DIRECTORIES = Object.freeze(new Map(Object.entries({
  '.ssh': 'secrets',
  '.gnupg': 'secrets',
  'sudoers.d': 'sudoers',
})));

const SENSITIVE_PATH_PATTERNS = Object.freeze([
  // Worker-class definitions decide which agent runs with which privileges, so
  // an edit to one is a privilege change. Written as a pattern rather than a
  // token because the two words are adjacent across several spellings:
  // `worker-class`, `worker_classes`, `workerClass`.
  { pattern: /worker[-_]?class(?:es)?/i, category: 'worker-class' },
  // `.env`, `.env.local`, `.env.production`. Matched as a basename prefix rather
  // than an `env` token, which would sweep in every `env.mjs` and `test-env.mjs`.
  { pattern: /(?:^|\/)\.env(?:\.[^/]*)?$/, category: 'secrets' },
]);

// ---------------------------------------------------------------------------
// Normalisation.
// ---------------------------------------------------------------------------

/**
 * Reduce one changed-file entry to a comparable repo-relative path.
 *
 * Accepts a bare string, a REST file object (`{ filename }`), or a `gh pr view
 * --json files` object (`{ path }`) — the same tolerance
 * `additive-only-scope.mjs` already applies to changed-file lists, so callers do
 * not have to reshape whichever surface they read from.
 */
function normalizeChangedPath(entry) {
  const raw = typeof entry === 'string' ? entry : (entry?.filename || entry?.path || '');
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function basenameOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extensionOf(basename) {
  // `lastIndexOf` on a leading-dot basename (`.env`) must not report the whole
  // name as an extension, hence the `> 0`.
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot) : '';
}

function tokensOf(path) {
  return path.split(/[^a-z0-9]+/i).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Per-path classification.
// ---------------------------------------------------------------------------

/**
 * Which dependency ecosystem, if any, does this path's manifest belong to?
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {string|null}  Ecosystem key, or null when the path is not a manifest.
 */
export function manifestEcosystemForPath(entry) {
  const path = normalizeChangedPath(entry);
  if (!path) return null;
  const lowerPath = path.toLowerCase();

  for (const { pattern, ecosystem } of MANIFEST_PATH_PATTERNS) {
    if (pattern.test(lowerPath)) return ecosystem;
  }

  const basename = basenameOf(lowerPath);
  const exact = MANIFEST_BASENAMES.get(basename);
  if (exact) return exact;

  for (const { pattern, ecosystem } of MANIFEST_BASENAME_PATTERNS) {
    if (pattern.test(basename)) return ecosystem;
  }
  return null;
}

/**
 * Which security-sensitive categories, if any, does this path fall into?
 *
 * A path can be sensitive more than one way (`launchd/agy-auth.plist` is both
 * `launchd` and `auth`), and ASR-05 reviews a plist differently from an auth
 * module, so every matched category is reported rather than the first.
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {string[]}     Sorted unique categories; empty when not sensitive.
 */
export function sensitiveCategoriesForPath(entry) {
  const path = normalizeChangedPath(entry);
  if (!path) return [];
  const lowerPath = path.toLowerCase();
  const basename = basenameOf(lowerPath);
  const categories = new Set();

  const byBasename = SENSITIVE_BASENAMES.get(basename);
  if (byBasename) categories.add(byBasename);

  const byExtension = SENSITIVE_EXTENSIONS.get(extensionOf(basename));
  if (byExtension) categories.add(byExtension);

  for (const segment of lowerPath.split('/').slice(0, -1)) {
    const byDirectory = SENSITIVE_DIRECTORIES.get(segment);
    if (byDirectory) categories.add(byDirectory);
  }

  for (const token of tokensOf(lowerPath)) {
    const byToken = SENSITIVE_TOKENS.get(token);
    if (byToken) categories.add(byToken);
  }

  for (const { pattern, category } of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(lowerPath)) categories.add(category);
  }

  return [...categories].sort();
}

// ---------------------------------------------------------------------------
// The classifier.
// ---------------------------------------------------------------------------

function normalizeAuthorRef(author) {
  const raw = typeof author === 'string' ? author : (author?.login || '');
  return String(raw || '').trim();
}

function uniqueChangedPaths(changedFiles) {
  if (!Array.isArray(changedFiles)) return [];
  const seen = new Set();
  const paths = [];
  for (const entry of changedFiles) {
    const path = normalizeChangedPath(entry);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Does this PR need a security review, and why?
 *
 * @param {object} pr
 * @param {string|{login?: string}} [pr.author]  PR author login, in either
 *   GitHub rendering (`dependabot[bot]` or `app/dependabot`).
 * @param {Array<string|{path?: string, filename?: string}>} [pr.changedFiles]
 *   The PR's changed-file list.
 * @returns {{needsReview: boolean, reasons: Array<object>}}
 *   `reasons` is ordered bot-author, sensitive-path, manifest-change — stable,
 *   so a caller can diff two classifications without sorting.
 */
export function classifySecuritySurface({ author, changedFiles } = {}) {
  const reasons = [];

  const authorRef = normalizeAuthorRef(author);
  if (isUnroutableBotAuthor(authorRef)) {
    reasons.push({ trigger: SECURITY_TRIGGER.BOT_AUTHOR, author: authorRef });
  }

  const paths = uniqueChangedPaths(changedFiles);

  const sensitiveMatches = [];
  const manifestMatches = [];
  for (const path of paths) {
    const categories = sensitiveCategoriesForPath(path);
    if (categories.length > 0) sensitiveMatches.push({ path, categories });

    const ecosystem = manifestEcosystemForPath(path);
    if (ecosystem) manifestMatches.push({ path, ecosystem });
  }

  if (sensitiveMatches.length > 0) {
    const categories = new Set();
    for (const match of sensitiveMatches) {
      for (const category of match.categories) categories.add(category);
    }
    reasons.push({
      trigger: SECURITY_TRIGGER.SENSITIVE_PATH,
      categories: [...categories].sort(),
      matches: sensitiveMatches,
    });
  }

  if (manifestMatches.length > 0) {
    const ecosystems = new Set(manifestMatches.map((match) => match.ecosystem));
    reasons.push({
      trigger: SECURITY_TRIGGER.MANIFEST_CHANGE,
      ecosystems: [...ecosystems].sort(),
      matches: manifestMatches,
    });
  }

  return { needsReview: reasons.length > 0, reasons };
}
