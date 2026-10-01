import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDagAutowalk, collectDagAutowalkHealth } from '../src/dag-autowalk-health.mjs';
import { collectReviewPipelineHealth, renderReviewPipelinePrometheus } from '../src/review-pipeline-health.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nowMs = Date.parse('2026-10-01T02:00:00Z');
const options = { owner: 'airlock', nowMs, thresholdMs: 3600000 };
const healthy = { id: 'dag-autowalk', owner: 'airlock', owned: true, enabled: true,
  state: 'green-idle', rawState: 'scheduled', staleness: { state: 'fresh' },
  lastGreenAt: '2026-10-01T01:55:00Z', lastFinishedAt: '2026-10-01T01:55:00Z', lastExitCode: 0 };

test('completed fresh OJO progress is healthy despite a retired timer', () => {
  assert.equal(classifyDagAutowalk(healthy, options).healthy, true);
});
test('fresh scheduler does not mask timeout or nonprogress', () => {
  assert.equal(classifyDagAutowalk({ ...healthy, state: 'failing', lastExitCode: 124 }, options).reason, 'timeout');
  assert.equal(classifyDagAutowalk({ ...healthy, lastGreenAt: '2026-09-30T23:00:00Z' }, options).reason, 'nonprogress');
  assert.equal(classifyDagAutowalk({ ...healthy, lastFailedAt: '2026-10-01T01:59:00Z', lastExitCode: 1 }, options).healthy, false);
});
test('queued job and active singleton are inconclusive, not completed progress', () => {
  for (const state of ['queued', 'running', 'acting']) {
    const result = classifyDagAutowalk({ ...healthy, state, rawState: state,
      lastStartedAt: '2026-10-01T01:59:00Z' }, options);
    assert.equal(result.healthy, null);
    assert.equal(result.reason, 'in-flight-progress-unverified');
  }
  assert.equal(classifyDagAutowalk({ ...healthy, state: 'running', lastStartedAt: '2026-09-30T23:00:00Z' }, options).healthy, false);
});
test('singleflight warnings and a reset last-green alone are inconclusive', () => {
  assert.equal(classifyDagAutowalk({ ...healthy, lastWarnAt: '2026-10-01T01:59:00Z' }, options).healthy, null);
  assert.equal(classifyDagAutowalk({ ...healthy, lastFinishedAt: null }, options).healthy, null);
});
test('missing, mismatched, malformed and inaccessible OJO evidence fails inconclusive', () => {
  for (const job of [null, {}, { ...healthy, owner: 'placey' }, { ...healthy, lastGreenAt: 'tomorrow' },
    { ...healthy, lastGreenAt: '2027-01-01T00:00:00Z' }, { ...healthy, staleness: { state: 'ledger-error' } }]) {
    assert.equal(classifyDagAutowalk(job, options).healthy, null);
  }
  const result = collectDagAutowalkHealth({ ...options, execFileSyncImpl: () => { throw new Error('secret-marker'); } });
  assert.equal(result.reason, 'ojo-unavailable');
  assert.ok(!JSON.stringify(result).includes('secret-marker'));
});
test('collector never probes the retired timer; OJO blindness stays distinct in findings and metrics', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'alr07-'));
  try {
    for (const accessible of [true, false]) {
      const snapshot = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir,
        env: { USER: 'airlock' }, now: () => new Date(nowMs),
        config: { hostChecksEnabled: true, conflictingPrChecksEnabled: false },
        execFileSyncImpl: (bin, args, opts) => {
          if (bin === 'hq') {
            assert.deepEqual(args, ['ojo', '--owners', 'airlock', 'job', 'dag-autowalk']);
            assert.equal(opts.timeout, 10000);
            if (!accessible) throw new Error('unreachable');
            return JSON.stringify({ job: healthy, owners: [{ owner: 'airlock', ok: true }] });
          }
          assert.ok(!args.join(' ').includes('dag-autowalk'));
          return 'state = running';
        },
      });
      assert.equal(snapshot.dagAutowalk.healthy, accessible ? true : null);
      assert.equal(snapshot.findings.some((f) => f.code === 'review:dag_autowalk_inconclusive'), !accessible);
      assert.ok(snapshot.findings.every((f) => f.tier !== 'page'));
      if (!accessible) assert.match(renderReviewPipelinePrometheus(snapshot), /review_pipeline_dag_autowalk_healthy NaN/);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('changing diagnostics and timestamps keeps the autowalk root identity and never adds a page', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'alr07-identity-'));
  try {
    const findings = [];
    for (const inaccessible of [false, true]) {
      const snapshot = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir,
        env: { USER: 'airlock' }, now: () => new Date(nowMs + (inaccessible ? 60000 : 0)),
        config: { hostChecksEnabled: true },
        execFileSyncImpl: (bin) => {
          if (bin !== 'hq') return 'state = running';
          if (inaccessible) throw new Error('sensor unavailable');
          return JSON.stringify({ owners: [{ owner: 'airlock', ok: true }],
            job: { ...healthy, state: 'failing', lastExitCode: 124 } });
        },
      });
      findings.push(snapshot.findings.find((f) => f.code.startsWith('review:dag_autowalk_')));
      assert.ok(snapshot.findings.every((f) => f.tier !== 'page'));
    }
    assert.equal(findings[0].incident_key, findings[1].incident_key);
    assert.notEqual(findings[0].code, findings[1].code);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
