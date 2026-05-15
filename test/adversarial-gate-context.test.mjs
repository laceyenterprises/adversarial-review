import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADVERSARIAL_GATE_CONTEXT_ENV_VAR,
  DEFAULT_ADVERSARIAL_GATE_CONTEXT,
  resolveGateStatusContext,
} from '../src/adversarial-gate-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

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

test('resolveGateStatusContext refuses log-unsafe override characters', () => {
  for (const value of [
    'galileo gate',
    'galileo/gate,reason=present',
    'galileo/gate=present',
    'galileo:gate',
  ]) {
    assert.throws(
      () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: value }),
      /must match \[A-Za-z0-9\._\/-\]\+/
    );
  }
});

test('resolveGateStatusContext refuses overlong overrides', () => {
  assert.throws(
    () => resolveGateStatusContext({ [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'a'.repeat(101) }),
    /at most 100 characters/
  );
});

test('watcher startup fails fast on invalid gate context override', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "import './src/watcher.mjs';"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        [ADVERSARIAL_GATE_CONTEXT_ENV_VAR]: 'my gate reason=present',
      },
      encoding: 'utf8',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ADV_GATE_STATUS_CONTEXT must match/);
});
