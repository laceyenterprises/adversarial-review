/**
 * The GitHub mirror service (ARF-02) — cache policy, projection, and the join
 * seam the dashboard reads through.
 *
 * ## What this is for
 *
 * `reviews.db` knows a PR's review state and nothing about the PR itself. The
 * operator-console Review space therefore renders `PR #<n>` and `builder = —`,
 * and it is honest to do so — it has nothing better. ARF-02 gives it something
 * better: a cached GitHub read, keyed by PR number, that ARF-03 joins onto the
 * store's PR rows.
 *
 * ## The cache policy, and why each bound exists
 *
 *   - **TTL** (`mirrorTtlMs`). Inside it, a read is served from the cache and
 *     sends no request at all. This is the bound that stops a dashboard poll
 *     from being a GitHub poll.
 *   - **Minimum refresh interval** (`minRefreshIntervalMs`). A floor that even
 *     `force: true` respects. Without it, a refresh button — or an ARF-03 render
 *     loop that passes `force` — turns straight back into a hammer, and the TTL
 *     stops meaning anything.
 *   - **In-flight de-duplication.** Concurrent reads of the same PR share one
 *     fetch. Ten dashboard tabs opening at once is one refresh, not ten.
 *   - **Refresh budget + concurrency cap** (`refreshBudget`,
 *     `maxConcurrentRefreshes`) on batch reads. A 200-PR list must not become 200
 *     concurrent refreshes. Refs past the budget are served from cache and
 *     reported as `deferred` — the count is in the result, never a silent
 *     truncation that reads as "everything is current".
 *
 * ## What fails loud, and what does not
 *
 * A missing, unresolved, or rejected token throws (`ArfGithubAuthError`) out of
 * every path here — it is never absorbed into a cached or empty answer. That is
 * the ticket's fourth requirement and SPEC §6's ambient-identity RCA: an
 * identity failure that renders as "no data" is indistinguishable from an empty
 * pipeline, and nobody investigates an empty pipeline.
 *
 * A *transient* failure (5xx, network, rate limit) over a PR that already has a
 * cached row returns that row with `refreshError` set and `stale: true`. That is
 * not a placeholder: it is real GitHub data with its age stated. A PR with no
 * cached row propagates the error instead of inventing one.
 */

import { mirrorKey } from '../store/mirror-store.mjs';
import { isFailLoud } from './errors.mjs';
import { assertPrNumber, assertRepo } from './client.mjs';
import { describeTokenSource } from './token.mjs';

export { mirrorKey };

/**
 * The fields the dashboard consumes. Named here rather than left implicit so the
 * projection has a shape test to fail against when it drifts — ARF-03 renders
 * exactly these.
 */
export const MIRROR_PROJECTION_FIELDS = Object.freeze([
  'repo', 'pr', 'title', 'builder', 'builderSource', 'author', 'authorType', 'labels',
  'state', 'draft', 'merged', 'mergeable', 'mergeableState', 'headSha', 'headShaShort',
  'baseRef', 'url', 'checks', 'reviews', 'fetchedAt', 'ageMs', 'stale',
]);

function shortSha(value) {
  return value ? String(value).slice(0, 7) : null;
}

/**
 * A cached record into the dashboard-facing projection.
 *
 * `ageMs` and `stale` are computed at read time rather than stored, because the
 * answer to "is this current?" changes while the row does not. Every consumer
 * gets to see the age; nothing has to trust that a row is fresh because it
 * exists.
 */
export function projectMirror(record, { now = Date.now(), ttlMs = 0 } = {}) {
  if (!record) return null;
  const ageMs = Math.max(0, now - Number(record.fetchedAtMs ?? 0));
  return {
    repo: record.repo,
    pr: Number(record.pr),
    title: record.title ?? null,
    builder: record.builder ?? null,
    builderSource: record.builderSource ?? null,
    author: record.author ?? null,
    authorType: record.authorType ?? null,
    labels: Array.isArray(record.labels) ? record.labels : [],
    state: record.state ?? null,
    draft: record.draft ?? null,
    merged: record.merged ?? null,
    mergeable: record.mergeable ?? null,
    mergeableState: record.mergeableState ?? null,
    headSha: record.headSha ?? null,
    headShaShort: shortSha(record.headSha),
    baseRef: record.baseRef ?? null,
    url: record.url ?? null,
    checks: record.checks ?? null,
    reviews: Array.isArray(record.reviews) ? record.reviews : [],
    fetchedAt: record.fetchedAt ?? null,
    ageMs,
    stale: ttlMs > 0 ? ageMs > ttlMs : false,
  };
}

/** Sentinel for a PR number that exists in more than one mirrored repo. */
const AMBIGUOUS = Symbol('ambiguous-pr-number');

/**
 * An index for joining mirror rows onto store PR rows.
 *
 * The join key is `(repo, pr)`, and PR number alone resolves when — and only
 * when — that number is unique across the mirrored repos. PR numbers are
 * repository-local, so `#5543` can name two different pull requests; answering
 * with either one would splice a stranger's title and builder onto a review
 * timeline, which is a worse outcome than the placeholder this ticket exists to
 * remove. The store adapter refuses the same ambiguity the same way.
 */
export function mirrorIndex(projections) {
  const byKey = new Map();
  const byPr = new Map();
  for (const projection of projections) {
    if (!projection) continue;
    byKey.set(mirrorKey(projection.repo, projection.pr), projection);
    const pr = Number(projection.pr);
    const seen = byPr.get(pr);
    if (seen === undefined) byPr.set(pr, projection);
    else if (seen !== AMBIGUOUS && mirrorKey(seen.repo, seen.pr) !== mirrorKey(projection.repo, projection.pr)) {
      byPr.set(pr, AMBIGUOUS);
    }
  }
  return {
    size: byKey.size,
    /** @returns {object|null} the mirror row, or null when there is none to trust. */
    lookup(repo, prNumber) {
      const pr = Number(prNumber);
      if (repo) return byKey.get(mirrorKey(repo, pr)) ?? null;
      const hit = byPr.get(pr);
      return hit === undefined || hit === AMBIGUOUS ? null : hit;
    },
    /** True when a bare PR number names more than one mirrored PR. */
    ambiguous(prNumber) {
      return byPr.get(Number(prNumber)) === AMBIGUOUS;
    },
  };
}

/**
 * Attach mirror rows to store PR rows.
 *
 * `mirror: null` is a real state and stays visible: a PR that genuinely has no
 * mirror row yet. That is the *only* case where a caller should fall back to
 * showing `PR #<n>` — which is why the field is null rather than an object full
 * of nulls that would render as data.
 */
export function joinPullRequests(pullRequests, projections) {
  const index = mirrorIndex(projections);
  return pullRequests.map((row) => ({
    ...row,
    mirror: index.lookup(row.repo, row.pr),
  }));
}

export class GithubMirror {
  /**
   * @param {object} options
   * @param {object} options.config resolved ARF config
   * @param {import('./client.mjs').GithubReadClient} options.client
   * @param {import('../store/mirror-store.mjs').MirrorStore} options.store
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {() => number} [options.now]
   */
  constructor({ config, client, store, env = process.env, now = () => Date.now() }) {
    this.config = config;
    this.github = config.github;
    this.client = client;
    this.store = store;
    this.env = env;
    this.now = now;
    /** key -> in-flight refresh promise, so concurrent reads share one fetch. */
    this.inFlight = new Map();
    this.stats = { hits: 0, misses: 0, fetches: 0, throttled: 0, deferred: 0, errors: 0 };
  }

  /**
   * Mirror status: token source, cache counters, rate limit. Never a token
   * value — only the env var name or file path it would be read from.
   *
   * Async because resolving the token source may touch the filesystem, and that
   * read is off the event loop (see `readGithubToken`).
   *
   * @returns {Promise<object>}
   */
  async describe() {
    const token = await describeTokenSource(this.config, { env: this.env });
    return {
      apiBase: this.github.apiBase,
      token,
      // "Can this mirror do anything?" is exactly "does the token resolve?".
      // Reported rather than inferred from an empty cache.
      ready: token.present,
      cache: {
        ...this.store.describe(),
        ttlMs: this.github.mirrorTtlMs,
        minRefreshIntervalMs: this.github.minRefreshIntervalMs,
        refreshBudget: this.github.refreshBudget,
        maxConcurrentRefreshes: this.github.maxConcurrentRefreshes,
        inFlight: this.inFlight.size,
        ...this.stats,
      },
      rateLimit: this.client.rateLimit,
      requests: this.client.requestCount,
    };
  }

  /** The cached projection for a PR, without any possibility of a fetch. */
  cached(repo, prNumber) {
    const record = this.store.get(assertRepo(repo), assertPrNumber(prNumber));
    return projectMirror(record, { now: this.now(), ttlMs: this.github.mirrorTtlMs });
  }

  /**
   * The mirror for one PR, refreshing only when the cache policy says to.
   *
   * @param {string} repo `owner/name`
   * @param {number} prNumber
   * @param {{force?: boolean, allowFetch?: boolean}} [options]
   *   `force` refetches a still-fresh row, subject to `minRefreshIntervalMs`.
   *   `allowFetch: false` is a strict cache read — used by batch calls that have
   *   already spent their refresh budget.
   * @returns {Promise<{mirror: object|null, cacheHit: boolean, fetched: boolean,
   *   throttled?: boolean, deferred?: boolean, refreshError?: object}>}
   */
  async get(repo, prNumber, { force = false, allowFetch = true } = {}) {
    const name = assertRepo(repo);
    const pr = assertPrNumber(prNumber);
    const record = this.store.get(name, pr);
    const at = this.now();
    const ageMs = record ? at - Number(record.fetchedAtMs ?? 0) : Infinity;

    if (record && !force && ageMs <= this.github.mirrorTtlMs) {
      this.stats.hits += 1;
      return { mirror: this.#project(record), cacheHit: true, fetched: false };
    }
    if (record && force && ageMs < this.github.minRefreshIntervalMs) {
      // The floor under `force`. A caller asked for fresh and gets the most
      // recent read, labelled as throttled so it can say so rather than imply a
      // refresh happened.
      this.stats.hits += 1;
      this.stats.throttled += 1;
      return { mirror: this.#project(record), cacheHit: true, fetched: false, throttled: true };
    }
    if (!allowFetch) {
      this.stats.deferred += 1;
      return { mirror: this.#project(record), cacheHit: Boolean(record), fetched: false, deferred: true };
    }

    this.stats.misses += 1;
    try {
      const refreshed = await this.#refresh(name, pr);
      return { mirror: this.#project(refreshed), cacheHit: false, fetched: true };
    } catch (err) {
      this.stats.errors += 1;
      // An auth failure is never softened into cached-or-empty: it would render
      // as "this PR has no mirror yet", which is precisely the silent
      // degradation this ticket forbids.
      if (isFailLoud(err) || !record) throw err;
      return {
        mirror: this.#project(record),
        cacheHit: true,
        fetched: false,
        refreshError: { code: err.code ?? 'github_error', message: err.message },
      };
    }
  }

  /**
   * Mirrors for a set of `{repo, pr}` refs, under the refresh budget.
   *
   * Refs already cached and fresh cost nothing. Refs needing a refresh are
   * fetched up to `refreshBudget`, `maxConcurrentRefreshes` at a time; the rest
   * are served from cache and counted in `deferred`. The caller is told the
   * number — a bounded sweep that does not report its bound reads as complete
   * coverage.
   *
   * @param {{repo: string, pr: number}[]} refs
   * @param {{limit?: number, force?: boolean}} [options]
   */
  async getMany(refs, { limit = this.github.refreshBudget, force = false } = {}) {
    const normalized = refs.map((ref) => ({ repo: assertRepo(ref.repo), pr: assertPrNumber(ref.pr) }));
    const cachedRows = this.store.getMany(normalized);
    const at = this.now();

    const needsRefresh = [];
    const throttledRefs = [];
    const fresh = new Map();
    for (const ref of normalized) {
      const record = cachedRows.get(mirrorKey(ref.repo, ref.pr)) ?? null;
      const ageMs = record ? at - Number(record.fetchedAtMs ?? 0) : Infinity;
      if (record && !force && ageMs <= this.github.mirrorTtlMs) fresh.set(mirrorKey(ref.repo, ref.pr), record);
      // Under `force`, a row inside minRefreshIntervalMs is served from cache by
      // `get()` and costs no GitHub request. Counting it against the refresh
      // budget anyway would spend a slot on a ref that was never going to be
      // fetched, and defer a genuinely stale ref that would have been — the
      // budget exists to bound API calls, so only refs that make one may spend it.
      else if (record && force && ageMs < this.github.minRefreshIntervalMs) throttledRefs.push(ref);
      else needsRefresh.push(ref);
    }

    const budget = Math.max(0, Math.floor(Number(limit)));
    const toRefresh = needsRefresh.slice(0, budget);
    const deferredRefs = needsRefresh.slice(budget);

    const refreshed = new Map();
    const failures = new Map();
    await this.#mapBounded(toRefresh, async (ref) => {
      const key = mirrorKey(ref.repo, ref.pr);
      const result = await this.get(ref.repo, ref.pr, { force }).catch((err) => {
        // An auth failure aborts the whole batch: with one identity, one 401
        // means every other ref in this batch would 401 too, and finishing the
        // sweep would just produce a page of half-real rows.
        if (isFailLoud(err)) throw err;
        failures.set(key, { code: err.code ?? 'github_error', message: err.message });
        return null;
      });
      if (result?.mirror) refreshed.set(key, result.mirror);
      if (result?.refreshError) failures.set(key, result.refreshError);
    }, this.github.maxConcurrentRefreshes);

    this.stats.deferred += deferredRefs.length;
    // Throttled refs never reached `get()`, so their stats are booked here. They
    // are cache hits, and they are throttled — the same two counters `get()`
    // would have moved.
    this.stats.hits += fresh.size + throttledRefs.length;
    this.stats.throttled += throttledRefs.length;

    const mirrors = normalized.map((ref) => {
      const key = mirrorKey(ref.repo, ref.pr);
      if (refreshed.has(key)) return refreshed.get(key);
      const record = fresh.get(key) ?? cachedRows.get(key) ?? null;
      return this.#project(record);
    }).filter(Boolean);

    return {
      mirrors,
      index: mirrorIndex(mirrors),
      refreshed: refreshed.size,
      cacheHits: fresh.size + throttledRefs.length,
      // Reported separately from `deferred`: a throttled ref is "asked for fresh
      // too soon", a deferred one is "budget ran out". Conflating them would tell
      // a caller to spend another budget on rows the refresh floor will refuse
      // again anyway.
      throttled: throttledRefs.length,
      // Never silently dropped: a caller that cares can spend another budget on
      // these, and a UI can say "N rows not refreshed this pass".
      deferred: deferredRefs.length,
      deferredRefs,
      errors: [...failures.entries()].map(([key, error]) => ({ key, ...error })),
    };
  }

  /** Refresh + write, de-duplicated per PR so concurrent readers share a fetch. */
  #refresh(repo, prNumber) {
    const key = mirrorKey(repo, prNumber);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const record = await this.client.fetchPullRequest(repo, prNumber);
      this.store.upsert(record);
      this.stats.fetches += 1;
      return record;
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  #project(record) {
    return projectMirror(record, { now: this.now(), ttlMs: this.github.mirrorTtlMs });
  }

  /**
   * Run `worker` over `items` with at most `concurrency` in flight.
   *
   * `aborted` stops the remaining runners once one throws: without it a batch
   * that fails loud on a 401 would keep firing the rest of its requests against
   * an identity that has already been refused.
   */
  async #mapBounded(items, worker, concurrency) {
    if (items.length === 0) return;
    const width = Math.max(1, Math.min(Math.floor(concurrency), items.length));
    let next = 0;
    let aborted = false;
    const runner = async () => {
      while (!aborted) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          await worker(items[index], index);
        } catch (err) {
          aborted = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: width }, runner));
  }
}

/**
 * Build the mirror for a config. Kept beside the store's `openReviewStore` so
 * wiring one is the same one-liner.
 */
export function openGithubMirror(config, { client, store, env = process.env, now } = {}) {
  return new GithubMirror({ config, client, store, env, now });
}
