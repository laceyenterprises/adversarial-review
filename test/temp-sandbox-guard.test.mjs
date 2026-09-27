import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const guard = fileURLToPath(new URL('./helpers/temp-sandbox-guard.mjs', import.meta.url));

test('temp sandbox guard explains a missing probe prefix', () => {
  const child = spawnSync(process.execPath, ['--import', guard, '-e', ''], {
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: 'child-v8',
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: path.join(tmpdir(), 'test-sandbox'),
      ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX: '',
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /run tests through test\/run-tests\.mjs so the temp probe prefix is set/);
});
