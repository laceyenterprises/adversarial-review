import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('watcher injects hq execution dependencies when retrying reviewed attestations', () => {
  const watcherSrc = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const callStart = watcherSrc.indexOf('retryPendingReviewedAttestations({');
  assert.notEqual(callStart, -1);
  const callSource = watcherSrc.slice(callStart, watcherSrc.indexOf('});', callStart));

  assert.match(callSource, /rootDir:\s*ROOT/);
  assert.match(callSource, /hqPath:\s*process\.env\.HQ_BIN\s*\|\|\s*'hq'/);
  assert.match(callSource, /execFileImpl:\s*execFileAsync/);
  assert.match(callSource, /env:\s*process\.env/);
});
