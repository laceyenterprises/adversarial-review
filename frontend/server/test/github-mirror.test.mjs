/**
 * GitHub mirror tests (ARF-02).
 *
 * The four properties the ticket names:
 *
 *   1. the mirror projection is the shape the dashboard consumes,
 *   2. a store PR row and its mirror row resolve on PR number,
 *   3. a cache hit avoids a second fetch; a miss triggers exactly one,
 *   4. a missing/invalid token raises rather than returning placeholders.
 *
 * Fetches are counted, not mocked-and-trusted: "the cache avoided a request" is
 * only an assertion if the requests are countable.
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MODE_IN_OS, loadConfig } from '../src/config.mjs';
import { GithubReadClient, assertRepo, deriveBuilder, parseNextLink } from '../src/github/client.mjs';
import { readGithubToken } from '../src/github/token.mjs';
import {
  ArfGithubAuthError,
  ArfGithubError,
  ArfGithubNotFoundError,
  ArfGithubRateLimitError,
  isFailLoud,
} from '../src/github/errors.mjs';
import {
  GithubMirror,
  MIRROR_PROJECTION_FIELDS,
  joinPullRequests,
  mirrorIndex,
  projectMirror,
} from '../src/github/mirror.mjs';
import { MirrorStore } from '../src/store/mirror-store.mjs';
import { closeQuietly, openWritableMirror } from '../src/store/sqlite.mjs';
import { ReviewStore } from '../src/store/review-store.mjs';
import { FAKE_REPO, REQUESTS_PER_REFRESH, fakeGithub } from './fixtures/fake-github.mjs';
import { FIXTURE_PATH } from './fixtures/build-reviews-fixture.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'arf-mirror-'));
}

const START = 1_786_000_000_000;

/**
 * A mirror wired to a fake GitHub, a temp cache, and a hand-cranked clock.
 * The clock is what makes TTL assertions deterministic instead of timing-based.
 */
function harness({
  env: extra = {},
  fail = null,
  protectionReadable = true,
  config: configEnv = {},
  bulk = {},
  linkOverride = null,
} = {}) {
  const dir = tmpDir();
  const env = { ARF_STATE_ROOT: dir, ARF_GITHUB_TOKEN: 'ghs_testtoken', ...extra };
  const config = loadConfig({ env: { ...env, ...configEnv } });
  const clock = { t: START };
  const now = () => clock.t;
  const { fetchImpl, state } = fakeGithub({ fail, protectionReadable, bulk, linkOverride });
  const client = new GithubReadClient({ config, env, fetchImpl, now });
  const store = new MirrorStore({
    path: config.github.mirrorPath,
    reviewStorePath: config.storePath,
    busyTimeoutMs: config.busyTimeoutMs,
  });
  const mirror = new GithubMirror({ config, client, store, env, now });
  return { dir, env, config, clock, state, client, store, mirror };
}

describe('GitHub read client', () => {
  it('fetches the fields reviews.db does not carry', async () => {
    const { client } = harness();
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);

    assert.equal(record.title, '[claude-code] (feat) ARF-01: backend skeleton + review-state store adapter');
    assert.equal(record.author, 'agent-os-builder[bot]');
    assert.equal(record.builder, 'claude-code');
    assert.deepEqual(record.labels, ['adversarial-review', 'agent-built']);
    assert.equal(record.state, 'open');
    assert.equal(record.mergeableState, 'blocked');
    assert.equal(record.headSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    // `tests` is required and still in progress, so the rollup is pending even
    // though every check that has concluded is green.
    assert.equal(record.checks.rollup, 'pending');
    assert.equal(record.checks.requiredKnown, true);
    assert.equal(record.reviews.length, 2);
    assert.match(record.reviews[0].body, /Blocking issues/);
    assert.equal(record.reviews[0].state, 'CHANGES_REQUESTED');
  });

  it('keeps an uncomputed mergeable as unknown rather than false', async () => {
    // GitHub answers `mergeable: null` while it builds the test merge commit.
    // Coercing that to false reports a clean PR as conflicted.
    const { client } = harness();
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);
    assert.equal(record.mergeable, null);
  });

  it('sends only authenticated GETs', async () => {
    const { client, state } = harness();
    await client.fetchPullRequest(FAKE_REPO, 5543);
    assert.equal(state.count, REQUESTS_PER_REFRESH);
    for (const call of state.calls) {
      assert.equal(call.method, 'GET', `${call.path} must be a GET — ARF never writes to GitHub`);
      assert.equal(call.authorization, 'Bearer ghs_testtoken');
    }
  });

  it('derives the builder from the worker-class title prefix, else the author', () => {
    assert.deepEqual(deriveBuilder('[codex] ROS-02 send-turn', 'bot[bot]'), {
      builder: 'codex',
      builderSource: 'title-prefix',
    });
    assert.deepEqual(deriveBuilder('plain human PR', 'someone'), {
      builder: 'someone',
      builderSource: 'author',
    });
    assert.deepEqual(deriveBuilder(null, null), { builder: null, builderSource: null });
  });

  it('reports required-checks as unknown when branch protection is unreadable', async () => {
    // 403 on protection is the normal case: a reviewer identity is not an admin.
    const { client } = harness({ protectionReadable: false });
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);
    assert.equal(record.checks.requiredKnown, false);
    // Every reported check gates instead, so the failing optional-lint blocks.
    assert.equal(record.checks.rollup, 'failure');
  });

  it('refuses a repo name that could walk the request path', () => {
    assert.throws(() => assertRepo('owner/../../user'), ArfGithubError);
    assert.throws(() => assertRepo('notaslug'), ArfGithubError);
    assert.equal(assertRepo('laceyenterprises/agent-os'), 'laceyenterprises/agent-os');
  });

  it('maps GitHub failures onto the error taxonomy', async () => {
    const unauthorized = harness({ fail: { status: 401, body: { message: 'Bad credentials' } } });
    await assert.rejects(unauthorized.client.fetchPullRequest(FAKE_REPO, 5543), ArfGithubAuthError);

    const forbidden = harness({ fail: { status: 403, body: { message: 'Resource not accessible by integration' } } });
    await assert.rejects(forbidden.client.fetchPullRequest(FAKE_REPO, 5543), ArfGithubAuthError);

    const limited = harness({
      fail: { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } },
    });
    await assert.rejects(limited.client.fetchPullRequest(FAKE_REPO, 5543), ArfGithubRateLimitError);

    const missing = harness();
    await assert.rejects(missing.client.fetchPullRequest(FAKE_REPO, 999999), ArfGithubNotFoundError);

    const broken = harness({ fail: { status: 500, body: { message: 'server error' } } });
    await assert.rejects(broken.client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubError && err.status === 500
    ));
  });

  it('classifies a secondary rate limit as transient, not as an auth failure', async () => {
    // The regression: a secondary limit is a 403 with the *primary* budget
    // untouched, so it is byte-identical to "your token lacks access" unless
    // `retry-after` or the body message is read. Calling it an auth error makes
    // it fail-loud, which 503s the dashboard over a throttle that a stale cached
    // row would have ridden out.
    const secondary = harness({
      fail: {
        status: 403,
        body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4321' },
      },
    });
    await assert.rejects(secondary.client.fetchPullRequest(FAKE_REPO, 5543), (err) => {
      assert.ok(err instanceof ArfGithubRateLimitError, `got ${err.name}`);
      assert.equal(err instanceof ArfGithubAuthError, false, 'a throttle must never be fail-loud');
      assert.equal(isFailLoud(err), false);
      assert.equal(err.scope, 'secondary');
      assert.equal(err.retryAfterMs, 60_000);
      // The secondary limit publishes retry-after, not x-ratelimit-reset.
      assert.equal(err.resetAt, new Date(START + 60_000).toISOString());
      return true;
    });
  });

  it('classifies a bare retry-after 403 and a 429 as rate limits', async () => {
    // Secondary limits do not always carry a recognisable message; `retry-after`
    // alone is enough, and GitHub also serves the same signal as 429.
    const bare = harness({
      fail: { status: 403, body: { message: 'Forbidden' }, headers: { 'retry-after': '30' } },
    });
    await assert.rejects(bare.client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubRateLimitError && err.scope === 'secondary' && !isFailLoud(err)
    ));

    const tooMany = harness({
      fail: { status: 429, body: { message: 'Too Many Requests' } },
    });
    await assert.rejects(tooMany.client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubRateLimitError && err.status === 429 && !isFailLoud(err)
    ));
  });

  it('still calls a genuine permissions 403 an auth failure', async () => {
    // The other half of the classification: loosening the 403 branch must not
    // turn an under-scoped token into a transient error that hides behind a
    // stale row forever.
    const scoped = harness({
      fail: {
        status: 403,
        body: { message: 'Resource not accessible by integration' },
        headers: { 'x-ratelimit-remaining': '4999' },
      },
    });
    await assert.rejects(scoped.client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubAuthError && isFailLoud(err)
    ));
  });

  it('serves the stale cached row through a secondary rate limit instead of failing the read', async () => {
    // End-to-end on the reviewer's actual complaint: the dashboard keeps working.
    const { mirror, store, clock, config } = harness();
    const first = await mirror.get(FAKE_REPO, 5543);
    assert.equal(first.fetched, true);

    const { fetchImpl } = fakeGithub({
      fail: {
        status: 403,
        body: { message: 'You have exceeded a secondary rate limit.' },
        headers: { 'retry-after': '45', 'x-ratelimit-remaining': '4200' },
      },
    });
    const now = () => clock.t;
    const throttled = new GithubMirror({
      config,
      client: new GithubReadClient({ config, env: { ARF_GITHUB_TOKEN: 'ghs_testtoken' }, fetchImpl, now }),
      store,
      now,
    });

    clock.t += config.github.mirrorTtlMs + 1;
    const stale = await throttled.get(FAKE_REPO, 5543);
    assert.equal(stale.refreshError.code, 'github_rate_limited');
    assert.equal(stale.mirror.title, first.mirror.title, 'real data, just older');
    assert.equal(stale.mirror.stale, true, 'and labelled as older');
  });
});

describe('pagination', () => {
  it('parses the next link out of a real GitHub Link header', () => {
    const header = '<https://api.github.com/x?page=1>; rel="prev", '
      + '<https://api.github.com/x?page=3>; rel="next", '
      + '<https://api.github.com/x?page=9>; rel="last"';
    assert.equal(parseNextLink(header), 'https://api.github.com/x?page=3');
    assert.equal(parseNextLink('<https://api.github.com/x?page=9>; rel="last"'), null);
    assert.equal(parseNextLink(null), null);
    assert.equal(parseNextLink(''), null);
  });

  it('follows every page of check runs so a required check on page 2 is not lost', async () => {
    // The reviewer's scenario: a matrix build produces >100 check runs, and the
    // required `tests` context lands on page 2. A first-page-only read reports it
    // as never having run, and `summarizeChecks` — correctly conservative — pins
    // the rollup at `pending` forever on a PR that is entirely green.
    const checkRuns = [
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `matrix-${i}`,
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-08-16T10:15:00Z',
        html_url: `https://github.com/checks/m${i}`,
      })),
      {
        name: 'repo-guards', status: 'completed', conclusion: 'success', completed_at: '2026-08-16T10:16:00Z',
      },
      {
        name: 'tests', status: 'completed', conclusion: 'success', completed_at: '2026-08-16T10:17:00Z',
      },
    ];
    const { client, state } = harness({ bulk: { checkRuns } });
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);

    assert.equal(record.checks.total, checkRuns.length + 1, 'every page, plus the legacy status');
    assert.equal(record.checks.requiredKnown, true);
    assert.equal(record.checks.rollup, 'success', 'the page-2 required check must count as reported');

    const checkRunCalls = state.calls.filter((call) => call.path.endsWith('/check-runs'));
    assert.equal(checkRunCalls.length, 2, 'two pages fetched');
    assert.equal(checkRunCalls[1].page, '2');
  });

  it('follows every page of reviews so the newest verdict is not truncated away', async () => {
    // GitHub returns reviews oldest-first, so a truncated read drops precisely
    // the latest verdict — the one the dashboard drill-in exists to show.
    const reviews = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: 800000 + i,
        user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
        state: 'COMMENTED',
        submitted_at: '2026-08-16T09:00:00Z',
        body: `## Verdict\n\nComment only. (${i})\n`,
      })),
      {
        id: 900099,
        user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
        state: 'APPROVED',
        submitted_at: '2026-08-16T12:00:00Z',
        body: '## Verdict\n\nApproved.\n',
      },
    ];
    const { client } = harness({ bulk: { reviews } });
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);

    assert.equal(record.reviews.length, 101);
    assert.equal(record.reviews.at(-1).state, 'APPROVED');
  });

  it('paginates legacy commit statuses too', async () => {
    const statuses = Array.from({ length: 150 }, (_, i) => ({
      context: `legacy/ci-${i}`,
      state: 'success',
      target_url: `https://ci/${i}`,
      updated_at: '2026-08-16T10:10:00Z',
    }));
    const { client } = harness({ bulk: { statuses } });
    const record = await client.fetchPullRequest(FAKE_REPO, 5543);
    // 150 statuses + the 3 fixture check runs.
    assert.equal(record.checks.total, 153);
  });

  it('refuses a Link header pointing off the configured API origin', async () => {
    // The paginated request carries ARF's bearer token; a response header does
    // not get to choose who receives it.
    const { client } = harness({ linkOverride: '<https://evil.example.com/pull>; rel="next"' });
    await assert.rejects(client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubError
      && err.code === 'github_bad_response'
      && /refusing to follow/.test(err.message)
    ));
  });

  it('raises rather than silently truncating when a collection exceeds maxPages', async () => {
    // A bound that truncates quietly just relocates the stuck-pending bug to a
    // higher page number. `ArfGithubError` is transient, so the mirror falls back
    // to the stale row with the error attached instead of inventing a rollup.
    const { client } = harness({
      config: { ARF_GITHUB_MAX_PAGES: '3' },
      // A `next` link that never terminates, i.e. more pages than the bound.
      linkOverride: '<https://api.github.com/repos/x/y/pulls/1/reviews?page=2>; rel="next"',
    });
    await assert.rejects(client.fetchPullRequest(FAKE_REPO, 5543), (err) => (
      err instanceof ArfGithubError
      && err.code === 'github_too_many_pages'
      && !isFailLoud(err)
      && /ARF_GITHUB_MAX_PAGES/.test(err.message)
    ));
  });
});

describe('mirror cache policy', () => {
  it('a miss fetches once and a hit fetches not at all', async () => {
    const { mirror, state } = harness();

    const miss = await mirror.get(FAKE_REPO, 5543);
    assert.equal(miss.cacheHit, false);
    assert.equal(miss.fetched, true);
    assert.equal(state.count, REQUESTS_PER_REFRESH, 'a miss is exactly one refresh');
    assert.equal(miss.mirror.title, '[claude-code] (feat) ARF-01: backend skeleton + review-state store adapter');

    const hit = await mirror.get(FAKE_REPO, 5543);
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.fetched, false);
    assert.equal(state.count, REQUESTS_PER_REFRESH, 'a hit sends no request at all');
    assert.deepEqual(hit.mirror.labels, miss.mirror.labels);
  });

  it('survives the process: a second mirror over the same cache file still hits', async () => {
    const { config, env, clock, mirror, store } = harness();
    await mirror.get(FAKE_REPO, 5543);

    // A fresh client with its own counter, as a restarted ARF would have.
    const { fetchImpl, state } = fakeGithub();
    const client = new GithubReadClient({ config, env, fetchImpl, now: () => clock.t });
    const restarted = new GithubMirror({ config, client, store, env, now: () => clock.t });
    const hit = await restarted.get(FAKE_REPO, 5543);
    assert.equal(hit.cacheHit, true);
    assert.equal(state.count, 0, 'the cache is on disk, not in the process');
  });

  it('refetches once the TTL expires', async () => {
    const { mirror, clock, state, config } = harness();
    await mirror.get(FAKE_REPO, 5543);
    assert.equal(state.count, REQUESTS_PER_REFRESH);

    clock.t += config.github.mirrorTtlMs + 1;
    const refreshed = await mirror.get(FAKE_REPO, 5543);
    assert.equal(refreshed.cacheHit, false);
    assert.equal(refreshed.fetched, true);
    assert.equal(state.count, REQUESTS_PER_REFRESH * 2);
  });

  it('throttles a forced refresh under the minimum interval', async () => {
    // Without this floor, a refresh button (or an ARF-03 render loop that passes
    // force) turns straight back into an API hammer and the TTL means nothing.
    const { mirror, clock, state, config } = harness();
    await mirror.get(FAKE_REPO, 5543);

    const throttled = await mirror.get(FAKE_REPO, 5543, { force: true });
    assert.equal(throttled.throttled, true);
    assert.equal(throttled.fetched, false);
    assert.equal(state.count, REQUESTS_PER_REFRESH);

    clock.t += config.github.minRefreshIntervalMs;
    const forced = await mirror.get(FAKE_REPO, 5543, { force: true });
    assert.equal(forced.fetched, true);
    assert.equal(state.count, REQUESTS_PER_REFRESH * 2);
  });

  it('collapses concurrent reads of the same PR into one fetch', async () => {
    const { mirror, state } = harness();
    const results = await Promise.all([
      mirror.get(FAKE_REPO, 5543),
      mirror.get(FAKE_REPO, 5543),
      mirror.get(FAKE_REPO, 5543),
    ]);
    assert.equal(state.count, REQUESTS_PER_REFRESH, 'ten dashboard tabs is one refresh, not ten');
    for (const result of results) assert.equal(result.mirror.pr, 5543);
  });

  it('bounds a batch refresh and reports what it deferred', async () => {
    const { mirror, state } = harness({ config: { ARF_GITHUB_REFRESH_BUDGET: '1' } });
    const result = await mirror.getMany([{ repo: FAKE_REPO, pr: 5543 }, { repo: FAKE_REPO, pr: 5541 }]);

    assert.equal(result.refreshed, 1);
    assert.equal(result.deferred, 1, 'the bound is reported, never a silent truncation');
    assert.deepEqual(result.deferredRefs, [{ repo: FAKE_REPO, pr: 5541 }]);
    assert.equal(state.count, REQUESTS_PER_REFRESH);
    assert.equal(result.mirrors.length, 1, 'a deferred PR with no cached row yields no mirror row');
  });

  it('does not spend refresh budget on a locally-throttled PR', async () => {
    // 5543 is cached and inside the refresh floor, so a forced batch cannot
    // refetch it and it costs no request. Charging it a budget slot anyway would
    // defer 5541 — a PR that has no cached row at all — in favour of one that was
    // never going to be fetched. The budget bounds API calls, so only refs that
    // make one may spend it.
    const { mirror, state } = harness({ config: { ARF_GITHUB_REFRESH_BUDGET: '1' } });
    await mirror.get(FAKE_REPO, 5543);
    const before = state.count;

    const result = await mirror.getMany(
      [{ repo: FAKE_REPO, pr: 5543 }, { repo: FAKE_REPO, pr: 5541 }],
      { force: true },
    );

    assert.equal(result.throttled, 1, '5543 is inside the refresh floor');
    assert.equal(result.refreshed, 1, 'the budget went to 5541, which needed a fetch');
    assert.equal(result.deferred, 0, 'nothing was deferred: the only budgeted ref was refreshed');
    assert.equal(state.count, before + REQUESTS_PER_REFRESH, 'exactly one PR was fetched');
    assert.equal(result.mirrors.length, 2, 'both rows are served — one fresh, one cached');
    assert.equal(result.cacheHits, 1, 'the throttled row is a cache hit, not a refresh');
  });

  it('serves a batch entirely from cache on the second pass', async () => {
    const refs = [{ repo: FAKE_REPO, pr: 5543 }, { repo: FAKE_REPO, pr: 5541 }];
    const { mirror, state } = harness();
    await mirror.getMany(refs);
    const before = state.count;
    const second = await mirror.getMany(refs);
    assert.equal(second.cacheHits, 2);
    assert.equal(second.refreshed, 0);
    assert.equal(state.count, before);
  });

  it('serves a stale cached row over a transient failure, labelled as such', async () => {
    // A 500 is not a reason to blank a dashboard that has real (if older) data —
    // but the age and the error travel with it, so nothing reads as current.
    const { mirror, clock, config, store, env } = harness();
    await mirror.get(FAKE_REPO, 5543);

    clock.t += config.github.mirrorTtlMs + 1;
    const { fetchImpl } = fakeGithub({ fail: { status: 502, body: { message: 'bad gateway' } } });
    const failing = new GithubMirror({
      config,
      client: new GithubReadClient({ config, env, fetchImpl, now: () => clock.t }),
      store,
      env,
      now: () => clock.t,
    });
    const result = await failing.get(FAKE_REPO, 5543);
    assert.equal(result.mirror.title, '[claude-code] (feat) ARF-01: backend skeleton + review-state store adapter');
    assert.equal(result.mirror.stale, true);
    assert.match(result.refreshError.message, /502/);
  });

  it('propagates a transient failure when there is no cached row to fall back on', async () => {
    const { mirror } = harness({ fail: { status: 502, body: { message: 'bad gateway' } } });
    await assert.rejects(mirror.get(FAKE_REPO, 5543), ArfGithubError);
  });
});

describe('mirror fail-loud on a bad token', () => {
  it('raises rather than returning a placeholder when no token is configured', async () => {
    const { mirror, state } = harness({ env: { ARF_GITHUB_TOKEN: undefined } });
    await assert.rejects(
      mirror.get(FAKE_REPO, 5543),
      (err) => err instanceof ArfGithubAuthError && /not configured/.test(err.message),
    );
    assert.equal(state.count, 0, 'a missing token fails before any request is sent');
  });

  it('raises rather than returning a placeholder when the token is rejected', async () => {
    const { mirror } = harness({ fail: { status: 401, body: { message: 'Bad credentials' } } });
    await assert.rejects(mirror.get(FAKE_REPO, 5543), ArfGithubAuthError);
    // And there is no half-written cache row left behind to serve next time.
    assert.equal(mirror.cached(FAKE_REPO, 5543), null);
  });

  it('does not hide a broken identity behind a stale cached row', async () => {
    // A cached row inside the TTL is served without a request, which is correct.
    // But once a refresh is actually needed, an auth failure must surface — the
    // alternative is a dashboard that looks current for as long as nobody
    // notices the identity broke.
    const { mirror, clock, config, store, env } = harness();
    await mirror.get(FAKE_REPO, 5543);
    clock.t += config.github.mirrorTtlMs + 1;

    const { fetchImpl } = fakeGithub({ fail: { status: 401, body: { message: 'Bad credentials' } } });
    const broken = new GithubMirror({
      config,
      client: new GithubReadClient({ config, env, fetchImpl, now: () => clock.t }),
      store,
      env,
      now: () => clock.t,
    });
    await assert.rejects(broken.get(FAKE_REPO, 5543), ArfGithubAuthError);
  });

  it('aborts a batch on an auth failure instead of returning half-real rows', async () => {
    const { mirror } = harness({ fail: { status: 401, body: { message: 'Bad credentials' } } });
    await assert.rejects(
      mirror.getMany([{ repo: FAKE_REPO, pr: 5543 }, { repo: FAKE_REPO, pr: 5541 }]),
      ArfGithubAuthError,
    );
  });

  it('releases the body of a tolerated response instead of leaking the socket', async () => {
    // Branch protection answers 403 for any identity without repo admin, which is
    // the *expected* posture for a reviewer token — so this path runs on every
    // single refresh. A response whose body is neither read nor cancelled keeps
    // its connection open until GC, so "tolerated" would mean one leaked socket
    // per PR per refresh and, eventually, fd exhaustion.
    const { client, state } = harness({ protectionReadable: false });
    await client.fetchPullRequest(FAKE_REPO, 5543);

    const tolerated = state.bodies.filter((entry) => entry.status === 403);
    assert.equal(tolerated.length, 1, 'the protection read should have been tolerated, not thrown');
    assert.deepEqual(state.leakedBodies(), [], 'every response body must be read or cancelled');
  });

  it('releases response bodies on the success and error paths too', async () => {
    const { client, state } = harness();
    await client.fetchPullRequest(FAKE_REPO, 5543);
    assert.deepEqual(state.leakedBodies(), []);

    const failing = harness({ fail: { status: 500, body: { message: 'boom' } } });
    await assert.rejects(failing.client.fetchPullRequest(FAKE_REPO, 5543), ArfGithubError);
    assert.deepEqual(failing.state.leakedBodies(), []);
  });

  it('reads the token off the event loop rather than with a sync disk read', async () => {
    // The token is read per request by design, so the read must not be
    // synchronous: a batch refresh issues hundreds of them, and each blocking
    // read stalls the whole event loop — /healthz included.
    const dir = tmpDir();
    const path = join(dir, 'token');
    writeFileSync(path, 'ghs_fromfile\n');
    const config = loadConfig({ env: { ARF_STATE_ROOT: dir, ARF_GITHUB_TOKEN_FILE: path } });

    const pending = readGithubToken(config, { env: {} });
    assert.ok(pending instanceof Promise, 'readGithubToken must be async');
    assert.equal(await pending, 'ghs_fromfile');

    // The source guard: an `fs` sync read reintroduced here would pass every
    // behavioural assertion above while restoring the stall. Block comments are
    // stripped first, because the module's own docs explain why `readFileSync`
    // is not used and that prose must not read as a violation.
    const source = readFileSync(new URL('../src/github/token.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/readFileSync|\breadSync\b/.test(source), 'token.mjs must not read the token synchronously');
  });

  it('reports the token as absent in describe() without leaking a value', async () => {
    const { mirror } = harness({ env: { ARF_GITHUB_TOKEN: 'ghs_supersecret' } });
    await mirror.get(FAKE_REPO, 5543);
    const described = await mirror.describe();
    assert.equal(described.ready, true);
    assert.equal(described.token.ref, 'ARF_GITHUB_TOKEN');
    assert.equal(described.cache.rows, 1);
    assert.equal(described.cache.misses, 1);
    assert.ok(!JSON.stringify(described).includes('ghs_supersecret'));
  });
});

describe('mirror projection', () => {
  it('is exactly the shape the dashboard consumes', async () => {
    const { mirror } = harness();
    const { mirror: projection } = await mirror.get(FAKE_REPO, 5543);
    assert.deepEqual(Object.keys(projection).sort(), [...MIRROR_PROJECTION_FIELDS].sort());

    // The placeholder-killing fields specifically (SPEC AC#2).
    assert.equal(typeof projection.title, 'string');
    assert.equal(projection.builder, 'claude-code');
    assert.equal(projection.builderSource, 'title-prefix');
    assert.ok(Array.isArray(projection.labels));
    assert.equal(projection.headShaShort, 'aaaaaaa');
    assert.equal(typeof projection.checks.rollup, 'string');
    assert.ok(Array.isArray(projection.checks.entries));
    assert.ok(Array.isArray(projection.reviews));
    assert.equal(projection.ageMs, 0);
    assert.equal(projection.stale, false);
  });

  it('round-trips every field through the SQLite cache', async () => {
    const { mirror, config, store, env, clock } = harness();
    const fetched = (await mirror.get(FAKE_REPO, 5543)).mirror;

    // Read back through a brand-new store handle: the JSON columns must decode
    // into the same objects, or ARF-03 renders differently after a restart.
    const reread = new MirrorStore({ path: config.github.mirrorPath, reviewStorePath: config.storePath });
    const cached = new GithubMirror({ config, client: mirror.client, store: reread, env, now: () => clock.t })
      .cached(FAKE_REPO, 5543);
    assert.deepEqual(cached, fetched);
    assert.equal(store.describe().rows, 1);
  });

  it('marks a row stale once it is past the TTL', async () => {
    const { mirror, clock, config } = harness();
    await mirror.get(FAKE_REPO, 5543);
    clock.t += config.github.mirrorTtlMs + 5_000;
    const cached = mirror.cached(FAKE_REPO, 5543);
    assert.equal(cached.stale, true);
    assert.equal(cached.ageMs, config.github.mirrorTtlMs + 5_000);
  });

  it('projects a null record as null, not as an object of nulls', () => {
    // The one honest placeholder case: a PR with no mirror row yet. It must be
    // absent, not an object that renders as though it were data.
    assert.equal(projectMirror(null), null);
  });
});

describe('mirror / review-store join', () => {
  it('resolves a store PR row against its mirror row on PR number', async () => {
    const dir = tmpDir();
    const storePath = join(dir, 'reviews.db');
    copyFileSync(FIXTURE_PATH, storePath);
    const env = { ARF_STATE_ROOT: dir, ARF_MODE: MODE_IN_OS, ARF_STORE_PATH: storePath, ARF_GITHUB_TOKEN: 'ghs_t' };
    const config = loadConfig({ env });
    const { fetchImpl } = fakeGithub();
    const mirror = new GithubMirror({
      config,
      client: new GithubReadClient({ config, env, fetchImpl, now: () => START }),
      store: new MirrorStore({ path: config.github.mirrorPath, reviewStorePath: config.storePath }),
      env,
      now: () => START,
    });

    const { pullRequests } = new ReviewStore(config).pullRequests({ state: 'all' });
    assert.ok(pullRequests.length >= 3);

    const { mirrors } = await mirror.getMany(pullRequests.map((row) => ({ repo: row.repo, pr: row.pr })));
    const joined = joinPullRequests(pullRequests, mirrors);

    const pr5543 = joined.find((row) => row.pr === 5543);
    // Review state from reviews.db, PR identity from the mirror — the join the
    // whole ticket exists for.
    assert.equal(pr5543.reviewStatus, 'posted');
    assert.equal(pr5543.latestVerdict, null);
    assert.equal(pr5543.mirror.title, '[claude-code] (feat) ARF-01: backend skeleton + review-state store adapter');
    assert.equal(pr5543.mirror.builder, 'claude-code');
    assert.equal(pr5543.mirror.checks.rollup, 'pending');

    const pr5541 = joined.find((row) => row.pr === 5541);
    assert.equal(pr5541.mergedAt, '2026-08-15T11:30:00Z');
    assert.equal(pr5541.mirror.builder, 'codex');
    assert.equal(pr5541.mirror.merged, true);

    // 5539 exists in reviews.db but not on the fake GitHub: the honest
    // no-mirror-row-yet case, which is null rather than a fabricated row.
    const pr5539 = joined.find((row) => row.pr === 5539);
    assert.equal(pr5539.mirror, null);

    // The store rows themselves still carry no invented PR identity (ARF-01).
    for (const row of pullRequests) {
      assert.ok(!('title' in row), 'the store adapter must not invent a title');
      assert.ok(!('builder' in row), 'the store adapter must not invent a builder');
    }
  });

  it('refuses to guess when a bare PR number names two repos', () => {
    // PR numbers are repository-local. Answering with either row would splice a
    // stranger's title onto a review timeline.
    const index = mirrorIndex([
      { repo: 'org/one', pr: 42, title: 'one' },
      { repo: 'org/two', pr: 42, title: 'two' },
      { repo: 'org/one', pr: 7, title: 'seven' },
    ]);
    assert.equal(index.lookup('org/one', 42).title, 'one');
    assert.equal(index.lookup('org/two', 42).title, 'two');
    assert.equal(index.lookup(null, 42), null);
    assert.equal(index.ambiguous(42), true);
    assert.equal(index.lookup(null, 7).title, 'seven');
    assert.equal(index.ambiguous(7), false);
  });

  it('joins case-insensitively, as GitHub treats repo names', () => {
    const joined = joinPullRequests(
      [{ repo: 'Org/Repo', pr: 5 }],
      [{ repo: 'org/repo', pr: 5, title: 'matched' }],
    );
    assert.equal(joined[0].mirror.title, 'matched');
  });
});

describe('mirror store boundary', () => {
  it('refuses a config whose mirror path is the review store', () => {
    const dir = tmpDir();
    const storePath = join(dir, 'reviews.db');
    assert.throws(() => loadConfig({
      env: {
        ARF_STATE_ROOT: dir,
        ARF_MODE: MODE_IN_OS,
        ARF_STORE_PATH: storePath,
        ARF_GITHUB_MIRROR_PATH: storePath,
      },
    }), /must not be the review store/);
  });

  it('refuses a writable mirror handle on the review store even if config is bypassed', () => {
    const dir = tmpDir();
    const storePath = join(dir, 'reviews.db');
    copyFileSync(FIXTURE_PATH, storePath);
    const store = new MirrorStore({ path: storePath, reviewStorePath: storePath });
    // Stated twice on purpose: the invariant survives an edit to either side.
    assert.throws(() => store.upsert({ repo: 'a/b', pr: 1, fetchedAt: 'x', fetchedAtMs: 0 }), /never writes/);
  });

  it('sets a busy timeout on every mirror handle', () => {
    // The mirror is a standalone SQLite file, so an operator inspecting it with
    // the `sqlite3` CLI is a second process on the same database. Without the
    // pragma an ARF write landing during that read throws SQLITE_BUSY instantly
    // and fails the refresh; with it, the write waits the inspection out.
    const dir = tmpDir();
    const path = join(dir, 'mirror.db');
    const db = openWritableMirror(path, { busyTimeoutMs: 4321 });
    try {
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 4321);
    } finally {
      closeQuietly(db);
    }

    // And the store's own handles carry the configured value, not just a
    // direct call's — the wiring is the half that would rot silently.
    const store = new MirrorStore({ path: join(dir, 'store.db'), busyTimeoutMs: 7654 });
    store.upsert({ repo: 'a/b', pr: 1, fetchedAt: 'x', fetchedAtMs: 0 });
    const wired = openWritableMirror(join(dir, 'store.db'), { busyTimeoutMs: store.busyTimeoutMs });
    try {
      assert.equal(wired.prepare('PRAGMA busy_timeout').get().timeout, 7654);
    } finally {
      closeQuietly(wired);
    }
  });

  it('takes the busy timeout from the same config knob the review store reads', () => {
    const { config, store } = harness({ config: { ARF_STORE_BUSY_TIMEOUT_MS: '5500' } });
    assert.equal(config.busyTimeoutMs, 5500);
    assert.equal(store.busyTimeoutMs, 5500);
  });

  it('does not create the cache file until GitHub is actually used', async () => {
    // Provisioning is lazy so an ARF that never talks to GitHub leaves no file,
    // and a Node without node:sqlite fails at the first mirror call rather than
    // turning every boot into a crash.
    const { config, store, mirror } = harness();
    assert.equal(store.provisioned, false);
    assert.equal(existsSync(config.github.mirrorPath), false);

    await mirror.get(FAKE_REPO, 5543);
    assert.equal(existsSync(config.github.mirrorPath), true);
    assert.equal(store.describe().rows, 1);
  });

  it('keys the cache case-insensitively, primary key included', async () => {
    // GitHub repo names are case-insensitive. If only the lookups folded case
    // and the primary key did not, a store row spelled `Org/Repo` would create a
    // second row for the same PR and reads would return an arbitrary one.
    const { mirror, store, state } = harness();
    await mirror.get(FAKE_REPO, 5543);
    const shouted = await mirror.get(FAKE_REPO.toUpperCase(), 5543);
    assert.equal(shouted.cacheHit, true);
    assert.equal(state.count, REQUESTS_PER_REFRESH);
    assert.equal(store.describe().rows, 1, 'one PR is one row, whatever the spelling');
  });

  it('serves a strict cache read without any possibility of a fetch', async () => {
    // `allowFetch: false` is what a batch call uses once its refresh budget is
    // spent; it must be inert even for a PR that has never been mirrored.
    const { mirror, state } = harness();
    const cold = await mirror.get(FAKE_REPO, 5543, { allowFetch: false });
    assert.equal(cold.mirror, null);
    assert.equal(cold.deferred, true);
    assert.equal(state.count, 0);
  });
});
