import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDaemonWorkerIdentityForPr,
  postgresLedgerTargetFromEnv,
} from '../src/daemon-worker-identity.mjs';

// Regression: the daemon identity reader mis-resolved to a stale sqlite target in
// the long-running watcher (`postgres-configured-but-sqlite-resolved`) and
// fail-closed `worker-identity-unresolved` on EVERY clean PR (fresh #4395 with a
// valid current-head pr_opened row still parked). The fix binds an explicit
// Postgres ledger target (env-derived, cycle-free) so the reader can't fall
// through to sqlite. These lock in that the target is threaded to the reader on
// BOTH the strict lookup and the head-independent retry.

test('postgresLedgerTargetFromEnv builds a Postgres target from the DSN env', () => {
  const target = postgresLedgerTargetFromEnv({
    AGENT_OS_SESSION_LEDGER_DSN: 'postgresql://airlock@127.0.0.1:6432/agent_os_ledger',
    AGENT_OS_CFG_SESSION_LEDGER_DATABASE_NAME: 'agent_os_ledger',
  });
  assert.deepEqual(target, {
    backend: 'postgres',
    dsn: 'postgresql://airlock@127.0.0.1:6432/agent_os_ledger',
    databaseName: 'agent_os_ledger',
    source: 'daemon-identity:env-dsn',
  });
});

test('postgresLedgerTargetFromEnv falls back to a Postgres URL in AGENT_OS_SESSION_LEDGER_TARGET', () => {
  const target = postgresLedgerTargetFromEnv({
    AGENT_OS_SESSION_LEDGER_TARGET: 'postgres://host/db',
  });
  assert.equal(target?.backend, 'postgres');
  assert.equal(target?.dsn, 'postgres://host/db');
});

test('postgresLedgerTargetFromEnv builds from backend+database_name when no DSN URL is present', () => {
  const target = postgresLedgerTargetFromEnv({
    AGENT_OS_CFG_SESSION_LEDGER_BACKEND: 'postgres',
    AGENT_OS_CFG_SESSION_LEDGER_DATABASE_NAME: 'agent_os_ledger',
  });
  assert.deepEqual(target, {
    backend: 'postgres',
    dsn: null,
    databaseName: 'agent_os_ledger',
    source: 'daemon-identity:env-dbname',
  });
});

test('postgresLedgerTargetFromEnv returns null for a sqlite target (dev deploy — auto-resolution preserved)', () => {
  assert.equal(
    postgresLedgerTargetFromEnv({ AGENT_OS_SESSION_LEDGER_TARGET: '/var/lib/agent-os/ledger.db' }),
    null,
  );
  assert.equal(postgresLedgerTargetFromEnv({}), null);
});

test('resolver threads an explicit ledgerTarget into BOTH the strict lookup and the head-independent retry', async () => {
  const seenTargets = [];
  const explicitTarget = { backend: 'postgres', dsn: 'postgresql://test/ledger', source: 'test' };
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4395,
    currentHeadSha: 'headmovedaftertheprwasopened',
    consumeHeadAttestations: false,
    ledgerTarget: explicitTarget,
    readBuildCompletionSignalForPrImpl: async (args) => {
      seenTargets.push(args.ledgerTarget);
      // Strict head-bound lookup misses (head moved); head-independent retry hits.
      if (args.headSha) return { ok: false, reason: 'missing-build-completion-signal' };
      return { ok: true, row: { launch_request_id: 'lrq_x', worker_class: 'codex', head_sha: 'originalopenhead' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'pr-opened-head-moved');
  assert.equal(result.launchRequestId, 'lrq_x');
  assert.equal(result.workerClass, 'codex');
  assert.equal(seenTargets.length, 2, 'both strict + retry reads happened');
  for (const target of seenTargets) {
    assert.equal(target, explicitTarget, 'each read carried the explicit Postgres target');
  }
});

test('resolver defaults to an env-derived Postgres ledgerTarget when none is passed', async () => {
  const seenTargets = [];
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4395,
    currentHeadSha: 'abc123',
    consumeHeadAttestations: false,
    env: { AGENT_OS_SESSION_LEDGER_DSN: 'postgresql://airlock@127.0.0.1:6432/agent_os_ledger' },
    readBuildCompletionSignalForPrImpl: async (args) => {
      seenTargets.push(args.ledgerTarget);
      return { ok: true, row: { launch_request_id: 'lrq_y', worker_class: 'codex', head_sha: 'abc123' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seenTargets[0]?.backend, 'postgres');
  assert.equal(seenTargets[0]?.dsn, 'postgresql://airlock@127.0.0.1:6432/agent_os_ledger');
  assert.equal(seenTargets[0]?.source, 'daemon-identity:env-dsn');
});
