import './rate-limit-state-isolation.mjs';
// Keep timeout-sensitive tests independent of machine load and local config.
import { beforeEach } from 'node:test';
import os from 'node:os';
import { resetLoadAwareTimeoutCachesForTesting } from '../../src/load-aware-timeout.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(t => {
  resetLoadAwareTimeoutCachesForTesting();
  const dir = mkdtempSync(join(os.tmpdir(), 'timeout-config-'));
  const previousPath = process.env.AGENT_OS_CONFIG_PATH;
  process.env.AGENT_OS_CONFIG_PATH = join(dir, 'config.yaml');
  writeFileSync(process.env.AGENT_OS_CONFIG_PATH, 'version: 1\n');
  t.mock.method(os, 'loadavg', () => [0, 0, 0]);
  t.after(() => {
    resetLoadAwareTimeoutCachesForTesting();
    if (previousPath === undefined) delete process.env.AGENT_OS_CONFIG_PATH;
    else process.env.AGENT_OS_CONFIG_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
});
