import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveDaemonWorkerIdentityForPr,
  postgresLedgerTargetFromEnv,
  postgresLedgerTargetForDaemon,
} from '../src/daemon-worker-identity.mjs';

// Regression: the daemon identity reader mis-resolved to a stale sqlite target in
// the long-running watcher (`postgres-configured-but-sqlite-resolved`) and
// fail-closed `worker-identity-unresolved` on EVERY clean PR (fresh #4395 with a
// valid current-head pr_opened row still parked). The fix binds an explicit
// Postgres ledger target (env-derived, cycle-free) so the reader can't fall
// through to sqlite. These lock in that the target is threaded to the reader on
// BOTH the strict lookup and the head-independent retry.

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'daemon-worker-identity-target-'));
}

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

test('postgresLedgerTargetForDaemon falls back to Agent OS config when ledger env is scrubbed', () => {
  const agentOsRoot = tempRoot();
  try {
    const reviewRoot = join(agentOsRoot, 'tools', 'adversarial-review');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(
      join(agentOsRoot, 'config.yaml'),
      `version: 1
session_ledger:
  backend: postgres
  dsn: null
  database_name: agent_os_ledger
`,
    );

    assert.deepEqual(postgresLedgerTargetForDaemon({ env: {}, rootDir: reviewRoot }), {
      backend: 'postgres',
      dsn: null,
      databaseName: 'agent_os_ledger',
      source: 'daemon-identity:config-dbname',
    });
  } finally {
    rmSync(agentOsRoot, { recursive: true, force: true });
  }
});

test('postgresLedgerTargetForDaemon lets config.local.yaml supply the deploy DSN', () => {
  const agentOsRoot = tempRoot();
  try {
    const reviewRoot = join(agentOsRoot, 'tools', 'adversarial-review');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(
      join(agentOsRoot, 'config.yaml'),
      `version: 1
session_ledger:
  backend: postgres
  dsn: null
  database_name: agent_os_ledger
`,
    );
    writeFileSync(
      join(agentOsRoot, 'config.local.yaml'),
      `version: 1
session_ledger:
  dsn: postgresql://airlock@127.0.0.1:6432/agent_os_ledger
`,
    );

    assert.deepEqual(postgresLedgerTargetForDaemon({ env: {}, rootDir: reviewRoot }), {
      backend: 'postgres',
      dsn: 'postgresql://airlock@127.0.0.1:6432/agent_os_ledger',
      databaseName: 'agent_os_ledger',
      source: 'daemon-identity:config-dsn',
    });
  } finally {
    rmSync(agentOsRoot, { recursive: true, force: true });
  }
});

test('postgresLedgerTargetForDaemon honors AGENT_OS_CONFIG_PATH as a hermetic override', () => {
  const agentOsRoot = tempRoot();
  try {
    const reviewRoot = join(agentOsRoot, 'tools', 'adversarial-review');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(
      join(agentOsRoot, 'config.yaml'),
      `version: 1
session_ledger:
  backend: postgres
  database_name: agent_os_ledger
`,
    );

    assert.equal(
      postgresLedgerTargetForDaemon({
        env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
        rootDir: reviewRoot,
      }),
      null,
    );
  } finally {
    rmSync(agentOsRoot, { recursive: true, force: true });
  }
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

test('resolver uses config-derived Postgres target for launchd-style scrubbed env', async () => {
  const agentOsRoot = tempRoot();
  try {
    const reviewRoot = join(agentOsRoot, 'tools', 'adversarial-review');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(
      join(agentOsRoot, 'config.yaml'),
      `version: 1
session_ledger:
  backend: postgres
  dsn: null
  database_name: agent_os_ledger
`,
    );

    const seenTargets = [];
    const result = await resolveDaemonWorkerIdentityForPr({
      repo: 'laceyenterprises/agent-os',
      prNumber: 4398,
      currentHeadSha: 'b7f4e3e67ef07b164f3c45502037a24e0b21523a',
      currentBranch: 'codex-pxt-05-retry-1-b06f7719/PXT-05-auto-retry-1',
      consumeHeadAttestations: false,
      rootDir: reviewRoot,
      env: {},
      readBuildCompletionSignalForPrImpl: async (args) => {
        seenTargets.push(args.ledgerTarget);
        if (args.headSha) return { ok: false, reason: 'missing-build-completion-signal' };
        return {
          ok: true,
          row: {
            launch_request_id: 'lrq_88fb523b-9ab4-4312-ab03-8f32556a8145',
            worker_class: 'codex',
            head_sha: '33eb461a09223f74a0e350781910222817115639',
          },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.resolvedBy, 'pr-opened-head-moved');
    assert.equal(result.launchRequestId, 'lrq_88fb523b-9ab4-4312-ab03-8f32556a8145');
    assert.equal(result.workerClass, 'codex');
    assert.equal(seenTargets.length, 2);
    for (const target of seenTargets) {
      assert.deepEqual(target, {
        backend: 'postgres',
        dsn: null,
        databaseName: 'agent_os_ledger',
        source: 'daemon-identity:config-dbname',
      });
    }
  } finally {
    rmSync(agentOsRoot, { recursive: true, force: true });
  }
});
