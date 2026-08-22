/**
 * A fake GitHub API for the ARF-02 tests.
 *
 * It exists to make three things assertable that a real API cannot:
 *
 *   1. **Exactly how many requests were sent.** The cache tests are about
 *      request counts, not about response contents — "a cache hit avoids a
 *      second fetch" is only a real assertion if the fetches are counted.
 *   2. **Auth failures on demand**, so the fail-loud path is exercised without
 *      anyone holding a deliberately-broken token.
 *   3. **A PR set that lines up with `reviews.db`.** The two PRs here are 5543
 *      and 5541 — the same numbers `build-reviews-fixture.mjs` writes into the
 *      review store — so the join test joins two independently-built fixtures
 *      rather than one fixture against itself.
 */

const REPO = 'laceyenterprises/agent-os';

/** PR 5543: open, review in flight, a required check still running. */
const PR_5543 = {
  number: 5543,
  title: '[claude-code] (feat) ARF-01: backend skeleton + review-state store adapter',
  state: 'open',
  draft: false,
  merged: false,
  // GitHub answers `null` while it computes the test merge commit. The
  // projection must carry that through as unknown rather than as "conflicted".
  mergeable: null,
  mergeable_state: 'blocked',
  html_url: `https://github.com/${REPO}/pull/5543`,
  user: { login: 'agent-os-builder[bot]', type: 'Bot' },
  head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  base: { ref: 'main' },
  labels: [{ name: 'adversarial-review' }, { name: 'agent-built' }],
};

/** PR 5541: merged, everything green. */
const PR_5541 = {
  number: 5541,
  title: '[codex] ROS-02 send-turn + reply stream',
  state: 'closed',
  draft: false,
  merged: true,
  mergeable: null,
  mergeable_state: 'clean',
  html_url: `https://github.com/${REPO}/pull/5541`,
  user: { login: 'agent-os-codex[bot]', type: 'Bot' },
  head: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  base: { ref: 'main' },
  labels: [],
};

const REVIEWS = {
  5543: [
    {
      id: 900001,
      user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-08-16T10:20:00Z',
      body: '## Verdict\n\nRequest changes.\n\n## Blocking issues\n\n- **Store adapter opens a writable handle**\n',
      html_url: `https://github.com/${REPO}/pull/5543#pullrequestreview-900001`,
    },
    {
      id: 900002,
      user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
      state: 'COMMENTED',
      submitted_at: '2026-08-16T11:10:00Z',
      body: '## Verdict\n\nComment only.\n',
      html_url: `https://github.com/${REPO}/pull/5543#pullrequestreview-900002`,
    },
  ],
  5541: [
    {
      id: 900003,
      user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
      state: 'APPROVED',
      submitted_at: '2026-08-15T09:50:00Z',
      body: '## Verdict\n\nApproved.\n',
      html_url: `https://github.com/${REPO}/pull/5541#pullrequestreview-900003`,
    },
  ],
};

const CHECK_RUNS = {
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: [
    {
      name: 'repo-guards',
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-08-16T10:15:00Z',
      html_url: 'https://github.com/checks/1',
    },
    {
      name: 'tests',
      status: 'in_progress',
      conclusion: null,
      completed_at: null,
      html_url: 'https://github.com/checks/2',
    },
    {
      // Not a required context: it must be reported but must not gate.
      name: 'optional-lint',
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-08-16T10:12:00Z',
      html_url: 'https://github.com/checks/3',
    },
  ],
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: [
    {
      name: 'repo-guards',
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-08-15T09:40:00Z',
      html_url: 'https://github.com/checks/4',
    },
  ],
};

const COMMIT_STATUSES = {
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: [
    { context: 'legacy/ci', state: 'success', target_url: 'https://ci/1', updated_at: '2026-08-16T10:10:00Z' },
  ],
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: [
    { context: 'tests', state: 'success', target_url: 'https://ci/2', updated_at: '2026-08-15T09:45:00Z' },
  ],
};

const REQUIRED_CONTEXTS = ['repo-guards', 'tests'];

export const FAKE_REPO = REPO;
export const FAKE_PRS = { 5543: PR_5543, 5541: PR_5541 };

function json(status, body, headers = {}) {
  const payload = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: new Headers({
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1786000000',
      ...headers,
    }),
    async json() {
      return JSON.parse(payload);
    },
    async text() {
      return payload;
    },
  };
}

const API_BASE = 'https://api.github.com';

/**
 * Serve `rows` the way GitHub does: `per_page`-sized pages joined by `Link`
 * headers, rather than one oversized body. Without this the pagination fix is
 * untestable — a fake that always answers in full can never prove the client
 * follows a `next` link, which is exactly how the truncation shipped.
 *
 * @param {object[]} rows every row, across all pages
 * @param {URL} url the request URL, carrying `page` / `per_page`
 * @param {(page: object[]) => object} envelope wrap a page the way the endpoint does
 */
function paged(rows, url, envelope = (page) => page) {
  const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const start = (page - 1) * perPage;
  const slice = rows.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < rows.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    // Two entries, `next` second, so the parser has to actually read `rel`.
    headers.link = `<${url.toString()}>; rel="prev", <${next.toString()}>; rel="next"`;
  }
  return json(200, envelope(slice), headers);
}

/**
 * Build a fake `fetch` plus the counters the cache assertions read.
 *
 * @param {object} [options]
 * @param {{status: number, body?: object, headers?: object}} [options.fail]
 *   force every request to fail this way (the auth / rate-limit paths).
 * @param {boolean} [options.protectionReadable] when false, branch protection
 *   answers 403 — the realistic case for a non-admin reviewer identity.
 * @param {{reviews?: object[], checkRuns?: object[], statuses?: object[]}} [options.bulk]
 *   override a collection with an arbitrarily long list, to exercise pagination.
 * @param {string|null} [options.linkOverride] answer every paginated endpoint with
 *   this literal `Link` header, for the off-origin refusal test.
 */
export function fakeGithub({
  fail = null,
  protectionReadable = true,
  bulk = {},
  linkOverride = null,
} = {}) {
  const state = {
    count: 0,
    calls: [],
    byPath: new Map(),
    /** One entry per response handed out, recording whether its body was released. */
    bodies: [],
    /**
     * Responses whose body was never read or cancelled — i.e. sockets a real
     * `undici` would still be holding open. The assertion behind the leak test.
     */
    leakedBodies() {
      return state.bodies.filter((entry) => !entry.released);
    },
  };

  /**
   * Wrap a response so the fixture can tell whether the client released its body.
   *
   * A real `fetch` response holds its connection until the body is consumed or
   * cancelled; a plain object fake has no such coupling, so a client that drops
   * the response entirely looks identical to one that drains it. Recording the
   * release here is what makes "the socket was freed" assertable at all.
   */
  const track = (res) => {
    const entry = { path: res.__path ?? null, status: res.status, released: false };
    state.bodies.push(entry);
    const release = () => { entry.released = true; };
    return {
      ...res,
      body: { cancel: async () => { release(); } },
      async json() { release(); return res.json(); },
      async text() { release(); return res.text(); },
      async arrayBuffer() {
        release();
        return new TextEncoder().encode(await res.text()).buffer;
      },
    };
  };

  const route = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (fail) return json(fail.status, fail.body ?? { message: 'forced failure' }, fail.headers);

    let match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (match) {
      const pr = FAKE_PRS[match[2]];
      return pr ? json(200, pr) : json(404, { message: 'Not Found' });
    }

    // An unconditional Link header: used to prove the client refuses to carry its
    // bearer token to an origin a response header picked, and to drive the
    // maxPages bound without materializing thousands of rows.
    const withOverride = (body) => (
      linkOverride === null ? null : json(200, body, { link: linkOverride })
    );

    match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(path);
    if (match) {
      const rows = bulk.reviews ?? REVIEWS[match[2]] ?? [];
      return withOverride(rows) ?? paged(rows, parsed);
    }

    match = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (match) {
      const rows = bulk.checkRuns ?? CHECK_RUNS[match[2]] ?? [];
      const envelope = (page) => ({ total_count: rows.length, check_runs: page });
      return withOverride(envelope(rows)) ?? paged(rows, parsed, envelope);
    }

    match = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/status$/.exec(path);
    if (match) {
      const rows = bulk.statuses ?? COMMIT_STATUSES[match[2]] ?? [];
      const envelope = (page) => ({ state: 'success', statuses: page });
      return withOverride(envelope(rows)) ?? paged(rows, parsed, envelope);
    }

    if (/\/protection\/required_status_checks$/.test(path)) {
      return protectionReadable
        ? json(200, { contexts: REQUIRED_CONTEXTS })
        : json(403, { message: 'Must have admin rights to Repository.' });
    }

    return json(404, { message: `unrouted ${path}` });
  };

  const fetchImpl = async (url, init) => {
    state.count += 1;
    const parsed = new URL(url);
    const path = parsed.pathname;
    state.calls.push({
      path,
      url: String(url),
      page: parsed.searchParams.get('page'),
      method: init?.method,
      authorization: init?.headers?.authorization,
    });
    state.byPath.set(path, (state.byPath.get(path) ?? 0) + 1);
    const res = await route(url, init);
    return track({ ...res, __path: path });
  };

  return { fetchImpl, state };
}

export const FAKE_API_BASE = API_BASE;

/**
 * How many requests one full mirror refresh costs for the fixture PRs: pr,
 * reviews, checks, statuses, protection — one page each, because none of the
 * fixture collections exceeds `per_page`. A PR that does costs one more request
 * per extra page, which is what the pagination tests assert.
 */
export const REQUESTS_PER_REFRESH = 5;
