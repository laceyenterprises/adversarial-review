import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERSARIAL_GATE_CONTEXT_ENV_VAR,
  DEFAULT_ADVERSARIAL_GATE_CONTEXT,
  resolveGateStatusContext,
} from '../src/adversarial-gate-context.mjs';

test('resolveGateStatusContext returns the default when no env override is set', () => {
  assert.equal(resolveGateStatusContext({}), DEFAULT_ADVERSARIAL_GATE_CONTEXT);
  assert.equal(DEFAULT_ADVERSARIAL_GATE_CONTEXT, 'agent-os/adversarial-gate');
});

test('resolveGateStatusContext honors a non-empty env override', () => {
  const env = { [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'galileo/adversarial-gate' };
  assert.equal(resolveGateStatusContext(env), 'galileo/adversarial-gate');
});

test('resolveGateStatusContext falls back to the default for an empty override', () => {
  const env = { [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: '' };
  assert.equal(resolveGateStatusContext(env), DEFAULT_ADVERSARIAL_GATE_CONTEXT);
});

test('resolveGateStatusContext trims whitespace and falls back when only whitespace', () => {
  assert.equal(
    resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: '  galileo/gate  ' }),
    'galileo/gate'
  );
  assert.equal(
    resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: '   \t  ' }),
    DEFAULT_ADVERSARIAL_GATE_CONTEXT
  );
});

test('resolveGateStatusContext refuses CR or LF in the override', () => {
  assert.throws(
    () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'galileo/gate\n' }),
    /must not contain CR or LF/
  );
  assert.throws(
    () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'galileo\r/gate' }),
    /must not contain CR or LF/
  );
  assert.throws(
    () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'a\r\nb' }),
    /must not contain CR or LF/
  );
});

test('resolveGateStatusContext refuses other control characters in a non-empty override', () => {
  assert.throws(
    () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'galileo\tgate' }),
    /must not contain control characters/
  );
});
