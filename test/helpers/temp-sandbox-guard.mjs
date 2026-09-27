// Preloaded in each node:test worker. Exercise os.tmpdir() with a fixture
// prefix tied to this run, so a concurrent suite cannot cause a false alarm.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT && process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT) {
  if (!process.env.ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX) {
    throw new Error('run tests through test/run-tests.mjs so the temp probe prefix is set');
  }
  const expected = path.join(process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT, 'tmp');
  const fixture = mkdtempSync(path.join(tmpdir(), process.env.ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX));
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(process.env[key], expected);
  assert.equal(path.dirname(fixture), expected);
}
