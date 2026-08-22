/**
 * The SSE wire format and the static handler (ARF-05).
 *
 * Both are small, both are shared by the whole surface, and both fail in ways
 * that are hard to see from a higher-level test: a parser that loses a frame
 * split across a chunk boundary looks like a wizard that occasionally skips a
 * step, and a traversal in the static handler looks like nothing at all until it
 * matters.
 */

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { describe, it } from 'node:test';

import { SSE_HEADERS, formatSse, parseSseBuffer, sseComment } from '../../frontend/shared/sse-wire.mjs';
import { FRONTEND_ROOT, resolveStaticFile } from '../src/static.mjs';

describe('SSE framing', () => {
  it('round-trips an event through the framer and the parser', () => {
    const frame = formatSse('step', { id: 'wire_token_map', status: 'ok' }, { id: 7 });
    const { events, rest } = parseSseBuffer(frame);

    assert.equal(rest, '');
    assert.deepEqual(events, [{
      id: '7',
      event: 'step',
      data: { id: 'wire_token_map', status: 'ok' },
    }]);
  });

  it('keeps an unterminated frame as the remainder instead of losing it', () => {
    // The case a chunked read hits constantly: the network's idea of a chunk
    // boundary has nothing to do with an event boundary. A parser that dropped
    // the partial frame would silently skip whichever step it straddled.
    const stream = formatSse('run', { a: 1 }) + formatSse('step', { b: 2 });
    const split = stream.length - 10;

    const first = parseSseBuffer(stream.slice(0, split));
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].event, 'run');

    const second = parseSseBuffer(first.rest + stream.slice(split));
    assert.equal(second.rest, '');
    assert.deepEqual(second.events.map((event) => event.event), ['step']);
  });

  it('ignores comment lines, which is what the opening ping relies on', () => {
    const stream = sseComment('arf identity standup the-hammer') + formatSse('run', { ok: true });
    const { events } = parseSseBuffer(stream);
    assert.deepEqual(events.map((event) => event.event), ['run']);
  });

  it('prefixes every payload line, so a newline cannot split one event into two', () => {
    // JSON.stringify escapes newlines, so this is insurance rather than a live
    // bug — but the failure it prevents is a frame silently becoming two, the
    // second of which is unparseable.
    const frame = formatSse('step', { detail: 'line one\nline two' });
    const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(dataLines.length, 1);
    assert.deepEqual(parseSseBuffer(frame).events[0].data, { detail: 'line one\nline two' });
  });

  it('tolerates CRLF line endings a proxy may introduce', () => {
    const crlf = formatSse('complete', { status: 'ok' }).replace(/\n/g, '\r\n');
    assert.deepEqual(parseSseBuffer(crlf).events[0].data, { status: 'ok' });
  });

  it('declares the headers that stop a proxy buffering the stream', () => {
    // A buffered event-stream is a live wizard that renders as one burst at the
    // end, which is indistinguishable from a hung run.
    assert.match(SSE_HEADERS['content-type'], /^text\/event-stream/);
    assert.match(SSE_HEADERS['cache-control'], /no-transform/);
    assert.equal(SSE_HEADERS['x-accel-buffering'], 'no');
  });
});

describe('static file resolution', () => {
  it('serves the shell at the root', () => {
    const resolved = resolveStaticFile('/');
    assert.equal(basename(resolved.path), 'index.html');
    assert.match(resolved.contentType, /text\/html/);
  });

  it('serves the module the panel and the server share', () => {
    const resolved = resolveStaticFile('/shared/sse-wire.mjs');
    assert.ok(resolved.path.startsWith(FRONTEND_ROOT));
    assert.match(resolved.contentType, /javascript/);
  });

  it('refuses a path that escapes the frontend root', () => {
    for (const attempt of [
      '/../server/src/config.mjs',
      '/../../../etc/passwd',
      '/shared/../../server/package.json',
      '/./../server/src/broker/secrets.mjs',
    ]) {
      assert.equal(resolveStaticFile(attempt), null, `${attempt} must not resolve`);
    }
  });

  it('refuses a sibling directory that merely shares the root as a prefix', () => {
    // `frontend-secrets/x` starts with the root string but is not inside it; a
    // naive `startsWith` without the separator would let it through.
    assert.equal(resolveStaticFile('/../frontend-secrets/keys.json'), null);
  });

  it('serves nothing with an unlisted extension, even inside the root', () => {
    // The second, independent guard: even a path that got past the traversal
    // check cannot return a database, a key, or a config.
    assert.equal(resolveStaticFile('/roles.db'), null);
    assert.equal(resolveStaticFile('/.env'), null);
    assert.equal(resolveStaticFile('/index.html.bak'), null);
  });

  it('does not rewrite an unknown path to the shell', () => {
    // A catch-all would make every mistyped API path return 200 text/html, so a
    // caller would get a JSON parse error somewhere else instead of a 404 here.
    assert.equal(resolveStaticFile('/v1/standup/identity/rolez'), null);
    assert.equal(resolveStaticFile('/nope'), null);
  });
});
