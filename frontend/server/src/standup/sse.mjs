/**
 * A minimal server-sent-events writer (SPEC §1: "SSE step stream like
 * `hq app standup`").
 *
 * Small enough to inline, kept separate because ARF-05's identity wizard needs
 * the same thing and two hand-rolled SSE encoders in one app is one too many.
 *
 * Two details are not cosmetic:
 *
 *   - **Every line of the payload gets its own `data:` prefix.** A JSON payload
 *     with an embedded newline written as one `data:` line silently truncates
 *     the event at the browser. `JSON.stringify` does not emit raw newlines
 *     today, but a future payload that does would fail in the client and be
 *     perfectly fine in the tests.
 *   - **Proxy buffering is turned off.** An event stream that arrives in one
 *     chunk at the end is not a step stream; `X-Accel-Buffering: no` is the
 *     header nginx-shaped proxies honour, and disabling Nagle keeps a small
 *     frame from waiting for company.
 */

/**
 * Start an SSE response on `res`.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{heartbeatMs?: number}} [options]
 */
export function startSse(res, { heartbeatMs = 15000 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.socket?.setNoDelay?.(true);

  // A comment frame keeps an idle connection from being reaped by an
  // intermediary during a slow step (a runtime probe can legitimately take
  // seconds). Unref'd so it cannot hold the process open on its own.
  const heartbeat = heartbeatMs > 0 ? setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, heartbeatMs) : null;
  heartbeat?.unref?.();

  let closed = false;
  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
  };
  res.on('close', () => { closed = true; stop(); });

  return {
    /** Whether the client has gone away — a long run can stop early. */
    get closed() {
      return closed || res.writableEnded;
    },
    send(event, data) {
      if (this.closed) return;
      const payload = JSON.stringify(data ?? {});
      const lines = payload.split('\n').map((line) => `data: ${line}`).join('\n');
      res.write(`event: ${event}\n${lines}\n\n`);
    },
    end() {
      stop();
      if (!res.writableEnded) res.end();
    },
  };
}
