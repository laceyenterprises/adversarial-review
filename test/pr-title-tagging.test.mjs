import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaggedTitle, getPrefixForTag, normalizeTag } from '../src/pr-title-tagging.mjs';

test('normalizeTag accepts canonical tags and aliases', () => {
  assert.equal(normalizeTag('codex'), 'codex');
  assert.equal(normalizeTag('CODEx'), 'codex');
  assert.equal(normalizeTag('claude-code'), 'claude-code');
  assert.equal(normalizeTag('claude'), 'claude-code');
  assert.equal(normalizeTag('clio-agent'), 'clio-agent');
  assert.equal(normalizeTag('clio'), 'clio-agent');
});

test('normalizeTag rejects unknown values', () => {
  assert.equal(normalizeTag(''), null);
  assert.equal(normalizeTag('unknown'), null);
  assert.equal(normalizeTag(undefined), null);
});

test('getPrefixForTag returns required prefixes', () => {
  assert.equal(getPrefixForTag('codex'), '[codex]');
  assert.equal(getPrefixForTag('claude'), '[claude-code]');
  assert.equal(getPrefixForTag('clio-agent'), '[clio-agent]');
});

test('buildTaggedTitle prepends canonical prefix', () => {
  assert.equal(
    buildTaggedTitle('codex', 'LAC-180: build canonical PR helper'),
    '[codex] LAC-180: build canonical PR helper'
  );
});

test('buildTaggedTitle rejects missing/invalid tag inputs', () => {
  assert.throws(() => buildTaggedTitle(undefined, 'some title'), /Invalid or missing tag/);
  assert.throws(() => buildTaggedTitle('other', 'some title'), /Invalid or missing tag/);
});

test('buildTaggedTitle rejects missing or already-prefixed titles', () => {
  assert.throws(() => buildTaggedTitle('codex', ''), /Missing required --title/);
  assert.throws(
    () => buildTaggedTitle('claude-code', '[codex] already prefixed'),
    /Title must be unprefixed/
  );
});
