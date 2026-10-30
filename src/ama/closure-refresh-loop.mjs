import { withRepositoryStateCycle } from '../repository-state-lock.mjs';
import { canonicalRepositoryArguments } from '../repository-names.mjs';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { observeClosureWait } from './closure-wait.mjs';
import { closureGateFactsKey } from './closure-gate-facts.mjs';

export const CLOSURE_REFRESH_CYCLE_LIMIT = 3;

// Count consumed disagreements, including a second disagreement during the
// one allowed successor attempt. Submissions and changed decision keys cannot
// erase same-head debt. This is diagnostic evidence, never dispatch authority.
async function observeClosureDecisionMismatchWithinRepositoryState({ rootDir, repo, prNumber, result,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait }) {
  const shared = result?.nextActionShared;
  const headSha = shared?.decision?.head;
  if (result?.reason !== 'closure-decision-mismatch' || !headSha
    || shared.snapshot.head !== headSha || shared.snapshot.subjectKey !== `${repo}#${prNumber}`) return result;
  const dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  let cycles;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS decision_mismatch_cycle (id INTEGER PRIMARY KEY CHECK(id=1), head TEXT NOT NULL, cycles INTEGER NOT NULL)');
    cycles = db.transaction(() => {
      const previous = db.prepare('SELECT * FROM decision_mismatch_cycle WHERE id=1').get();
      const count = previous?.head === headSha ? Math.min(2, previous.cycles + 1) : 1;
      db.prepare('INSERT OR REPLACE INTO decision_mismatch_cycle(id,head,cycles) VALUES (1,?,?)').run(headSha, count);
      return count;
    }).immediate();
  } finally { db.close(); }
  if (cycles < 2) return result;
  const closureBlocker = `closure-decision-mismatch-no-progress: head=${headSha} cycles=${cycles}`;
  const boundedWait = await observeWaitImpl({ rootDir, repo, prNumber, headSha, env, now,
    reason: closureBlocker, immediate: true, waitClass: 'closure-decision-mismatch' });
  return { ...result, reason: 'closure-decision-mismatch-escalated', closureBlocker, boundedWait,
    needsOperator: true, skipMergeAgent: true, recoveryWait: true };
}

// Count settled refresh outcomes, never queue submissions or re-observations of
// in-flight work. This diagnostic evidence grants no merge/dispatch authority.
async function observeClosureRefreshLoopWithinRepositoryState({ rootDir, repo, prNumber, shared, result,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait }) {
  if (!shared || !result || result.backgroundDispatch) return result;
  const { snapshot, decision } = shared;
  const headSha = decision.head;
  if (!headSha || snapshot.head !== headSha) return result;
  const refresh = !result.dispatched && decision.reason === 'snapshot-refresh';
  const observations = snapshot.observations;
  const storedExecution = observations.progress?.value?.daemonExecution;
  const execution = storedExecution?.headSha === headSha ? storedExecution : null;
  const declineReason = execution?.reason || null;
  const facts = Object.fromEntries(['pr', 'checks', 'reviews'].map(name => [name, {
    state: observations[name]?.state, value: observations[name]?.value,
  }]));
  const fingerprint = createHash('sha256').update(closureGateFactsKey({
    facts, declineReason, reasons: execution?.reasons || [],
  })).digest('hex');
  const dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  let cycles;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS refresh_cycle (id INTEGER PRIMARY KEY CHECK(id=1), head TEXT NOT NULL, fingerprint TEXT NOT NULL, cycles INTEGER NOT NULL)');
    cycles = db.transaction(() => {
      if (!refresh) {
        db.prepare('DELETE FROM refresh_cycle').run();
        return 0;
      }
      const previous = db.prepare('SELECT * FROM refresh_cycle WHERE id=1').get();
      const count = previous?.head === headSha && previous.fingerprint === fingerprint
        ? Math.min(CLOSURE_REFRESH_CYCLE_LIMIT, previous.cycles + 1) : 1;
      db.prepare('INSERT OR REPLACE INTO refresh_cycle(id,head,fingerprint,cycles) VALUES (1,?,?,?)')
        .run(headSha, fingerprint, count);
      return count;
    }).immediate();
  } finally { db.close(); }
  if (cycles < CLOSURE_REFRESH_CYCLE_LIMIT) return result;
  const closureBlocker = `snapshot-refresh-no-progress: daemon:${declineReason || 'unknown'} cycles=${cycles}`;
  const boundedWait = await observeWaitImpl({ rootDir, repo, prNumber, headSha, env, now,
    reason: closureBlocker, immediate: true, waitClass: 'snapshot-refresh' });
  return { ...result, closureBlocker, boundedWait, needsOperator: true, skipMergeAgent: true,
    recoveryWait: true };
}

export async function observeClosureDecisionMismatch(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    observeClosureDecisionMismatchWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}

export async function observeClosureRefreshLoop(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    observeClosureRefreshLoopWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}
