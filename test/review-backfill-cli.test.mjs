import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { persistReviewFindings } from '../src/review-finding-records.mjs';

const body = '## Blocking Issues\n- **Validate input**\n  - **File:** `input.mjs`\n  - **Problem:** Invalid input accepted.\n';
for (const kind of ['findings', 'grades']) {
  for (const failAt of [0, 1]) {
    test(`${kind} CLI retains committed receipts when pass ${failAt + 1} fails and replays safely`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'backfill-cli-'));
      const path = join(dir, 'reviews.db');
      const db = new Database(path);
      t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
      ensureReviewStateSchema(db);
      const insert = db.prepare(`INSERT INTO reviewer_passes
        (repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,status,body_md)
        VALUES ('sample/service',?,1,'sample','first-pass','2026-01-01T00:00:00Z','posted',?)`);
      const ids = [1, 2].map(n => Number(insert.run(n, body).lastInsertRowid));
      if (kind === 'grades') {
        for (const id of ids) {
          persistReviewFindings(db, id);
          const finding = db.prepare('SELECT * FROM review_findings WHERE pass_id=?').get(id);
          db.prepare(`INSERT INTO finding_backlog
            (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,outcome,reason,result_pr)
            VALUES (?,'sample/service',?,'head',?,'sample','src','applied','fixed',3)`)
            .run(finding.finding_id, id, finding.content_sha256);
        }
      }
      const table = kind === 'grades' ? 'review_finding_grades' : 'review_findings';
      const passId = kind === 'grades'
        ? '(SELECT pass_id FROM review_findings WHERE finding_id=NEW.finding_id)' : 'NEW.pass_id';
      db.exec(`CREATE TRIGGER interrupt_backfill BEFORE INSERT ON ${table}
        WHEN ${passId}=${ids[failAt]} BEGIN SELECT RAISE(ABORT, 'synthetic pass failure'); END`);
      const cli = fileURLToPath(new URL(`../bin/review-${kind}.mjs`, import.meta.url));
      const run = () => spawnSync(process.execPath, [cli, 'backfill', '--db', path],
        { encoding: 'utf8', timeout: 10000 });
      const receipts = result => result.stderr.trim().split('\n')
        .filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      const failed = run();
      assert.equal(failed.status, 1, failed.stderr);
      assert.equal(failed.stdout, '');
      assert.match(failed.stderr, /synthetic pass failure/);
      const progress = receipts(failed);
      assert.equal(progress.length, failAt + 1);
      if (failAt) assert.deepEqual(progress[0], { event: 'backfill-pass', passId: ids[0], inserted: 1,
        committedPasses: 1, committedInserted: 1, lastPassId: ids[0] });
      assert.deepEqual(progress.at(-1), { event: 'backfill-failed', committedPasses: failAt,
        committedInserted: failAt, lastPassId: failAt ? ids[0] : null });
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, failAt);
      db.exec('DROP TRIGGER interrupt_backfill');
      const resumed = run();
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).inserted, 2 - failAt);
      assert.equal(receipts(resumed).at(-1).committedInserted, 2 - failAt);
      const replay = run();
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).inserted, 0);
      assert.equal(receipts(replay).at(-1).committedInserted, 0);
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 2);
    });
  }
}
