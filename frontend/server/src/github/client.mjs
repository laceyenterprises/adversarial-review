/**
 * The read-only GitHub client (ARF-02).
 *
 * Supplies exactly the fields `reviews.db` does not carry — PR title, author /
 * builder, labels, required-check rollup, mergeable state, review bodies — and
 * nothing else. SPEC §9 puts this surface's write target at "own store cache";
 * it never writes to GitHub, so:
 *
 *   - `#get` is the only request method in the module and hardcodes `GET`. There
 *     is no `post`/`patch`/`put`/`delete` to call by accident, and no code path
 *     that takes a method as a parameter. ARF arms, installs, and *reads*; merge
 *     execution stays pipeline-owned (SPEC §5).
 *   - The token is read through `token.mjs` on every request — never memoized,
 *     never accepted as a constructor argument, never a literal.
 *
 * Only `node:` builtins and the global `fetch` are used, so ARF keeps its
 * zero-dependency boundary. `fetchImpl` is injectable purely so tests can count
 * requests and assert the cache actually avoids them.
 */

import { summarizeChecks, normalizeCheckRun, normalizeCommitStatus } from './checks.mjs';
import {
  ArfGithubAuthError,
  ArfGithubError,
  ArfGithubNotFoundError,
  ArfGithubRateLimitError,
} from './errors.mjs';
import { readGithubToken, tokenSource } from './token.mjs';
import { versionInfo } from '../version.mjs';

/**
 * `owner/name`. Validated rather than trusted because it is interpolated into
 * the request path: an unvalidated `../../` would walk ARF's read off the repo
 * it was asked about and onto some other API resource entirely.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The agent-os PR-title convention: `[claude-code] (feat) ARF-01: …`.
 *
 * The bracketed prefix is the **worker class that built the PR**, which is what
 * Screen A's `builder` column shows (SPEC §1 mockup: `claude-code`, `codex`).
 * The GitHub author login is a bot identity (`agent-os-…[bot]`) and is a
 * strictly worse answer to "who built this" — every agent PR would read as the
 * same bot.
 */
const BUILDER_TITLE_PREFIX = /^\s*\[([A-Za-z0-9][A-Za-z0-9._-]*)\]/;

/**
 * The body messages GitHub uses for a *secondary* rate limit.
 *
 * Secondary limits are the burst/concurrency governor, not the hourly budget, and
 * they answer `403` while leaving `x-ratelimit-remaining` well above zero — so the
 * response is byte-for-byte shaped like "your token lacks access". Classifying one
 * as an auth error is fail-loud, and fail-loud on a throttle takes the dashboard
 * down (503) instead of serving the stale rows it already has. The batch path
 * makes this reachable by design: `maxConcurrentRefreshes` sends concurrent reads,
 * which is exactly what trips a secondary limit.
 */
const SECONDARY_RATE_LIMIT_MESSAGE = /secondary rate limit|abuse detection|rate limit/i;

/**
 * `Link: <url>; rel="next", <url>; rel="last"` → the `next` URL, or null.
 *
 * Exported for the pagination test: "we follow the next link" is only an
 * assertion if the parse is separately checkable against real GitHub headers.
 */
export function parseNextLink(header) {
  const value = String(header ?? '');
  if (!value) return null;
  const entry = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^",;\s]+)"?/g;
  let match = entry.exec(value);
  while (match) {
    if (match[2].toLowerCase() === 'next') return match[1].trim();
    match = entry.exec(value);
  }
  return null;
}

export function assertRepo(repo) {
  const value = String(repo ?? '').trim();
  if (!REPO_PATTERN.test(value)) {
    throw new ArfGithubError(
      `repo must be "owner/name", got ${JSON.stringify(repo)}`,
      { code: 'bad_request', status: 400 },
    );
  }
  return value;
}

export function assertPrNumber(prNumber) {
  const value = Number(prNumber);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArfGithubError(
      `pr must be a positive integer, got ${JSON.stringify(prNumber)}`,
      { code: 'bad_request', status: 400 },
    );
  }
  return value;
}

/**
 * The builder for a PR, plus where that answer came from.
 *
 * `builderSource` travels with it so the dashboard is never guessing on the
 * user's behalf: `title-prefix` is the worker class the PR announced, `author`
 * is a fallback to the GitHub login for a human or unconventional PR.
 */
export function deriveBuilder(title, authorLogin) {
  const match = BUILDER_TITLE_PREFIX.exec(String(title ?? ''));
  if (match) return { builder: match[1].toLowerCase(), builderSource: 'title-prefix' };
  const login = String(authorLogin ?? '').trim();
  if (login) return { builder: login, builderSource: 'author' };
  return { builder: null, builderSource: null };
}

function text(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

export class GithubReadClient {
  /**
   * @param {object} options
   * @param {object} options.config resolved ARF config
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {() => number} [options.now]
   */
  constructor({ config, env = process.env, fetchImpl, now = () => Date.now() } = {}) {
    this.config = config;
    this.github = config.github;
    this.env = env;
    this.now = now;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new ArfGithubError(
        `ARF needs a global fetch (Node >= 18). Running Node ${process.version}.`,
        { code: 'github_unconfigured' },
      );
    }
    this.userAgent = `arf/${versionInfo().version}`;
    /** Last-seen rate-limit headers, for `/github/status`. */
    this.rateLimit = { limit: null, remaining: null, resetAt: null };
    /** Requests actually sent. The number the cache tests assert against. */
    this.requestCount = 0;
  }

  /** The token source (name/path only — never the value). */
  describeTokenSource() {
    return tokenSource(this.config);
  }

  /**
   * The only request primitive in this client. Always `GET`.
   *
   * Returns `{body, res}` rather than just the body because pagination needs the
   * response's `Link` header, and `#httpError` needs the response's status and
   * rate-limit headers.
   *
   * @param {string} url absolute URL — always derived from `apiBase`, never taken
   *   from a caller. Page 2+ URLs come out of a `Link` header and are origin-checked
   *   by `#getPaged` before they reach here, because this request carries a bearer
   *   token and a response header must not be able to redirect it off-host.
   * @param {string} path the API path, for error messages
   * @param {{tolerate?: number[]}} [options] statuses that resolve to `null`
   *   instead of throwing — used for endpoints ARF is expected not to be able to
   *   read (branch protection needs admin) and for a PR that does not exist.
   */
  async #send(url, path, { tolerate = [] } = {}) {
    // Per-request, so a rotated token takes effect and a revoked one fails loud
    // here rather than at the next restart. Awaited rather than read
    // synchronously: this runs on every outbound call, and a blocking read here
    // stalls the whole event loop for the duration of a batch refresh.
    const token = await readGithubToken(this.config, { env: this.env });
    this.requestCount += 1;

    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': this.userAgent,
        },
        signal: AbortSignal.timeout(this.github.requestTimeoutMs),
      });
    } catch (err) {
      throw new ArfGithubError(
        `GET ${path} could not reach ${this.github.apiBase}: ${err.message}`,
        { code: 'github_unreachable', cause: err },
      );
    }

    this.#recordRateLimit(res);
    if (res.ok) return { body: await this.#json(res, path), res };
    if (tolerate.includes(res.status)) {
      // Every other exit from this method consumes the body: `#json` on success,
      // `#errorDetail` on the throwing path. This one has no use for it and must
      // still release it — see `#discard`.
      await this.#discard(res);
      return null;
    }
    throw await this.#httpError(res, path);
  }

  /**
   * Release a response body ARF has no use for.
   *
   * `fetch` hands back a response whose body is an unread stream holding its
   * connection open. Dropping the object without reading or cancelling leaks the
   * socket until the GC eventually reclaims it, which under undici's connection
   * pool means the pool fills with half-consumed connections. The tolerated-status
   * path is the one that makes this routine rather than exotic: branch protection
   * answers 403 for any identity without repo admin — the *expected* case for a
   * reviewer token — so it is one leaked socket per PR per refresh, and a batch
   * sweep walks a page of PRs at a time. That ends in fd exhaustion, and the
   * symptom is ARF refusing new connections rather than anything pointing here.
   *
   * `cancel()` in preference to reading: it discards without buffering a body
   * nobody will look at. Feature-detected because a test double is a plain object
   * with `json`/`text` and no stream, and best-effort because a body that is
   * already consumed or errored is exactly the state being aimed for anyway.
   */
  async #discard(res) {
    try {
      if (typeof res?.body?.cancel === 'function') {
        await res.body.cancel();
        return;
      }
      if (typeof res?.arrayBuffer === 'function') await res.arrayBuffer();
    } catch {
      // Nothing left to reclaim.
    }
  }

  /** A single-page read. `null` when the status was tolerated. */
  async #get(path, options) {
    const result = await this.#send(`${this.github.apiBase}${path}`, path, options);
    return result === null ? null : result.body;
  }

  /**
   * Every page of a paginated collection, concatenated.
   *
   * GitHub caps `per_page` at 100 and hands back the rest through `Link`
   * headers, so a first-page-only read is a **silent** truncation: a required
   * check on page 2 never reaches `summarizeChecks`, which conservatively calls
   * a required context that never reported `pending` — and the PR sits pending
   * forever while every check is actually green. Matrix builds cross 100 check
   * runs routinely, so this is the ordinary case, not the pathological one.
   *
   * `maxPages` bounds the walk (a paginated read is otherwise unbounded API
   * load). Hitting the bound **throws** rather than returning a short list: the
   * whole point of paginating is that a truncated collection produces a wrong
   * rollup, and a bound that truncates quietly just moves the reviewer's bug to
   * a higher page number. `ArfGithubError` is transient, not fail-loud, so the
   * mirror degrades to the stale cached row with `refreshError` set — visible,
   * and the message names the knob to raise.
   *
   * @param {string} path first-page API path (already carrying `per_page`)
   * @param {{extract?: (body: any) => any}} [options] pull the array out of an
   *   enveloped body (`{check_runs: []}`, `{statuses: []}`); defaults to the body.
   */
  async #getPaged(path, { extract = (body) => body } = {}) {
    const { origin } = new URL(this.github.apiBase);
    const maxPages = this.github.maxPages;
    const items = [];
    let url = `${this.github.apiBase}${path}`;
    let pages = 0;

    while (url) {
      pages += 1;
      if (pages > maxPages) {
        throw new ArfGithubError(
          `GET ${path} has more than ${maxPages} pages of results; refusing to report a `
          + 'truncated collection as complete. Raise githubMaxPages (ARF_GITHUB_MAX_PAGES).',
          { code: 'github_too_many_pages' },
        );
      }
      const { body, res } = await this.#send(url, path);
      const page = extract(body);
      if (Array.isArray(page)) items.push(...page);

      const next = parseNextLink(res?.headers?.get?.('link'));
      if (!next) break;
      let nextUrl;
      try {
        nextUrl = new URL(next, url);
      } catch {
        throw new ArfGithubError(
          `GET ${path} returned an unparseable Link header for page ${pages + 1}`,
          { code: 'github_bad_response' },
        );
      }
      if (nextUrl.origin !== origin) {
        // The request that follows this link carries ARF's bearer token. A
        // response header does not get to choose who receives it.
        throw new ArfGithubError(
          `GET ${path} returned a Link header pointing off ${origin} (${nextUrl.origin}); refusing to follow it`,
          { code: 'github_bad_response' },
        );
      }
      url = nextUrl.toString();
    }
    return items;
  }

  #recordRateLimit(res) {
    const header = (name) => {
      const value = res?.headers?.get?.(name);
      return value === null || value === undefined || value === '' ? null : value;
    };
    const remaining = header('x-ratelimit-remaining');
    const limit = header('x-ratelimit-limit');
    const reset = header('x-ratelimit-reset');
    if (remaining !== null) this.rateLimit.remaining = Number(remaining);
    if (limit !== null) this.rateLimit.limit = Number(limit);
    if (reset !== null) this.rateLimit.resetAt = new Date(Number(reset) * 1000).toISOString();
  }

  async #json(res, path) {
    try {
      return await res.json();
    } catch (err) {
      throw new ArfGithubError(
        `GET ${path} returned a body that is not JSON: ${err.message}`,
        { status: res.status, code: 'github_bad_response', cause: err },
      );
    }
  }

  /**
   * `Retry-After` in ms, or null when the header is absent or unusable.
   *
   * Explicitly null-checked rather than run through `Number()`: `Number(null)` is
   * `0`, which is a perfectly finite non-negative number and would make *every*
   * 403 look like a rate limit with a zero-second backoff — turning a genuine
   * permissions failure into a transient error that hides behind a stale row.
   * RFC 9110 allows delay-seconds or an HTTP-date; both appear in the wild.
   */
  #retryAfterMs(value) {
    if (value === null) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - this.now()) : null;
  }

  /**
   * Classify a failing response as a rate limit, or null when it is not one.
   *
   * The hard part is the **secondary** limit. GitHub signals three different
   * things with `403`:
   *
   *   - primary budget exhausted — `x-ratelimit-remaining: 0`,
   *   - secondary (burst/concurrency) limit — a `retry-after` header and/or a
   *     "secondary rate limit" body message, with the primary budget untouched,
   *   - a genuine permissions failure.
   *
   * Only the third is an auth failure. The first two are transient and must not
   * be fail-loud: `isFailLoud` on a throttle aborts the batch refresh and answers
   * the dashboard with a 503 instead of the stale-but-real rows it already holds.
   * A 429 is a rate limit unconditionally — GitHub uses it for the same signal.
   */
  #rateLimitError(res, path, detail) {
    const header = (name) => {
      const value = res?.headers?.get?.(name);
      return value === null || value === undefined || value === '' ? null : String(value);
    };
    if (res.status !== 403 && res.status !== 429) return null;

    const retryAfterMs = this.#retryAfterMs(header('retry-after'));
    const exhausted = header('x-ratelimit-remaining') === '0';
    const messaged = SECONDARY_RATE_LIMIT_MESSAGE.test(String(detail));

    if (res.status === 403 && !exhausted && retryAfterMs === null && !messaged) return null;

    const scope = exhausted ? 'primary' : 'secondary';
    // A secondary limit publishes `retry-after`, not `x-ratelimit-reset`, so the
    // primary reset would be a stale and misleading answer for it.
    const resetAt = scope === 'primary'
      ? this.rateLimit.resetAt
      : (retryAfterMs === null ? null : new Date(this.now() + retryAfterMs).toISOString());
    const backoff = retryAfterMs === null
      ? `resets ${resetAt ?? 'unknown'}`
      : `retry after ${Math.round(retryAfterMs / 1000)}s`;

    return new ArfGithubRateLimitError(
      `GitHub ${scope} rate limit hit on GET ${path} (${res.status}, ${backoff}): ${detail}`,
      { status: res.status, resetAt, retryAfterMs, scope },
    );
  }

  /**
   * Map an HTTP failure onto the taxonomy in `errors.mjs`.
   *
   * 401 and a non-rate-limit 403 are both auth failures: GitHub answers "bad
   * credentials" with 401 and "resource not accessible by this installation"
   * with 403, and an under-scoped app is as fatal to an honest dashboard as a
   * missing token. Both name the configured source, because the fix is there.
   * Rate limits are peeled off first — see `#rateLimitError`.
   */
  async #httpError(res, path) {
    const detail = await this.#errorDetail(res);
    const source = tokenSource(this.config);
    const via = source.kind === 'file' ? `token file ${source.ref}` : `env ${source.ref}`;

    if (res.status === 401) {
      return new ArfGithubAuthError(
        `GitHub rejected the configured token (401) on GET ${path}: ${detail}. `
        + `The token comes from ${via} — replace or re-mint it. ARF does not fall back `
        + 'to another identity.',
        { status: 401 },
      );
    }
    const limited = this.#rateLimitError(res, path, detail);
    if (limited) return limited;
    if (res.status === 403) {
      return new ArfGithubAuthError(
        `GitHub refused GET ${path} (403): ${detail}. The token from ${via} lacks the `
        + 'access this read needs; grant it rather than letting ARF show placeholders.',
        { status: 403 },
      );
    }
    if (res.status === 404) {
      return new ArfGithubNotFoundError(`GET ${path} not found (404): ${detail}`);
    }
    return new ArfGithubError(`GET ${path} failed (${res.status}): ${detail}`, {
      status: res.status,
      code: 'github_error',
    });
  }

  async #errorDetail(res) {
    try {
      const body = await res.text();
      if (!body) return res.statusText || 'no body';
      try {
        return String(JSON.parse(body).message ?? body).slice(0, 300);
      } catch {
        return body.slice(0, 300);
      }
    } catch {
      return res.statusText || 'unreadable body';
    }
  }

  /** `GET /repos/{repo}/pulls/{pr}` — title, author, labels, mergeable, head. */
  async pullRequest(repo, prNumber) {
    return this.#get(`/repos/${assertRepo(repo)}/pulls/${assertPrNumber(prNumber)}`);
  }

  /**
   * `GET /repos/{repo}/pulls/{pr}/reviews` — the review bodies, every page.
   *
   * Paginated because reviews accumulate: a long adversarial-review cycle passes
   * 100 rows, and the ones that fall off the end are the *newest* — GitHub
   * returns reviews oldest-first, so a first-page-only read drops exactly the
   * latest approval or `CHANGES_REQUESTED` the dashboard exists to show.
   */
  async reviews(repo, prNumber) {
    return this.#getPaged(
      `/repos/${assertRepo(repo)}/pulls/${assertPrNumber(prNumber)}/reviews?per_page=100`,
    );
  }

  /** `GET /repos/{repo}/commits/{sha}/check-runs` — modern checks, every page. */
  async checkRuns(repo, sha) {
    return this.#getPaged(
      `/repos/${assertRepo(repo)}/commits/${encodeURIComponent(String(sha))}/check-runs?per_page=100`,
      { extract: (body) => body?.check_runs },
    );
  }

  /** `GET /repos/{repo}/commits/{sha}/status` — legacy commit statuses, every page. */
  async commitStatuses(repo, sha) {
    return this.#getPaged(
      `/repos/${assertRepo(repo)}/commits/${encodeURIComponent(String(sha))}/status?per_page=100`,
      { extract: (body) => body?.statuses },
    );
  }

  /**
   * The required-check contexts from branch protection, or null when they
   * cannot be read.
   *
   * Reading protection needs admin on the repo, and a reviewer identity should
   * not have it — so 403/404 are tolerated and answer "unknown", which the
   * rollup then labels `requiredKnown: false`. Claiming an empty required set
   * instead would report every PR as having nothing to satisfy.
   */
  async requiredStatusChecks(repo, branch) {
    const ref = text(branch);
    if (!ref) return null;
    const body = await this.#get(
      `/repos/${assertRepo(repo)}/branches/${encodeURIComponent(ref)}/protection/required_status_checks`,
      { tolerate: [403, 404] },
    );
    if (!body) return null;
    if (Array.isArray(body.contexts)) return body.contexts.map((name) => String(name));
    if (Array.isArray(body.checks)) return body.checks.map((check) => String(check?.context ?? ''));
    return [];
  }

  /**
   * One PR's complete mirror record — the composite read the cache stores.
   *
   * Five requests for the ordinary PR, four of them concurrent behind the PR read
   * (they all need its head sha or base ref). Three of those five are paginated
   * collections, so a PR with more than 100 reviews / check runs / statuses costs
   * one extra request per extra page — bounded by `maxPages` per collection. The
   * TTL is still a meaningful bound on API load because the per-refresh cost is
   * bounded; it is just bounded by `3 * maxPages + 2` rather than by 5.
   *
   * @returns {object} the record shape `MirrorStore.upsert` takes
   */
  async fetchPullRequest(repo, prNumber) {
    const name = assertRepo(repo);
    const pr = assertPrNumber(prNumber);
    const body = await this.#get(`/repos/${name}/pulls/${pr}`);

    const headSha = text(body?.head?.sha);
    const baseRef = text(body?.base?.ref);
    const authorLogin = text(body?.user?.login);
    const title = text(body?.title);

    const [reviews, checkRuns, statuses, requiredContexts] = await Promise.all([
      this.reviews(name, pr),
      headSha ? this.checkRuns(name, headSha) : Promise.resolve([]),
      headSha ? this.commitStatuses(name, headSha) : Promise.resolve([]),
      this.requiredStatusChecks(name, baseRef),
    ]);

    const entries = [
      ...checkRuns.map(normalizeCheckRun),
      ...statuses.map(normalizeCommitStatus),
    ];

    const at = this.now();
    const { builder, builderSource } = deriveBuilder(title, authorLogin);
    return {
      repo: name,
      pr,
      title,
      author: authorLogin,
      authorType: text(body?.user?.type),
      builder,
      builderSource,
      state: text(body?.state),
      draft: body?.draft === undefined ? null : Boolean(body.draft),
      merged: body?.merged === undefined ? null : Boolean(body.merged),
      // Deliberately NOT coerced to a boolean: GitHub answers `null` while it
      // computes the test merge commit, and calling that `false` would report a
      // clean PR as conflicted for as long as the computation takes.
      mergeable: body?.mergeable === null || body?.mergeable === undefined
        ? null
        : Boolean(body.mergeable),
      mergeableState: text(body?.mergeable_state),
      headSha,
      baseRef,
      url: text(body?.html_url),
      labels: Array.isArray(body?.labels)
        ? body.labels.map((label) => text(label?.name ?? label)).filter(Boolean)
        : [],
      checks: summarizeChecks(entries, { requiredContexts }),
      reviews: reviews.map((review) => ({
        id: review?.id === undefined || review?.id === null ? null : String(review.id),
        author: text(review?.user?.login),
        authorType: text(review?.user?.type),
        state: text(review?.state),
        submittedAt: text(review?.submitted_at),
        // The whole body: an adversarial review's findings ARE the body, and
        // truncating it here would silently drop the blocking issues the
        // dashboard's drill-in exists to show.
        body: review?.body === null || review?.body === undefined ? null : String(review.body),
        url: text(review?.html_url),
      })),
      fetchedAt: new Date(at).toISOString(),
      fetchedAtMs: at,
    };
  }
}
