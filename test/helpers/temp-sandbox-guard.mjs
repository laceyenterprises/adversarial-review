// Preloaded in each node:test worker. Exercise os.tmpdir() with a fixture
// prefix tied to this run, so a concurrent suite cannot cause a false alarm.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT && process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT) {
  const expected = path.join(process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT, 'tmp');
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(process.env[key], expected);
  assert.equal(tmpdir(), expected);
  const fixture = mkdtempSync(path.join(tmpdir(), process.env.ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX));
  assert.equal(path.dirname(fixture), expected);
}
