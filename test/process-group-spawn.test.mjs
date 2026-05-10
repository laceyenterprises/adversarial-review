import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';

test('progress watchdog escalates SIGTERM-ignoring children to process-group SIGKILL and preserves stderr', async () => {
  const progressTimeout = 250;
  const killGraceMs = 250;
  const startedAt = Date.now();

  await assert.rejects(
    () => spawnCapturedProcessGroup(
      'bash',
      ['-c', 'trap "" TERM; echo "auth probe failed: token expired" >&2; while :; do sleep 1; done'],
      {
        progressTimeout,
        killGraceMs,
        timeout: 10_000,
      }
    ),
    (err) => {
      const elapsed = Date.now() - startedAt;
      assert.equal(err.progressTimedOut, true);
      assert.equal(err.killed, true);
      assert.equal(err.signal, 'SIGKILL');
      assert.ok(elapsed < progressTimeout + killGraceMs + 1_500, `elapsed ${elapsed}ms exceeded watchdog budget`);
      assert.match(err.message, /no output/);
      assert.match(err.message, /auth probe failed: token expired/);
      assert.match(err.stderr, /auth probe failed: token expired/);
      return true;
    }
  );
});
