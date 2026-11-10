// Agent OS off-pass producer bridge to the existing finalization append API.
// One observation per invocation, acknowledged only after the app store commits.
import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { assertQueueStoreOwner } from './queue-store.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeFinalizationEvent } from './ledger-events.mjs';
import { openFinalizationLedgerStore } from './ledger-store.mjs';

export function ingestCustody(store, input) {
  if (input?.type !== 'launch_custody_observed') throw new TypeError('custody event required');
  const event = makeFinalizationEvent(input.type, input.subjectKey, input);
  const appended = store.append(event);
  if (!isDeepStrictEqual(appended.custody, event.custody)) throw new Error('custody idempotency key content mismatch');
  return { idempotencyKey: appended.idempotencyKey, seq: appended.seq };
}

/** A freshness projection only. It grants no ownership or merge authority. */
export function custodyFreshness(event, now) {
  const c = event?.type === 'unknown:launch_custody_observed' ? null : event?.custody;
  if (!c) return { fresh: false, liveness: 'unknown', terminalDirtyWorktree: false };
  const age = Date.parse(now) - Date.parse(event.at);
  const fresh = Number.isFinite(age) && age >= 0 && age <= c.freshnessSeconds * 1000;
  return {
    fresh,
    liveness: fresh ? c.launchLiveness ?? 'unknown' : 'unknown',
    terminalDirtyWorktree: fresh && c.state === 'workspace'
      && c.launchLiveness === 'terminal' && c.dirty === true,
  };
}

export function custodyIngestMain(argv, input) {
  if (argv.length !== 2 || argv[0] !== '--root') throw new Error('--root DIR required');
  if (input.length > 65536) throw new Error('custody event too large');
  const event = JSON.parse(input);
  const root = realpathSync(argv[1]);
  assertQueueStoreOwner(root);
  const db = new Database(join(root, 'data/reviews.db'), { fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${loadAwareTimeoutMs(5000)}`);
    const store = openFinalizationLedgerStore({ db });
    return ingestCustody(store, event);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(custodyIngestMain(process.argv.slice(2), readFileSync(0, 'utf8'))) + '\n');
  } catch (error) {
    process.stderr.write(`custody append unavailable: ${error.message || error.name}\n`);
    process.exitCode = 1;
  }
}
