/**
 * Bounded reads of upstream HTTP bodies (ARF-07).
 *
 * Both broker adapters quote upstream error bodies into ARF's own errors, which
 * means they have to read them — from an external broker, from whatever proxy
 * sits in front of it, and from GitHub. `response.text()` buffers the entire
 * payload before anything can look at its size, so truncating afterwards is too
 * late: the allocation has already happened. A multi-megabyte HTML error page
 * from a misconfigured proxy, or a deliberately hostile response, would turn an
 * upstream problem into an out-of-memory crash of the ARF daemon.
 *
 * So the body is streamed and the byte tally is kept *while* reading. Once
 * `MAX_BODY_BYTES` have accumulated the reader is cancelled and the rest of the
 * payload never enters the process.
 */

/** Enough to hold any error body worth quoting, small enough to not matter to the heap. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` of a response body, as text.
 *
 * Never throws. A body that errors part-way through yields whatever was read
 * before the failure: every caller is already on an error path where the status
 * is the load-bearing signal and the body is a nicety.
 *
 * @param {Response} response
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readCappedBody(response, maxBytes = MAX_BODY_BYTES) {
  const stream = response?.body;
  if (!stream || typeof stream.getReader !== 'function') {
    // No web stream to pull from — a `fetch` double in tests, or a body some
    // other layer already consumed. `text()` is the only read available, so the
    // cap can only be applied after the fact; that is the old behaviour, kept
    // for the shapes that cannot stream rather than for the ones that can.
    try {
      const text = await response.text();
      return typeof text === 'string' ? text.slice(0, maxBytes) : '';
    } catch {
      return '';
    }
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // Sliced before it is decoded, so the accumulated string stays bounded
      // even if the transport hands over one chunk larger than the whole cap.
      const room = maxBytes - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (bytes >= maxBytes) {
        // Cancel rather than drain: draining would still pull the whole payload
        // across the socket, which is most of the cost being avoided here.
        await reader.cancel().catch(() => {});
        return text;
      }
    }
    return text + decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    return text;
  }
}
