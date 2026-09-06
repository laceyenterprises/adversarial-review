import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('watcher caches failed HCP healthcheck results for the whole poll tick', () => {
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /let hcpHealthzForTick = null;[\s\S]*?if \(hcpHealthzForTick === null\) {[\s\S]*?hcpHealthzForTick = await checkHcpHealthz\(\);[\s\S]*?return hcpHealthzForTick;/,
  );
  assert.doesNotMatch(source, /!hcpHealthzForTick \|\| !hcpHealthzForTick\.ready/);
});
