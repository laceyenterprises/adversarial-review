import Database from 'better-sqlite3';
import { join } from 'node:path';

// An offline launch ledger with a failed ancestor, terminal sibling, and a
// two-hop retry. All identifiers and metadata are synthetic.
export function launchRetryFixture(root, retryStatus = 'requested') {
  const path = join(root, 'synthetic-launch-ledger.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE launch_requests (
    launch_request_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT,
    terminal_at TEXT, failure_class TEXT, ticket_ref TEXT, metadata_json TEXT
  )`);
  const insert = db.prepare('INSERT INTO launch_requests VALUES (?, ?, NULL, NULL, NULL, ?, ?)');
  for (const [id, status, retryOf] of [
    ['synthetic-lrq', 'failed', null],
    ['synthetic-retry', 'failed', 'synthetic-lrq'],
    ['synthetic-retry-leaf', retryStatus, 'synthetic-retry'],
    ['synthetic-terminal-sibling', 'canceled', 'synthetic-lrq'],
    ['synthetic-unrelated', 'running', null],
  ]) insert.run(id, status, 'HAM', JSON.stringify({ retryOf }));
  // Historical/imported ledger rows may not contain valid JSON. They must not
  // break retry traversal for an unrelated hammer.
  insert.run('synthetic-malformed', 'failed', 'HAM', '{broken');
  insert.run('synthetic-empty', 'failed', 'HAM', '');
  db.close();
  return { backend: 'sqlite', path };
}
