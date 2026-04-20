import test from 'node:test';
import assert from 'node:assert/strict';
import { TAG_PREFIXES } from '../src/pr-title-tagging.mjs';
import { REQUIRED_PREFIXES, validatePRTitlePrefix } from '../src/pr-title-validate.mjs';

test('validation prefixes mirror canonical tag prefixes', () => {
  assert.deepEqual(REQUIRED_PREFIXES, Object.values(TAG_PREFIXES));
});

test('validatePRTitlePrefix accepts known prefixes', () => {
  assert.equal(validatePRTitlePrefix('[codex] LAC-182: add repo check').valid, true);
  assert.equal(validatePRTitlePrefix('[CLAUDE-CODE] LAC-182: add repo check').valid, true);
  assert.equal(validatePRTitlePrefix('[clio-agent] LAC-182: add repo check').valid, true);
});

test('validatePRTitlePrefix fails with clear creation-time guidance', () => {
  const result = validatePRTitlePrefix('LAC-182: missing adversarial-review prefix');

  assert.equal(result.valid, false);
  for (const prefix of REQUIRED_PREFIXES) {
    assert.match(result.message, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(result.message, /creation-time tag correctness/i);
  assert.match(result.message, /Retitling later does not retrigger adversarial review/i);
  assert.match(result.message, /close and recreate the PR/i);
});

test('validatePRTitlePrefix fails on empty titles', () => {
  const result = validatePRTitlePrefix('   ');
  assert.equal(result.valid, false);
  assert.match(result.message, /empty title/i);
});

test('validatePRTitlePrefix fails on nullish titles', () => {
  const undefinedResult = validatePRTitlePrefix(undefined);
  assert.equal(undefinedResult.valid, false);
  assert.match(undefinedResult.message, /empty title/i);

  const nullResult = validatePRTitlePrefix(null);
  assert.equal(nullResult.valid, false);
  assert.match(nullResult.message, /empty title/i);
});
