import test from 'node:test';
import assert from 'node:assert/strict';

import { ADVERSARIAL_PROMPT } from '../src/reviewer.mjs';
import { buildSpecTouchPromptSection } from '../src/spec-touch.mjs';

test('reviewer prompt carries the shared spec-touch guidance block verbatim', () => {
  const section = buildSpecTouchPromptSection();
  assert.ok(ADVERSARIAL_PROMPT.includes(section));
  assert.match(section, /final-round lenient pass/);
  assert.match(section, /modules\/worker-pool\/lib\/hq-\*\.sh/);
  assert.match(section, /docs\/SPEC-session-ledger-control-plane\.md/);
});
