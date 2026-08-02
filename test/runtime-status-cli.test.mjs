import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRuntimeStatus, readAuditRows, renderRuntimeStatus } from '../src/runtime-status.mjs';
import { runtimeMain } from '../src/runtime-status-cli.mjs';
import { createRouterAuditSink } from '../src/adapters/agent-runtime/router/audit.mjs';
import { writeRuntimeStatusSnapshot } from '../src/runtime-status-snapshot.mjs';
import { writeCanaryStatus } from '../src/adapters/agent-runtime/canary.mjs';
import { recordRuntimeRun } from '../src/adapters/agent-runtime/run-ledger.mjs';
import { writeSettleSmokeResult } from '../src/adapters/agent-runtime/settle-smoke.mjs';
import {
  SETTLE_SMOKE_MODEL,
  buildSettleSmokeRequest,
  runRuntimeSettleSmoke,
} from '../src/runtime-settle-smoke-cli.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'runtime-status-cli-'));
}

// Silent audit sink that still writes real rows to disk.
function diskAuditSink(rootDir) {
  return createRouterAuditSink({ rootDir, deliverNoticeFn: async () => {}, logger: { error() {}, warn() {} } });
}

async function seedFullFixture(rootDir) {
  const sink = diskAuditSink(rootDir);
  await sink.recordTransition({
    kind: 'failover',
    reason: 'probe-failures',
    at: '2026-07-16T22:41:10.000Z',
    from: 'os-healthy',
    to: 'local-fallback',
    fromMode: 'os',
    toMode: 'local',
    probeFailures: 3,
  });
  await sink.recordTransition({
    kind: 'resume-complete',
    reason: 'resume-complete',
    at: '2026-07-17T09:12:04.000Z',
    from: 'os-resuming',
    to: 'os-healthy',
    fromMode: 'local',
    toMode: 'os',
    healthyProbes: 6,
    spanMs: 300_000,
    reconcile: { adoptedCount: 2, duplicatedCount: 0, notFoundCount: 0, unknownCount: 0 },
  });

  writeRuntimeStatusSnapshot(rootDir, {
    mode: 'os',
    since: '2026-07-17T09:12:04Z',
    probe: {
      healthy: true,
      components: { healthzOk: true, dispatchP95Ms: 412, dispatchP95Ok: true, sseLive: true },
    },
    config: { enabled: true, probeFailureThreshold: 3, resumeHealthyProbes: 6 },
    pendingOsRuns: 0,
    reconciled: { adopted: 2, duplicated: 0 },
  });

  writeCanaryStatus(rootDir, {
    schema_version: 1,
    status: 'pass',
    at: '2026-07-17T06:00:12.000Z',
    durationMs: 94_000,
    domainId: 'research-finding',
    mode: 'local',
    verdictKind: 'comment-only',
    detail: 'local fixture review, verdict=comment-only',
  });
}

test('renders the SPEC Win 1 status block from durable artifacts', async () => {
  const rootDir = tmpRoot();
  try {
    await seedFullFixture(rootDir);
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    // A handful of runs inside the 24h window.
    for (let i = 0; i < 41; i += 1) recordRuntimeRun(rootDir, { at: '2026-07-17T10:00:00.000Z', mode: 'os', status: 'completed' });
    for (let i = 0; i < 7; i += 1) recordRuntimeRun(rootDir, { at: '2026-07-17T10:00:00.000Z', mode: 'local', status: 'completed' });

    const model = buildRuntimeStatus(rootDir, { now });
    const rendered = renderRuntimeStatus(model);

    assert.equal(rendered, [
      'mode: os          since: 2026-07-17T09:12:04Z',
      'probe: healthy     (healthz ok, dispatch p95 412ms, sse live)',
      'last failover: 2026-07-16T22:41:10.000Z -> local  (3 probe failures)',
      'last resume:   2026-07-17T09:12:04.000Z -> os     (6 healthy probes / 5m)',
      'runs (24h): os=41 local=7   reconciled-on-resume: 2 adopted, 0 duplicated',
      'fallback canary: PASS 2026-07-17T06:00:12.000Z (local fixture review, verdict=comment-only, 94s)',
      'settle smoke: MISSING agent-runtime (missing)',
      'reviewer cutover: not requested',
    ].join('\n'));

    // JSON model carries the same facts for tooling.
    assert.equal(model.mode, 'os');
    assert.equal(model.runs.os, 41);
    assert.equal(model.runs.local, 7);
    assert.equal(model.reconcile.adopted, 2);
    assert.equal(model.reconcile.duplicated, 0);
    assert.equal(model.canary.status, 'pass');
    assert.equal(model.reviewerCutover, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('degrades gracefully with no artifacts: unknown probe, none/never lines, os baseline', () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    const rendered = renderRuntimeStatus(buildRuntimeStatus(rootDir, { now }));
    const lines = rendered.split('\n');
    assert.match(lines[0], /^mode: os\s+since: n\/a$/);
    assert.match(lines[1], /^probe: unknown\s+\(no live router snapshot\)$/);
    assert.equal(lines[2], 'last failover: none');
    assert.equal(lines[3], 'last resume:   none');
    assert.match(lines[4], /^runs \(24h\): os=0 local=0\s+reconciled-on-resume: n\/a$/);
    assert.equal(lines[5], 'fallback canary: never run');
    assert.equal(lines[6], 'settle smoke: MISSING agent-runtime (missing)');
    assert.equal(lines[7], 'reviewer cutover: not requested');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a degraded probe renders "degraded" with the failing component named', () => {
  const rootDir = tmpRoot();
  try {
    writeRuntimeStatusSnapshot(rootDir, {
      mode: 'local',
      since: '2026-07-17T09:00:00Z',
      probe: { healthy: false, components: { healthzOk: false, dispatchP95Ms: null, sseLive: true } },
    });
    const model = buildRuntimeStatus(rootDir, { now: () => new Date('2026-07-17T12:00:00.000Z') });
    const line = renderRuntimeStatus(model).split('\n')[1];
    assert.match(line, /probe: degraded/);
    assert.match(line, /healthz failed/);
    assert.match(line, /dispatch p95 no samples/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtimeMain prints the block and returns 0; --json returns the model', async () => {
  const rootDir = tmpRoot();
  try {
    let out = '';
    const io = { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } };
    const code = await runtimeMain(['status', '--root', rootDir], io);
    assert.equal(code, 0);
    assert.match(out, /^mode: os/);
    assert.match(out, /fallback canary: never run/);

    out = '';
    const jsonCode = await runtimeMain(['status', '--root', rootDir, '--json'], io);
    assert.equal(jsonCode, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.mode, 'os');
    assert.equal(parsed.runs.total, 0);
    assert.equal(parsed.settleSmoke.reason, 'missing');
    assert.equal(parsed.reviewerCutover, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime status surfaces reviewer cutover refusal reasons for code-pr', () => {
  const rootDir = tmpRoot();
  try {
    mkdirSync(join(rootDir, 'domains'), { recursive: true });
    writeFileSync(join(rootDir, 'domains', 'code-pr.json'), JSON.stringify({
      id: 'code-pr',
      reviewerRuntime: 'agent-runtime',
      agentRuntimeSettleSmokeVerified: true,
    }));
    writeRuntimeStatusSnapshot(rootDir, {
      mode: 'local',
      probe: { healthy: false, components: { healthzOk: false } },
      config: { enabled: true },
    });
    writeCanaryStatus(rootDir, { status: 'fail', at: '2026-07-17T06:00:12.000Z', durationMs: 94_000 });
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-07-17T10:00:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_1',
    });
    const model = buildRuntimeStatus(rootDir, {
      now: () => new Date('2026-07-17T12:00:00.000Z'),
      env: { AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'agentos' },
    });
    const line = renderRuntimeStatus(model).split('\n')[7];
    assert.equal(model.reviewerCutover.selectedRuntime, 'agent-os-hq');
    assert.equal(model.reviewerCutover.state, 'refused');
    assert.match(line, /reviewer cutover: REFUSED agent-os-hq/);
    assert.match(line, /runtime-not-os-healthy/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime status surfaces reviewer runtime kill-switch before not-requested shortcut', () => {
  const rootDir = tmpRoot();
  try {
    mkdirSync(join(rootDir, 'domains'), { recursive: true });
    writeFileSync(join(rootDir, 'domains', 'code-pr.json'), JSON.stringify({
      id: 'code-pr',
      reviewerRuntime: 'cli-direct',
    }));
    const model = buildRuntimeStatus(rootDir, {
      now: () => new Date('2026-07-17T12:00:00.000Z'),
      env: { ADVERSARIAL_REVIEWER_RUNTIME: 'agent-runtime' },
    });
    const line = renderRuntimeStatus(model).split('\n')[7];
    assert.equal(model.reviewerCutover.state, 'forced');
    assert.equal(model.reviewerCutover.selectedRuntime, 'agent-runtime');
    assert.match(line, /reviewer cutover: FORCED agent-runtime/);
    assert.match(line, /env-kill-switch/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime status surfaces reviewer runtime kill-switch when code-pr config is unreadable', () => {
  const rootDir = tmpRoot();
  try {
    mkdirSync(join(rootDir, 'domains'), { recursive: true });
    writeFileSync(join(rootDir, 'domains', 'code-pr.json'), '{not valid json');
    const model = buildRuntimeStatus(rootDir, {
      now: () => new Date('2026-07-17T12:00:00.000Z'),
      env: { ADVERSARIAL_REVIEWER_RUNTIME: 'cli-direct' },
    });
    const line = renderRuntimeStatus(model).split('\n')[7];
    assert.equal(model.reviewerCutover.state, 'forced');
    assert.equal(model.reviewerCutover.selectedRuntime, 'cli-direct');
    assert.match(line, /reviewer cutover: FORCED cli-direct/);
    assert.match(line, /env-kill-switch/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtimeMain rejects an unknown subcommand and a bad flag', async () => {
  let err = '';
  const io = { stdout: { write() {} }, stderr: { write: (s) => { err += s; } } };
  assert.equal(await runtimeMain(['bogus'], io), 2);
  assert.match(err, /unknown runtime command bogus/);

  err = '';
  assert.equal(await runtimeMain(['status', '--nope'], io), 2);
  assert.match(err, /unknown argument/);
});

test('runtime settle-smoke persists a PASS artifact and prints JSON', async () => {
  const rootDir = tmpRoot();
  try {
    let out = '';
    let createOptions = null;
    const code = await runtimeMain(['settle-smoke', '--runtime', 'agent-runtime', '--root', rootDir, '--json'], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write() {} },
      now: () => new Date('2026-08-02T10:00:00.000Z'),
      createRuntime: (options) => {
        createOptions = options;
        return {
        async run() {
          return {
            runRef: 'smoke-req-1',
            async await() {
              return {
                status: 'completed',
                usage: { workerRunId: 'wr_smoke_1' },
              };
            },
          };
        },
        };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(createOptions, { rootDir, runtime: 'agent-runtime' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.dispatched, true);
    assert.equal(parsed.settled, true);
    assert.equal(parsed.attributed, true);
    assert.equal(parsed.workerRunId, 'wr_smoke_1');

    const status = buildRuntimeStatus(rootDir, {
      now: () => new Date('2026-08-02T10:01:00.000Z'),
    });
    assert.equal(status.settleSmoke.ok, true);
    assert.equal(status.settleSmoke.result.workerRunId, 'wr_smoke_1');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime settle-smoke uses the named logical route constant', () => {
  const request = buildSettleSmokeRequest({
    now: () => new Date('2026-08-02T10:00:00.000Z'),
  });

  assert.equal(SETTLE_SMOKE_MODEL, 'codex');
  assert.equal(request.role.model, SETTLE_SMOKE_MODEL);
});

test('runtime settle-smoke preserves its in-memory result when persistence read-back fails', async () => {
  const outcome = await runRuntimeSettleSmoke({
    rootDir: '/fixture',
    now: () => new Date('2026-08-02T10:00:00.000Z'),
    createRuntime: () => ({
      async run() {
        return {
          runRef: 'smoke-req-readback',
          async await() {
            return {
              status: 'completed',
              usage: { workerRunId: 'wr_smoke_readback' },
            };
          },
        };
      },
    }),
    writeResultImpl: () => null,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.smoke.status, 'pass');
  assert.equal(outcome.smoke.workerRunId, 'wr_smoke_readback');
});

test('runtime settle-smoke preserves its in-memory result when persistence read-back is unreadable', async () => {
  const outcome = await runRuntimeSettleSmoke({
    rootDir: '/fixture',
    now: () => new Date('2026-08-02T10:00:00.000Z'),
    createRuntime: () => ({
      async run() {
        return {
          runRef: 'smoke-req-unreadable',
          async await() {
            return {
              status: 'completed',
              usage: { workerRunId: 'wr_smoke_unreadable' },
            };
          },
        };
      },
    }),
    writeResultImpl: () => ({ runtime: 'agent-runtime', read_error: 'unreadable' }),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.smoke.status, 'pass');
  assert.equal(outcome.smoke.workerRunId, 'wr_smoke_unreadable');
});

test('snapshot and canary status writers reject cross-user durable state writes', () => {
  const owners = new Map([['/tool/data', 501]]);
  const ownerGuardOptions = {
    currentUid: () => 502,
    exists: (path) => owners.has(path),
    stat: (path) => ({ uid: owners.get(path) }),
  };
  assert.throws(
    () => writeRuntimeStatusSnapshot('/tool', { mode: 'os' }, { ownerGuardOptions }),
    /refusing cross-user durable state write/,
  );
  assert.throws(
    () => writeCanaryStatus('/tool', { status: 'pass' }, { ownerGuardOptions }),
    /refusing cross-user durable state write/,
  );
});

test('readAuditRows bounds the newest-transition lookup once latest failover and resume are found', () => {
  const rootDir = tmpRoot();
  try {
    const dir = join(rootDir, 'data', 'runtime-router-audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-05.jsonl'), [
      JSON.stringify({ kind: 'failover', at: '2026-05-01T00:00:00.000Z', to_mode: 'local' }),
      JSON.stringify({ kind: 'resume-complete', at: '2026-05-01T00:05:00.000Z', to_mode: 'os' }),
      '',
    ].join('\n'));
    writeFileSync(join(dir, '2026-06.jsonl'), [
      JSON.stringify({
        kind: 'resume-start',
        at: '2026-06-01T00:00:00.000Z',
        to_mode: 'local',
        healthy_probes: 6,
        span_ms: 300_000,
      }),
      JSON.stringify({
        kind: 'resume-complete',
        at: '2026-06-01T00:05:00.000Z',
        to_mode: 'os',
        reconcile: { adopted: 1, duplicated: 0 },
      }),
      '',
    ].join('\n'));
    writeFileSync(join(dir, '2026-07.jsonl'), [
      JSON.stringify({ kind: 'failover', at: '2026-07-01T00:00:00.000Z', to_mode: 'local' }),
      '',
    ].join('\n'));

    const rows = readAuditRows(rootDir);
    assert.deepEqual(rows.map((row) => row.at), [
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:05:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    assert.deepEqual(rows.map((row) => row.kind), ['resume-start', 'resume-complete', 'failover']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
