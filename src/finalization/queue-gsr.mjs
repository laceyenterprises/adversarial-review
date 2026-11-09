// GSR controls issuance, never lane routing or merge policy. A drain cannot
// erase unknown requests; the existing MGQ operation reconciliation owns them.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertQueueStoreOwner, openFinalizationQueueStore, queueTime } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';

export function queueGsrSnapshot(db) {
  const present = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finalization_queue_lane'").get();
  if (!present) return { present: true, held: false, token: null, operations: [], entries: [] };
  const installed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finalization_queue_gsr'").get();
  if (!installed) throw new Error('queue GSR composition unavailable');
  const hold = db.prepare('SELECT * FROM finalization_queue_gsr WHERE singleton=1').get();
  return {
    present: true, held: !!hold, token: hold?.token ?? null,
    operations: db.prepare('SELECT operation_id,repository,base,kind FROM finalization_queue_operation WHERE result_json IS NULL').all(),
    entries: db.prepare("SELECT entry_id,repository,base,phase FROM finalization_queue_entry WHERE phase NOT IN ('merged','closed-observed','returned-to-closer')").all(),
  };
}

export function createQueueGsr({ store, now = () => new Date().toISOString() }) {
  return {
    // Insert and issuance-intent creation serialize on the same SQLite writer.
    drain(token) {
      if (typeof token !== 'string' || !token.startsWith('maintenance-window:')) throw new Error('maintenance token required');
      return store.tx(() => {
        store.db.prepare('INSERT INTO finalization_queue_gsr VALUES (1,?,?) ON CONFLICT DO NOTHING').run(token, queueTime(now()));
        return queueGsrSnapshot(store.db);
      });
    },
    // Steer is a receipt of retained candidates and pending remote operations.
    // No closer is relaunched; MGQ-10 handed its durable work to the queue.
    steer() { return queueGsrSnapshot(store.db); },
    resume(token) {
      if (typeof token !== 'string' || !token) throw new Error('expected maintenance token required');
      return store.tx(() => {
        store.db.prepare('DELETE FROM finalization_queue_gsr WHERE singleton=1 AND token=?').run(token);
        return queueGsrSnapshot(store.db);
      });
    },
  };
}

export function queueGsrMain([command, rootDir, token]) {
  if (!['status', 'steer', 'drain', 'resume'].includes(command) || !rootDir) throw new Error('queue GSR command and root required');
  const path = join(rootDir, 'data/reviews.db');
  if (!existsSync(path) && ['status', 'steer', 'resume'].includes(command)) {
    return { present: true, held: false, token: null, operations: [], entries: [] };
  }
  assertQueueStoreOwner(rootDir);
  if (command === 'status' || command === 'steer') {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma(`busy_timeout = ${queueWaitMs(1000, { ceilingMs: 6000 })}`);
      return db.transaction(() => queueGsrSnapshot(db))();
    } finally { db.close(); }
  }
  const store = openFinalizationQueueStore({ rootDir });
  try { return createQueueGsr({ store })[command](token); }
  finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(queueGsrMain(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(`queue GSR unavailable: ${error.message || error.name}\n`); process.exitCode = 1; }
}
