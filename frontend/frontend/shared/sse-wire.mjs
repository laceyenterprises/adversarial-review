/**
 * The SSE wire format — framing and parsing — shared by both ends (ARF-05).
 *
 * This file lives under `frontend/` for one specific reason: it is the only ARF
 * module that has to exist in two places at once. The server imports it to frame
 * the standup stream; the browser is *served* it (as `/shared/sse-wire.mjs`) to
 * parse the same stream. Putting it here means the filesystem layout and the URL
 * space agree exactly — `frontend/shared/sse-wire.mjs` is `/shared/sse-wire.mjs`
 * — with one static root, one relative import from each side, and no aliasing.
 *
 * The alternative was a copy on each side, and a framer and a parser that are
 * free to drift are a bad pair to own: the failure would be a wizard that streams
 * events the panel silently drops.
 *
 * Three details in the format do real work:
 *
 * - **Every line of the payload gets its own `data:` prefix.** `JSON.stringify`
 *   escapes newlines, so nothing multi-line reaches here today — but a frame
 *   whose payload contained a bare newline would be split into two events by the
 *   client, and the second would be unparseable JSON. Splitting costs nothing
 *   and removes the failure mode.
 *
 * - **An event id on every frame.** It is what makes `Last-Event-ID` reconnection
 *   possible for a client that wants it, and it gives an operator reading a
 *   captured stream something to point at.
 *
 * - **The headers disable buffering explicitly.** A reverse proxy that buffers a
 *   `text/event-stream` turns a live step-by-step wizard into a single burst at
 *   the end, which looks exactly like a hung run. `X-Accel-Buffering: no` is
 *   nginx's opt-out; `no-transform` stops a compressing proxy doing the same
 *   thing by accident.
 */

/** Headers an SSE response must carry. */
export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

/**
 * Frame one event.
 *
 * @param {string} event event name
 * @param {unknown} data JSON-serializable payload
 * @param {{id?: number|string}} [options]
 * @returns {string} a complete SSE frame, terminating blank line included
 */
export function formatSse(event, data, { id } = {}) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  for (const line of JSON.stringify(data ?? {}).split('\n')) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * An SSE comment line.
 *
 * Sent immediately on opening the stream: it commits the response headers and
 * pushes a first byte through whatever is between ARF and the browser, so the
 * panel switches to "connected" at once rather than after the first step happens
 * to finish. Clients ignore comment lines by specification.
 */
export function sseComment(text) {
  return `: ${String(text).replace(/\n/g, ' ')}\n\n`;
}

/**
 * Parse accumulated stream text into events.
 *
 * Returns the events it could complete plus the unterminated remainder, so a
 * caller can feed it chunk by chunk without losing a frame split across a read —
 * which is the normal case, since a step transition and the network's idea of a
 * chunk boundary have nothing to do with each other.
 *
 * @param {string} buffer accumulated text
 * @returns {{events: Array<{id: string|null, event: string, data: any}>, rest: string}}
 */
export function parseSseBuffer(buffer) {
  const events = [];
  // Frames are separated by a blank line; `\r\n` is tolerated because it is legal
  // and because a proxy may rewrite line endings in transit.
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    if (part.trim() === '') continue;
    let id = null;
    let event = 'message';
    const data = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // A single leading space after the colon is part of the framing, not the value.
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) continue;
    const text = data.join('\n');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    events.push({ id, event, data: parsed });
  }

  return { events, rest };
}
