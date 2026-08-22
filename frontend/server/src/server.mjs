/**
 * ARF backend HTTP surface (ARF-01 skeleton, extended by ARF-02, ARF-04, ARF-05, and ARF-06).
 *
 * Dependency-light on purpose: `node:http` and nothing else. `frontend` imports
 * no agent-os runtime library (SPEC §9) — no session-ledger, no broker client,
 * no `hq`, nothing from `modules/`, `platform/`, or `runtime/`. A guard test
 * enforces that mechanically.
 *
 * Routes:
 *
 *   GET  /healthz                          process liveness + an honest store descriptor
 *   GET  /version                          build identity + API contract version
 *   GET  /github/status                    mirror readiness: token *source*, cache counters,
 *                                          rate limit. Never a token value. (ARF-02)
 *   GET  /github/mirror                    one PR's mirror, refreshed per the cache policy (ARF-02)
 *   GET  /pipeline/health                  daemon liveness, MSM merge-path arm state, both
 *                                          kill-switch keys, review-cycle burndown (ARF-04)
 *   GET  /pipeline/panel                   the same payload rendered as Screen B (ARF-04)
 *   GET  /v1/standup/identity/steps        the step list, before any run exists
 *   GET  /v1/standup/identity/roles        broker mappings joined with recorded runs
 *   GET  /v1/standup/identity/runs/<role>  the last recorded run for a role
 *   POST /v1/standup/identity/runs         run a standup, streamed as SSE
 *   GET  /v1/governance/gate               the arm/disarm gate + what each merge
 *                                          path is told right now (ARF-08)
 *   POST /v1/governance/gate/{init,arm,disarm}
 *                                          flip the gate — loopback + JSON only
 *   GET  /api/standup/harness              registered harnesses + reviewer allowlist
 *   GET  /api/standup/harness/catalog      harness templates the panel prefills from
 *   POST /api/standup/harness/runs         run the harness wizard (SSE or JSON)
 *   GET  /ui/…                             the harness panel
 *   GET  /  and static assets              the identity SPA (Screen C lives here today)
 *
 * The dashboard read surfaces (`ar-read`) land in ARF-03/04 on top of the
 * store adapter and the mirror this module wires up.
 *
 * `/healthz` returns 200 even when the review store is absent. Store
 * availability is reported inside the body, not as process health: a standalone
 * install with no pipeline is a healthy ARF with an empty store, and conflating
 * the two would make a supervisor restart-loop a fresh install.
 *
 * `/github/mirror` does the opposite, and deliberately so. A store with no rows
 * is a normal state; a *misconfigured GitHub identity* is not, and it must not
 * be reachable-looking. A missing, unresolved, or rejected token is a 503 with
 * the reason, never a 200 carrying a placeholder-shaped body.
 */

import { createServer } from 'node:http';

// The SSE wire format is shared with the browser, so it lives where both ends can
// reach it: the server imports it here, and the same file is served to the panel
// as `/shared/sse-wire.mjs`. One framer, one parser, no drift.
import { SSE_HEADERS, formatSse, sseComment } from '../../frontend/shared/sse-wire.mjs';
import { renderScreenBPage } from '../../frontend/src/screen-b/panel.mjs';
import { openTokenBroker } from './broker/index.mjs';
import { loadConfig } from './config.mjs';
import { GithubReadClient } from './github/client.mjs';
import { ArfGithubError } from './github/errors.mjs';
import { GithubMirror } from './github/mirror.mjs';
import { GATE_ROUTE, gateWriteAction, handleGateRead, handleGateWrite } from './governance/gate-api.mjs';
import { openGateStore } from './governance/gate-store.mjs';
import { buildPipelineHealth } from './governance/index.mjs';
import { MirrorStore } from './store/mirror-store.mjs';
import { openReviewStore } from './store/review-store.mjs';
import { createHarnessStandup } from './standup/harness-wizard.mjs';
import { runIdentityStandup } from './standup/identity-run.mjs';
import { StandupParamsError, errorCode } from './standup/errors.mjs';
import { normalizeStandupParams } from './standup/params.mjs';
import { openStandupRunStore } from './standup/run-store.mjs';
import { handleStandupRequest } from './standup/routes.mjs';
import { IDENTITY_STEPS, STEP_STATUSES } from './standup/steps.mjs';
import { serveStatic } from './static.mjs';
import { handleUiRequest } from './ui.mjs';
import { versionInfo } from './version.mjs';

/** A standup request is a handful of refs and coordinates; nothing legitimate is bigger. */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Whether anything may still be written to this response.
 *
 * A client that closed the tab, or a socket ARF itself tore down, leaves a
 * response object that is still in scope and still looks writable to code that
 * only checks `writableEnded`. Every write on this surface goes through a check
 * that includes `destroyed`, because a write against a dead socket surfaces as an
 * error nobody is positioned to catch — and on the SSE path, one that escapes into
 * a promise and takes the daemon with it.
 */
function isWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

function sendJson(res, status, body) {
  if (!isWritable(res)) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    // A governance panel must never be served from a cache. An operator reading
    // a 30-second-old "stopped" out of a proxy is the failure mode this whole
    // ticket is about.
    'cache-control': 'no-store',
  });
  res.end(html);
}

/**
 * HTTP status for a GitHub-side failure.
 *
 * An auth failure is 503, not 200-with-empty and not 404: ARF is configured
 * wrongly and cannot answer, which is a different thing from "this PR has no
 * mirror". A caller that gets 503 knows to go and look; a caller that got an
 * empty 200 would not.
 */
function githubStatus(err) {
  switch (err.code) {
    case 'bad_request': return 400;
    case 'github_not_found': return 404;
    case 'github_rate_limited': return 429;
    case 'github_auth': return 503;
    default: return 502;
  }
}

/** `GET /github/mirror?repo=owner/name&pr=123[&refresh=1]`. */
async function handleMirror(ctx, url, res) {
  const repo = url.searchParams.get('repo');
  const pr = url.searchParams.get('pr');
  if (!repo || !pr) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'both repo (owner/name) and pr are required query parameters',
    });
    return;
  }
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') ?? '').toLowerCase());
  try {
    const result = await ctx.mirror.get(repo, pr, { force: refresh });
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ArfGithubError) {
      sendJson(res, githubStatus(err), { error: err.code, detail: err.message });
      return;
    }
    throw err;
  }
}

/**
 * The last stop for a failure on an asynchronous route.
 *
 * A body ARF refused is the caller's fault and gets a `400`; anything else is
 * ARF's and gets a `500`. A response that already committed its headers is closed
 * rather than written to — on the SSE path the terminal `failed` frame has
 * already been attempted, and a JSON error body appended to an event stream would
 * be unparseable at both ends.
 */
function failRequest(res, err) {
  if (!isWritable(res)) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, err instanceof StandupParamsError ? 400 : 500, {
    error: errorCode(err),
    detail: String(err?.message ?? err),
  });
}

/**
 * Read a JSON request body, refusing anything oversized *while* reading.
 *
 * The cap is enforced per chunk rather than on the assembled buffer, for the
 * same reason `readCappedBody` streams an upstream response: checking afterwards
 * means the allocation already happened, and a single unauthenticated POST could
 * then decide how much memory the daemon uses.
 *
 * An oversized body is *paused*, not destroyed. Destroying the request takes the
 * socket — and therefore the response — with it, so the `400` explaining the
 * refusal would never arrive, and the write that tried to send it would land on a
 * dead socket. Pausing stops the read immediately, which is the part that matters,
 * and leaves the response able to say why.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.pause();
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        fail(new StandupParamsError(`request body exceeds ${MAX_REQUEST_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        settled = true;
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        fail(new StandupParamsError(`request body is not valid JSON: ${err.message}`));
        return;
      }
      settled = true;
      resolve(parsed);
    });
  });
}

/** The step list, as the panel renders it before a run exists. */
function stepCatalog() {
  return {
    statuses: STEP_STATUSES,
    steps: IDENTITY_STEPS.map((step, index) => ({
      id: step.id,
      label: step.label,
      index,
      total: IDENTITY_STEPS.length,
      // Surfaced because it changes what a resume means for that step, and the
      // panel says so rather than leaving a re-run's behaviour unexplained.
      alwaysRun: step.alwaysRun === true,
    })),
  };
}

/**
 * Broker mappings joined with recorded runs.
 *
 * The join is the useful part: "which roles does the broker know about" and
 * "which roles has a standup been attempted for" are different sets, and the gap
 * between them is exactly what an operator opening Screen C wants to see.
 */
function roleCatalog(ctx) {
  const broker = ctx.brokerDescribe();
  const runs = new Map(ctx.runStore.list().map((record) => [record.role, record]));
  const roles = new Map();

  for (const entry of broker.roles) {
    roles.set(entry.role, { role: entry.role, mapped: true, mapping: entry, run: null });
  }
  for (const [role, record] of runs) {
    const existing = roles.get(role) ?? { role, mapped: false, mapping: null, run: null };
    existing.run = {
      runId: record.runId,
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      steps: Object.fromEntries(
        Object.entries(record.steps).map(([id, state]) => [id, state.status]),
      ),
    };
    roles.set(role, existing);
  }

  return {
    broker: {
      mode: broker.mode,
      configured: broker.configured,
      endpoint: broker.endpoint,
      rolesFile: broker.rolesFile,
      // An absent manifest is a legitimate pre-first-standup state, so the two
      // are reported separately: "ARF will create this" and "ARF is reading this"
      // are different situations to be looking at.
      rolesFileExists: broker.rolesFileExists,
      // Whether ARF has anywhere to record a new mapping. Without it, standing up
      // an unmapped role can only ever fail at the wire step, and the panel says
      // so before the operator spends four steps finding out.
      canWriteMappings: Boolean(broker.rolesFile),
    },
    roles: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)),
  };
}

/** Stream a standup run as SSE. */
async function streamStandup(ctx, req, res, body) {
  let params;
  try {
    params = normalizeStandupParams(body);
  } catch (err) {
    // Refused before a run exists, so nothing is recorded and no step reports a
    // status. This is also where a raw secret pasted into a `*Ref` field stops.
    sendJson(res, 400, { error: errorCode(err), detail: String(err?.message ?? err) });
    return;
  }

  // The client can already be gone — a body that took a moment to read is long
  // enough for a tab to close — and committing headers to a dead socket is an
  // error raised inside a promise with nobody left to receive the stream anyway.
  if (!isWritable(res)) return;

  res.writeHead(200, SSE_HEADERS);
  // First byte immediately: commits the headers and gets the panel to "connected"
  // without waiting on whatever the first step has to talk to.
  res.write(sseComment(`arf identity standup ${params.role}`));

  const controller = new AbortController();
  // The operator closing the tab is a cancellation, not a failure to ignore: the
  // run stops between steps and the record keeps whatever prefix completed.
  const onClose = () => controller.abort();
  res.on('close', onClose);

  let id = 0;
  try {
    const events = runIdentityStandup(params, {
      config: ctx.config,
      reloadConfig: ctx.reloadConfig,
      runStore: ctx.runStore,
      signal: controller.signal,
    });
    for await (const event of events) {
      id += 1;
      if (!isWritable(res)) break;
      res.write(formatSse(event.event, event.data, { id }));
    }
  } catch (err) {
    // The machine yields a terminal frame for every failure it anticipates, so
    // reaching here means something unanticipated broke. It still gets a terminal
    // frame: a stream that just stops is indistinguishable from a dropped
    // connection, and the panel would spin forever. Unless the socket is already
    // gone — then there is nobody to tell, and the attempt is just a second error
    // raised while handling the first.
    if (isWritable(res)) {
      res.write(formatSse('failed', {
        role: params.role,
        status: 'failed',
        code: errorCode(err),
        message: String(err?.message ?? err),
        resumable: false,
      }, { id: id + 1 }));
    }
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * Route one request. Exported so tests can exercise the routing table without
 * binding a socket.
 *
 * @param {{store: import('./store/review-store.mjs').ReviewStore,
 *          mirror: import('./github/mirror.mjs').GithubMirror,
 *          runStore: ReturnType<import('./standup/run-store.mjs').openStandupRunStore>,
 *          gateStore: import('./governance/gate-store.mjs').GateStore,
 *          standup: object, config: object, reloadConfig: Function, brokerDescribe: Function,
 *          startedAt: number}} ctx
 */
export async function handleRequest(ctx, req, res) {
  const method = String(req.method ?? 'GET').toUpperCase();
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://arf.invalid');
  } catch {
    sendJson(res, 400, { error: 'bad_request', detail: 'unparseable request URL' });
    return;
  }
  const pathname = url.pathname;

  // The harness surface owns a write route too, and `/ui/` has its own method
  // answers. Route both before the identity/read-only guard below so their
  // contract stays local to the ARF-06 modules.
  if (await handleStandupRequest(ctx, req, res, { pathname, method })) return;
  if (await handleUiRequest(req, res, { pathname, method })) return;

  if (method === 'POST') {
    // The harness runner owns its write route above, with its module-local rules.
    // The remaining write routes here are the identity standup runner and the
    // arm/disarm gate. Everything else stays read-only, so the 405 the rest of the
    // surface returns is still the honest answer for it. Merge *execution* is not
    // here and never will be (SPEC §5) — the gate says whether the pipeline may
    // merge; the pipeline still does the merging.
    const gateAction = gateWriteAction(pathname);
    if (gateAction) {
      readJsonBody(req)
        .then((body) => {
          const { status, body: payload } = handleGateWrite(ctx, gateAction, body, req);
          sendJson(res, status, payload);
        })
        .catch((err) => failRequest(res, err));
      return;
    }
    if (pathname === '/v1/standup/identity/runs') {
      // One terminal `.catch()` for the whole chain, and it is load-bearing rather
      // than defensive habit: `handleRequest` returns before the stream finishes,
      // so nothing above this frame is left to catch anything. A rejection that
      // escaped here would be an unhandled rejection, and an unhandled rejection
      // takes the daemon down — the entire ARF process, for one dropped client.
      readJsonBody(req)
        .then((body) => streamStandup(ctx, req, res, body))
        .catch((err) => failRequest(res, err));
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed', detail: `POST is not supported for ${pathname}` });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed', detail: `${method} is not supported` });
    return;
  }

  if (pathname === '/github/status') {
    // 200 even when the token is missing: this route's job is to *report* that,
    // and a status endpoint that fails when the thing it describes is broken is
    // useless exactly when it is needed. The refusal lives in the payload's
    // `token.present` / `token.reason`, and `/github/mirror` is what refuses.
    sendJson(res, 200, await ctx.mirror.describe());
    return;
  }

  if (pathname === '/github/mirror') {
    await handleMirror(ctx, url, res);
    return;
  }

  if (pathname === '/pipeline/health' || pathname === '/pipeline/panel') {
    // Always 200, and always recomputed. Both halves matter:
    //
    // - 200 because a missing governance config or a silent daemon IS the
    //   answer this route exists to deliver. A 503 would make the panel go dark
    //   exactly when an operator is trying to find out whether merges stopped.
    // - recomputed because config files and heartbeats change under a
    //   long-lived ARF, and a cached stop-state is a stop-state that was true
    //   once. Every input here is a small stat/read; none of it scales with the
    //   number of PRs.
    const health = buildPipelineHealth({ config: ctx.config, store: ctx.store });
    if (pathname === '/pipeline/panel') {
      sendHtml(res, 200, renderScreenBPage(health));
    } else {
      sendJson(res, 200, health);
    }
    return;
  }

  if (pathname === '/healthz') {
    // describe() re-checks the store on every call rather than caching at boot:
    // in `in-os` mode the pipeline's reviews.db can appear or disappear under a
    // long-lived ARF, and a cached "available" would be a lie the moment it did.
    sendJson(res, 200, {
      status: 'ok',
      uptimeMs: Math.max(0, Math.round(performance.now() - ctx.startedAt)),
      store: ctx.store.describe(),
      broker: { mode: ctx.config.broker.mode, configured: ctx.config.broker.configured },
    });
    return;
  }

  if (pathname === '/version') {
    sendJson(res, 200, versionInfo());
    return;
  }

  if (pathname === GATE_ROUTE) {
    const { status, body } = handleGateRead(ctx, url);
    sendJson(res, status, body);
    return;
  }

  if (pathname === '/v1/standup/identity/steps') {
    sendJson(res, 200, stepCatalog());
    return;
  }

  if (pathname === '/v1/standup/identity/roles') {
    sendJson(res, 200, roleCatalog(ctx));
    return;
  }

  if (pathname.startsWith('/v1/standup/identity/runs/')) {
    const role = decodeURIComponent(pathname.slice('/v1/standup/identity/runs/'.length));
    let record = null;
    try {
      record = ctx.runStore.read(role);
    } catch (err) {
      // An invalid role name is a bad request, not a missing record: telling the
      // caller "no run" for a name that could never have one is a misleading 404.
      sendJson(res, 400, { error: errorCode(err), detail: String(err?.message ?? err) });
      return;
    }
    if (!record) {
      sendJson(res, 404, { error: 'not_found', detail: `no recorded standup run for role ${role}` });
      return;
    }
    sendJson(res, 200, record);
    return;
  }

  if (pathname === '/v1/reviews/prs') {
    const state = url.searchParams.get('state') ?? 'open';
    const limitParam = url.searchParams.get('limit');
    let limit;
    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) {
        sendJson(res, 400, { error: 'bad_request', detail: 'limit must be a positive integer' });
        return;
      }
      limit = Number.parseInt(limitParam, 10);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        sendJson(res, 400, { error: 'bad_request', detail: 'limit must be a positive integer' });
        return;
      }
    }

    const result = ctx.store.pullRequests({ state, limit });
    const refs = result.pullRequests.map((pr) => ({ repo: pr.repo, pr: pr.pr }));

    let mirrorRes;
    try {
      mirrorRes = await ctx.mirror.getMany(refs);
    } catch (err) {
      // Fallback for fail-loud auth errors
      mirrorRes = {
        index: { lookup: () => null },
        refreshed: 0, cacheHits: 0, throttled: 0, deferred: refs.length,
        errors: [{ key: 'all', code: err.code || 'github_error', message: err.message }]
      };
    }

    const pullRequests = result.pullRequests.map((pr) => ({
      ...pr,
      mirror: mirrorRes.index.lookup(pr.repo, pr.pr),
    }));

    sendJson(res, 200, {
      store: result.store,
      pullRequests,
      mirrorStats: {
        refreshed: mirrorRes.refreshed,
        cacheHits: mirrorRes.cacheHits,
        throttled: mirrorRes.throttled,
        deferred: mirrorRes.deferred,
        errors: mirrorRes.errors,
      },
    });
    return;
  }

  if (pathname.startsWith('/v1/reviews/prs/')) {
    const remaining = pathname.slice('/v1/reviews/prs/'.length);
    let repo, prNumberStr;
    const parts = remaining.split('/');
    let decodedParts;
    try {
      decodedParts = parts.map((part) => decodeURIComponent(part));
    } catch {
      sendJson(res, 400, { error: 'bad_request', detail: 'Malformed PR path encoding' });
      return;
    }

    if (parts.length === 3) {
      repo = `${decodedParts[0]}/${decodedParts[1]}`;
      prNumberStr = decodedParts[2];
    } else if (parts.length === 2) {
      repo = decodedParts[0];
      prNumberStr = decodedParts[1];
    } else {
      sendJson(res, 400, { error: 'bad_request', detail: 'Invalid PR path format. Expected /v1/reviews/prs/owner/repo/number' });
      return;
    }

    const prNumber = parseInt(prNumberStr, 10);
    if (!Number.isNaN(prNumber)) {
      const result = ctx.store.pullRequest({ repo, prNumber });
      let payload = result;
      if (result.pullRequest) {
        const mirrorRes = await ctx.mirror.get(repo, prNumber).catch(() => ({ mirror: null }));
        payload = {
          ...result,
          pullRequest: {
            ...result.pullRequest,
            mirror: mirrorRes.mirror ?? null,
          },
        };
      }
      sendJson(res, 200, payload);
      return;
    }

    sendJson(res, 400, { error: 'bad_request', detail: 'Invalid PR number' });
    return;
  }

  // The SPA is last: it owns `/` and its own assets, and a static file must never
  // be able to shadow an API route. The read is asynchronous — see `static.mjs` —
  // so the 404 for "not an asset either" moves into the chain, and the chain gets
  // the same terminal `.catch()` the SSE route does, for the same reason.
  serveStatic(pathname, res, { head: method === 'HEAD' })
    .then((handled) => {
      if (handled) return;
      sendJson(res, 404, { error: 'not_found', detail: `no route for ${pathname}` });
    })
    .catch((err) => failRequest(res, err));
}

/**
 * Build the ARF server without listening.
 *
 * `env` and `fetchImpl` are injectable so tests can drive the GitHub surface
 * against a counting fake without a network or a real token. Production passes
 * neither and gets `process.env` + the global `fetch`.
 *
 * @param {object} [options]
 * @param {ReturnType<import('./config.mjs').loadConfig>} [options.config]
 * @param {Function} [options.reloadConfig] re-read config from disk. The standup
 *   wizard uses it after writing a role mapping, so the broker it verifies
 *   against is built the way a restarted ARF would build it. Injectable because a
 *   server booted from a custom env must reload from that same env.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {object} [options.standup] injected harness-standup service (tests)
 * @returns {{server: import('node:http').Server, config: object, store: object,
 *            mirror: object, runStore: object, gateStore: object, standup: object}}
 */
export function createArfServer({
  config = loadConfig(),
  reloadConfig = () => loadConfig(),
  env = process.env,
  fetchImpl,
  now,
  standup = null,
} = {}) {
  const store = openReviewStore(config);
  const mirrorStore = new MirrorStore({
    path: config.github.mirrorPath,
    reviewStorePath: config.storePath,
    busyTimeoutMs: config.busyTimeoutMs,
  });
  const client = new GithubReadClient({ config, env, fetchImpl, now });
  const mirror = new GithubMirror({ config, client, store: mirrorStore, env, now });
  const runStore = openStandupRunStore(config);
  const gateStore = openGateStore(config, { now });
  // Constructing the harness standup service resolves state-file paths only.
  // It performs no runtime install/probe and opens no broker connection until a
  // request actually drives the wizard.
  const harnessStandup = standup ?? createHarnessStandup({ config });
  const ctx = {
    store,
    mirror,
    runStore,
    gateStore,
    standup: harnessStandup,
    config,
    reloadConfig,
    startedAt: performance.now(),
    // Built per call rather than held: `describe()` is cheap, and a broker cached
    // at boot would keep reporting the mapping set from before a standup wrote one.
    brokerDescribe: () => openTokenBroker(reloadConfig()).describe(),
  };
  const server = createServer((req, res) => {
    // handleRequest is async (the mirror route awaits GitHub), so a rejection
    // has to be caught off the promise as well as synchronously — an unhandled
    // rejection here would leave the socket hanging and, under Node's default,
    // take the process down.
    Promise.resolve()
      .then(() => handleRequest(ctx, req, res))
      .catch((err) => {
        // A projection bug must not take the process down; report it as a 500 and
        // keep serving. Degrade-to-empty is the store's job, not the socket's.
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal_error', detail: String(err?.message ?? err) });
        } else {
          res.end();
        }
      });
  });
  return { server, config, store, mirror, runStore, gateStore, standup: harnessStandup };
}
