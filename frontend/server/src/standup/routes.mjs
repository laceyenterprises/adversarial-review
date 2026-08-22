/**
 * The `ar-standup` HTTP surface for harnesses (ARF-06, SPEC §9).
 *
 *   GET  /api/standup/harness          registered harnesses + allowlist + broker roles
 *   GET  /api/standup/harness/catalog  templates the panel prefills from
 *   POST /api/standup/harness/runs     run the wizard (SSE step stream, or JSON)
 *
 * This is the first ARF route that *writes*, so it is the first that has to
 * think about who is asking. ARF binds `127.0.0.1` by default, which keeps it
 * off the network but not out of reach of a web page the operator has open: a
 * browser will happily POST to localhost from any origin. Two guards close that,
 * and they are cheap enough that there is no reason not to have both:
 *
 *   - **`content-type: application/json` is required.** A JSON content type
 *     makes a cross-origin POST a *non-simple* request, so the browser must
 *     preflight it — and ARF answers no preflight, so it never happens. A form
 *     post (`text/plain`, `application/x-www-form-urlencoded`) needs no
 *     preflight, which is exactly why it is refused here.
 *   - **A cross-origin `Origin` header is refused.** Belt to the same braces,
 *     and it also covers a client that sets the header without a preflight.
 *
 * Request bodies are read with a byte cap, for the same reason the broker caps
 * upstream response bodies: a body ARF did not author should not be able to
 * choose ARF's memory footprint.
 */

import { startSse } from './sse.mjs';

/** Largest standup request ARF will read. A harness spec is well under a KiB. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export class RequestError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Refuse a request a browser could have been tricked into sending.
 *
 * The `Origin` comparison is against the request's own `Host`, not against a
 * configured origin: ARF's bind address is operator-chosen, and hard-coding
 * `localhost` would break the moment someone bound it somewhere else — or worse,
 * quietly stop matching and start refusing everything.
 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // curl, fetch from a script, the panel's same-origin fetch
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new RequestError(403, 'forbidden_origin', `unparseable Origin header ${origin}`);
  }
  if (parsed.host !== req.headers.host) {
    throw new RequestError(
      403,
      'forbidden_origin',
      `cross-origin request from ${origin} refused; ARF's standup API is same-origin only`,
    );
  }
}

function assertJsonContentType(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RequestError(
      415,
      'unsupported_media_type',
      'standup requests must be sent as application/json',
    );
  }
}

/** Read a capped request body. Rejects rather than truncating: a truncated
 *  harness spec that happens to still parse would stand up the wrong thing. */
export function readJsonBody(req, { limit = MAX_REQUEST_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return; // over the cap already: keep draining, keep nothing
      size += chunk.length;
      if (size > limit) {
        // Rejected but not destroyed. Tearing the socket down here would race
        // the 413 the caller is about to write, and the client would see a
        // connection reset instead of the reason it was refused. The rest of
        // the body is read and discarded so the response can be delivered.
        chunks.length = 0;
        fail(new RequestError(413, 'payload_too_large', `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('aborted', () => fail(new RequestError(400, 'bad_request', 'request aborted')));
    req.on('error', (err) => fail(new RequestError(400, 'bad_request', err.message)));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new RequestError(400, 'bad_request', 'request body must be a JSON object'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new RequestError(400, 'bad_request', `request body is not valid JSON: ${err.message}`));
      }
    });
  });
}

function wantsEventStream(req) {
  return String(req.headers.accept ?? '').toLowerCase().includes('text/event-stream');
}

/**
 * Route a standup request.
 *
 * @param {{standup: object}} ctx
 * @returns {Promise<boolean>} whether the request belonged to this surface
 */
export async function handleStandupRequest(ctx, req, res, { pathname, method }) {
  if (!pathname.startsWith('/api/standup/')) return false;

  try {
    if (method === 'GET' && pathname === '/api/standup/harness') {
      sendJson(res, 200, await ctx.standup.describe());
      return true;
    }

    if (method === 'GET' && pathname === '/api/standup/harness/catalog') {
      sendJson(res, 200, { templates: ctx.standup.catalog() });
      return true;
    }

    if (pathname === '/api/standup/harness/runs') {
      if (method !== 'POST') {
        throw new RequestError(405, 'method_not_allowed', `${method} is not supported here`);
      }
      assertSameOrigin(req);
      assertJsonContentType(req);
      const body = await readJsonBody(req);
      const dryRun = body.dryRun === true;
      const spec = body.harness ?? body.spec;

      // Validate before committing to a response shape. A malformed spec is a
      // 400 with the offending field named, not an event stream whose first
      // frame is an error — the second is harder to notice and harder to script
      // against.
      try {
        ctx.standup.validate(spec);
      } catch (err) {
        throw new RequestError(400, err.code ?? 'invalid_harness', err.message
          + (err.field ? ` (field: ${err.field})` : ''));
      }

      if (wantsEventStream(req)) {
        const stream = startSse(res);
        try {
          // The run's own outcome rides the stream (`run.done`); there is
          // nothing left to return once the last frame is written.
          await ctx.standup.run(spec, {
            dryRun,
            emit: ({ event, data }) => stream.send(event, data),
          });
        } catch (err) {
          // A throw here is ARF failing, not a step failing — steps report
          // themselves. It still has to reach the client: a stream that just
          // stops looks identical to a run still in progress.
          stream.send('run.error', { error: err.code ?? 'internal_error', detail: err.message });
          stream.end();
          return true;
        }
        stream.end();
        return true;
      }

      const summary = await ctx.standup.run(spec, { dryRun });
      // 422 for a run that completed with a failed step: the request was
      // well-formed, the standup was not. A 200 would have every client that
      // checks `res.ok` treat an unwired allowlist as a success.
      sendJson(res, summary.status === 'ready' ? 200 : 422, summary);
      return true;
    }

    throw new RequestError(404, 'not_found', `no route for ${pathname}`);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return true;
    }
    if (err instanceof RequestError) {
      sendJson(res, err.status, { error: err.code, detail: err.detail });
      return true;
    }
    sendJson(res, 500, {
      error: err.code ?? 'internal_error',
      detail: String(err?.message ?? err),
    });
    return true;
  }
}
