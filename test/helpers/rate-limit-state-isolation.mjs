import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-rate-limit-'));

process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = path.join(
  rootDir,
  'data',
  'api-cache',
  'rate-limit-state.json',
);

test.after(() => {
  rmSync(rootDir, { recursive: true, force: true });
});
