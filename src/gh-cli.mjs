import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_LOOKUP_TIMEOUT_MS = 30_000;
const GH_LOOKUP_MAX_BUFFER = 25 * 1024 * 1024;
const DEFAULT_PATH_FALLBACK = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

function buildAllowlistedGhEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
  const allowlisted = {
    PATH: env.PATH ?? DEFAULT_PATH_FALLBACK,
    HOME: env.HOME ?? '',
  };
  for (const key of [
    'USER',
    'LOGNAME',
    'TMPDIR',
    'GH_CONFIG_DIR',
    'GH_HOST',
    'GITHUB_HOST',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE_BUNDLE',
  ]) {
    if (env[key] !== undefined) allowlisted[key] = env[key];
  }
  if (token) allowlisted.GH_TOKEN = token;
  return allowlisted;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isTransientGhError(err) {
  if (!err) return false;
  if (err.killed === true && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL')) return true;
  const code = String(err.code || '');
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') return true;
  const stderr = String(err.stderr || err.message || '');
  if (/timeout/i.test(stderr)) return true;
  if (/TLS handshake/i.test(stderr)) return true;
  if (/HTTP\s+5\d\d/i.test(stderr)) return true;
  if (/HTTP\s+429/i.test(stderr)) return true;
  if (/rate limit|secondary rate limit|too many requests|resource unavailable/i.test(stderr)) return true;
  return false;
}

// ── GitHub auth outage: re-mint once, then stop calling it a reviewer failure ──
//
// RTOK-01 / SEV0 2026-09-06+2026-09-07. The watcher's GitHub credential is a
// broker-minted GitHub App INSTALLATION token, which GitHub expires after one
// hour. The wall-clock refresh timer (#956) keeps it fresh in the common case,
// but it cannot help a call that is already in flight when the token flips, and
// it does nothing at all if the broker was briefly unreachable at the moment the
// timer fired. The observed end state was a 9h21m-old watcher holding a 383-char
// `ghs_` token that returned 401 for every `gh` call it made.
//
// Two distinct defects are fixed here, and they are independent:
//
//   1. NO RE-MINT ON 401. `isTransientGhError` deliberately does not match 401
//      (a bad credential is not a network blip), so the very first 401 threw
//      straight out of this helper. Nothing anywhere re-minted the token in
//      response to the credential actually being rejected -- the only recovery
//      was a watcher restart, which is why the pipeline reliably worked for
//      exactly one hour after every bounce. We now force a re-mint and retry
//      ONCE, which makes the fault self-healing regardless of tick duration.
//
//   2. NO AUTH CLASS. A 401 that survives the re-mint is a fleet-wide auth
//      outage: every PR the watcher touches will fail identically, for a reason
//      that has nothing to do with the PR or its reviewer. Thrown as a bare
//      exec error it was indistinguishable from a flaky review, so it was
//      charged to the PR's reviewer attempt budget
//      ("Reviewer unknown-class failure on #NNNN; counting against attempt
//      budget (3/4)") and permanently burned the retries of every PR it touched
//      -- PRs #6366-#6370 were stranded with zero reviews this way. We tag it
//      with a dedicated failure class so the settle path can hold the PR
//      without charging it.
//
// The re-mint is deliberately capped at exactly one attempt per call. A broker
// that is handing out dead tokens must not turn every `gh` invocation into an
// unbounded mint loop against the broker.
const GH_AUTH_OUTAGE_FAILURE_CLASS = 'github-auth-outage';

class GithubAuthOutageError extends Error {
  constructor(message, { cause = null, remintAttempted = false, remintDetail = null } = {}) {
    super(message);
    this.name = 'GithubAuthOutageError';
    // Consumed by reviewer-spawn-settle's outage classifier; see
    // classifyOutageText. `authOutage` is the stable predicate for callers that
    // would rather not string-match a class name.
    this.failureClass = GH_AUTH_OUTAGE_FAILURE_CLASS;
    this.authOutage = true;
    this.remintAttempted = remintAttempted;
    this.remintDetail = remintDetail;
    this.cause = cause;
    // Preserve the underlying gh output so downstream log/classification paths
    // still see the original `Bad credentials` text rather than only our wrapper.
    if (cause) {
      this.stderr = cause.stderr;
      this.stdout = cause.stdout;
      this.code = cause.code;
    }
  }
}

function ghErrorDetail(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .join('\n');
}

// A rejected GitHub credential, in every shape `gh` and the REST/GraphQL APIs
// render it. Kept deliberately narrow: 403 is NOT included, because a 403 is
// usually a permissions/rate-limit signal on a VALID token and re-minting would
// not change it.
function isGhAuthFailure(err) {
  if (!err) return false;
  const detail = ghErrorDetail(err).toLowerCase();
  if (!detail) return false;
  return /\bbad credentials\b/.test(detail)
    || /\bhttp\s*401\b/.test(detail)
    || /\b401\b[^\n]*\bunauthorized\b/.test(detail)
    || /\bunauthorized\b[^\n]*\b401\b/.test(detail)
    || /\brequires authentication\b/.test(detail)
    || /\bauthentication (?:failed|required)\b/.test(detail)
    || /\btoken (?:has )?expired\b/.test(detail);
}

// Force a fresh installation token into env. Returns whether a NEW credential
// actually landed -- retrying with the same rejected token is pointless, so a
// broker that is disabled or down short-circuits straight to the outage error.
async function defaultRefreshGhAuth({ env, log }) {
  const { refreshWatcherGithubToken } = await import('./reviewer-broker-refresh.mjs');
  return refreshWatcherGithubToken({ env, log, force: true });
}

async function remintGhAuth({ refreshGhAuthImpl, env, log }) {
  let summary = null;
  try {
    summary = await refreshGhAuthImpl({ env, log, force: true });
  } catch (err) {
    return { reminted: false, detail: `re-mint threw: ${err?.message || err}` };
  }
  if (summary?.refreshed === true) {
    return { reminted: true, detail: `role=${summary.role ?? 'unknown'}` };
  }
  if (summary?.skipped) {
    // Broker mode is off, so GITHUB_TOKEN is a static PAT there is no way to
    // re-mint. Still an auth outage -- just one only an operator can clear.
    return { reminted: false, detail: `re-mint unavailable: ${summary.skipped}` };
  }
  return { reminted: false, detail: `re-mint failed: ${summary?.failed || 'unknown'}` };
}

function asGithubAuthOutageError(err, args, { remintAttempted, remintDetail }) {
  const subcommand = Array.isArray(args) ? args.slice(0, 2).join(' ') : String(args ?? '');
  const suffix = remintAttempted
    ? 'after a forced token re-mint'
    : `without a usable re-mint (${remintDetail})`;
  return new GithubAuthOutageError(
    `[${GH_AUTH_OUTAGE_FAILURE_CLASS}] gh ${subcommand} was rejected by GitHub authentication ${suffix}: ${ghErrorDetail(err).trim()}`,
    { cause: err, remintAttempted, remintDetail }
  );
}

async function execGhWithRetry({
  execFileImpl = execFileAsync,
  args,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
  retries = 2,
  backoffMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  refreshGhAuthImpl = defaultRefreshGhAuth,
  log = console,
} = {}) {
  let attempt = 0;
  let lastErr = null;
  // Exactly one forced re-mint per call, no matter how many transient retries
  // the loop also burns.
  let authRemintAttempted = false;
  while (attempt <= retries) {
    try {
      return await execFileImpl(
        'gh',
        args,
        {
          env: buildAllowlistedGhEnv(env),
          maxBuffer: GH_LOOKUP_MAX_BUFFER,
          timeout: timeoutMs,
          killSignal: 'SIGTERM',
        }
      );
    } catch (err) {
      lastErr = err;
      if (isGhAuthFailure(err)) {
        if (authRemintAttempted) {
          // Re-minted once and GitHub still says no. This is an auth outage,
          // not this PR's reviewer misbehaving.
          throw asGithubAuthOutageError(err, args, {
            remintAttempted: true,
            remintDetail: null,
          });
        }
        authRemintAttempted = true;
        const remint = await remintGhAuth({ refreshGhAuthImpl, env, log });
        if (!remint.reminted) {
          throw asGithubAuthOutageError(err, args, {
            remintAttempted: false,
            remintDetail: remint.detail,
          });
        }
        log?.warn?.(
          `[gh-cli] gh ${Array.isArray(args) ? args.slice(0, 2).join(' ') : ''} hit GitHub 401; `
          + `re-minted the installation token (${remint.detail}) and retrying once`
        );
        // Retry immediately on the fresh credential. Deliberately does NOT
        // consume `attempt`: the transient budget exists for network flakiness
        // and an expired token has not used any of it.
        continue;
      }
      if (!isTransientGhError(err) || attempt === retries) throw err;
      await sleep(backoffMs * (2 ** attempt));
      attempt += 1;
    }
  }
  throw lastErr;
}

export {
  GH_AUTH_OUTAGE_FAILURE_CLASS,
  GH_LOOKUP_MAX_BUFFER,
  GH_LOOKUP_TIMEOUT_MS,
  GithubAuthOutageError,
  buildAllowlistedGhEnv,
  execGhWithRetry,
  isGhAuthFailure,
  isTransientGhError,
  parseDate,
  parseJsonLines,
};
