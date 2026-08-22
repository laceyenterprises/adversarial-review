/**
 * Bounded upstream body reads (ARF-07).
 *
 * The property under test is an allocation bound, not a string length: the
 * point is that a hostile or merely misconfigured upstream cannot make ARF
 * buffer its whole response. So the cases below assert on how much of the
 * stream was actually pulled, not only on what came back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_BODY_BYTES, readCappedBody } from '../src/broker/http.mjs';
import { streamingResponse } from './helpers/broker-fixtures.mjs';

/** `count` chunks of `size` bytes of the letter `a` — cheap to build, easy to measure. */
function filler(count, size) {
  return Array.from({ length: count }, () => new Uint8Array(size).fill(0x61));
}

describe('readCappedBody', () => {
  it('returns a small body whole', async () => {
    const { response, meta } = streamingResponse([Buffer.from('{"message":"Integration not found"}')]);
    assert.equal(await readCappedBody(response), '{"message":"Integration not found"}');
    assert.equal(meta.cancelled, false, 'a body that fits is drained, not cancelled');
  });

  it('stops pulling once the cap is reached instead of buffering the whole payload', async () => {
    // 64 chunks of 1 MiB: 64 MiB if it were all read, which is the OOM shape.
    const { response, meta } = streamingResponse(filler(64, 1024 * 1024));
    const text = await readCappedBody(response);

    assert.equal(text.length, MAX_BODY_BYTES, 'the returned text is capped');
    assert.ok(
      meta.pulled <= 1024 * 1024 + MAX_BODY_BYTES,
      `only the chunks needed to reach the cap were pulled (pulled ${meta.pulled})`,
    );
    assert.equal(meta.cancelled, true, 'the reader is released rather than drained');
  });

  it('bounds the result even when a single chunk is larger than the cap', async () => {
    const { response } = streamingResponse([new Uint8Array(MAX_BODY_BYTES * 4).fill(0x62)]);
    assert.equal((await readCappedBody(response)).length, MAX_BODY_BYTES);
  });

  it('honours an explicit smaller cap', async () => {
    const { response, meta } = streamingResponse(filler(4, 32), { status: 502 });
    assert.equal((await readCappedBody(response, 64)).length, 64);
    assert.equal(meta.cancelled, true);
  });

  it('decodes multi-byte characters that straddle a chunk boundary', async () => {
    const encoded = Buffer.from('{"error":"schön"}', 'utf8');
    // Split inside the two-byte `ö`, the case a naive per-chunk decode mangles.
    const cut = encoded.indexOf(0xc3) + 1;
    const { response } = streamingResponse([encoded.subarray(0, cut), encoded.subarray(cut)]);
    assert.equal(await readCappedBody(response), '{"error":"schön"}');
  });

  it('yields what it read when the stream errors part-way through', async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        // The first pull delivers; the connection drops on the next one. An
        // error raised before the first read would discard the queue instead.
        if (pulls++ === 0) controller.enqueue(Buffer.from('partial'));
        else controller.error(new Error('connection reset'));
      },
    });
    // Never throws: every caller is already on an error path where the status is
    // the load-bearing signal and the body is a nicety.
    assert.equal(await readCappedBody({ status: 500, body }), 'partial');
  });

  it('falls back to text() for a response with no readable stream', async () => {
    assert.equal(await readCappedBody({ status: 404, text: async () => 'plain' }), 'plain');
    assert.equal(
      (await readCappedBody({ status: 404, text: async () => 'x'.repeat(MAX_BODY_BYTES * 2) })).length,
      MAX_BODY_BYTES,
      'the fallback path still caps',
    );
  });

  it('returns an empty string when the body cannot be read at all', async () => {
    const boom = { status: 500, text: async () => { throw new Error('already consumed'); } };
    assert.equal(await readCappedBody(boom), '');
  });
});
