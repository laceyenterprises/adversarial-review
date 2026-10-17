import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

const cli = fileURLToPath(new URL('../bin/review-queue-depth.mjs', import.meta.url));

test('read-only queue-depth CLI reports missing draft evidence without migrating a legacy database', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-depth-cli-'));
  mkdirSync(join(root, 'data'));
  const db = new Database(join(root, 'data', 'reviews.db'));
  try {
    ensureReviewStateSchema(db);
    db.exec('ALTER TABLE reviewed_prs DROP COLUMN is_draft');
    const before = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    for (const json of [true, false]) {
      const result = spawnSync(process.execPath, [cli, '--root', root, ...(json ? ['--json'] : [])],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: '1' } });
      assert.equal(result.status, 0, result.stderr);
      if (json) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.depth, null);
        assert.equal(report.engaged, false);
        assert.equal(report.held, 0);
        assert.match(report.depthError, /is_draft.*schema convergence/);
      } else assert.match(result.stdout, /unknown[\s\S]*schema convergence/);
    }
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviewed_prs').get().n, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
