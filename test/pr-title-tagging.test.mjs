import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_CLASS_BY_TAG,
  builderClassFromTitle,
  buildTaggedTitle,
  getPrefixForTag,
  hasCanonicalTaggedTitle,
  hasKnownPrefix,
  normalizeTag,
} from '../src/pr-title-tagging.mjs';

test('normalizeTag accepts canonical tags and aliases', () => {
  assert.equal(normalizeTag('codex'), 'codex');
  assert.equal(normalizeTag('CODEx'), 'codex');
  assert.equal(normalizeTag('claude-code'), 'claude-code');
  assert.equal(normalizeTag('claude'), 'claude-code');
  assert.equal(normalizeTag('clio-agent'), 'clio-agent');
  assert.equal(normalizeTag('clio'), 'clio-agent');
  assert.equal(normalizeTag('gemini'), 'gemini');
  assert.equal(normalizeTag('pi'), 'pi');
  assert.equal(normalizeTag('opencode'), 'opencode');
  assert.equal(normalizeTag('hermes'), 'hermes');
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
  assert.equal(getPrefixForTag('gemini'), '[gemini]');
  assert.equal(getPrefixForTag('pi'), '[pi]');
  assert.equal(getPrefixForTag('opencode'), '[opencode]');
  assert.equal(getPrefixForTag('hermes'), '[hermes]');
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
  assert.throws(
    () => buildTaggedTitle('clio-agent', '[codex]LAC-180 without separator'),
    /Title must be unprefixed/
  );
});

test('hasKnownPrefix type-guards non-string inputs', () => {
  assert.equal(hasKnownPrefix(undefined), false);
  assert.equal(hasKnownPrefix(null), false);
  assert.equal(hasKnownPrefix({}), false);
  assert.equal(hasKnownPrefix('[codex] valid'), true);
});

test('hasCanonicalTaggedTitle enforces single prefix and non-empty suffix', () => {
  assert.equal(hasCanonicalTaggedTitle('[codex] LAC-180: valid title'), true);
  assert.equal(hasCanonicalTaggedTitle('[codex]'), false);
  assert.equal(hasCanonicalTaggedTitle('[codex]   '), false);
  assert.equal(hasCanonicalTaggedTitle('[codex] [claude-code] stacked'), false);
});

test('builderClassFromTitle resolves MHX-09 prefixes to worker classes', () => {
  assert.equal(BUILDER_CLASS_BY_TAG.gemini, 'gemini');
  assert.equal(builderClassFromTitle('[gemini] SMOKE: route gemini PRs'), 'gemini');
  assert.equal(BUILDER_CLASS_BY_TAG.pi, 'pi');
  assert.equal(builderClassFromTitle('[pi] SMOKE: route pi PRs'), 'pi');
  assert.equal(BUILDER_CLASS_BY_TAG.opencode, 'opencode');
  assert.equal(builderClassFromTitle('[opencode] SMOKE: route opencode PRs'), 'opencode');
  assert.equal(BUILDER_CLASS_BY_TAG.hermes, 'hermes');
  assert.equal(builderClassFromTitle('[hermes] SMOKE: route hermes PRs'), 'hermes');
});
