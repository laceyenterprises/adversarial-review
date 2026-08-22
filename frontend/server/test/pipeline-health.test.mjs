/**
 * The `/pipeline/health` surface end to end (ARF-04): liveness probes, the
 * review-cycle burndown, and the assembled payload behind the route.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { buildReviewCycleBurndown } from '../src/governance/cycle-cap.mjs';
import { buildPipelineHealth } from '../src/governance/index.mjs';
import { probeDaemons } from '../src/governance/liveness.mjs';
import { handleRequest } from '../src/server.mjs';
import { openReviewStore } from '../src/store/review-store.mjs';

// `node:sqlite` for the one place a test writes a fixture counter row into the
// standalone store. The source tree itself only ever holds a read handle.
const require = createRequire(import.meta.url);

const roots = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'arf-pipeline-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const now = () => NOW;

/** A pipeline checkout with the merge-authority block ARF reads. */
function pipelineRoot({ enabled = true, autonomous = true, cap = 4, heartbeatAgeMs = 12_000 } = {}) {
  const root = workspace();
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'config.yaml'), [
    `review_cycle_cap: ${cap}`,
    'review_cycle_window_hours: 24',
    'roles:',
    '  adversarial:',
    '    merge_authority:',
    `      enabled: ${enabled}`,
    `      autonomous_merge_execution_enabled: ${autonomous}`,
    '      strict_mode: true',
    '      strict_non_blocking_remediation: true',
    '',
  ].join('\n'));
  if (heartbeatAgeMs !== null) {
    writeFileSync(join(root, 'data', 'watcher-heartbeat.json'),
      `${JSON.stringify({ schema_version: 1, watcher_pid: 1, updated_at: new Date(NOW - heartbeatAgeMs).toISOString() })}\n`);
  }
  return root;
}

function config(root, extra = {}) {
  return loadConfig({
    env: {
      ARF_MODE: 'standalone',
      ARF_STATE_ROOT: join(root, '.arf'),
      ARF_PIPELINE_ROOT: root,
      ...extra,
    },
    cwd: root,
  });
}

describe('daemon liveness probes', () => {
  it('reads a watcher heartbeat and calls a fresh one up', () => {
    const root = pipelineRoot({ heartbeatAgeMs: 12_000 });
    const probes = probeDaemons({
      sources: { watcher: { path: join(root, 'data/watcher-heartbeat.json') } },
      now,
    });
    assert.equal(probes.watcher.state, 'up');
    assert.equal(probes.watcher.ageMs, 12_000);
  });

  it('calls a heartbeat older than the threshold stale, not down', () => {
    // `launchd`-running is not liveness, and neither is a heartbeat file that
    // merely exists. Stale and down are different diagnoses.
    const root = pipelineRoot({ heartbeatAgeMs: 45 * 60 * 1000 });
    const probes = probeDaemons({
      sources: { watcher: { path: join(root, 'data/watcher-heartbeat.json') } },
      now,
    });
    assert.equal(probes.watcher.state, 'stale');
  });

  it('reports an unconfigured daemon as unknown, never as down', () => {
    const probes = probeDaemons({ sources: {}, now });
    assert.equal(probes.followUp.state, 'unknown');
    assert.equal(probes.autoMerge.state, 'unknown');
    assert.match(probes.autoMerge.reason, /no liveness source configured/);
  });

  it('reports a configured-but-absent heartbeat as down', () => {
    const probes = probeDaemons({
      sources: { autoMerge: { path: join(workspace(), 'nope.json') } },
      now,
    });
    assert.equal(probes.autoMerge.state, 'down');
  });

  it('stays unknown when a heartbeat file carries no timestamp it recognises', () => {
    // A probe pointed at the wrong field is a probe problem, not an outage.
    const root = workspace();
    const path = join(root, 'beat.json');
    writeFileSync(path, JSON.stringify({ alive: true }));
    const probes = probeDaemons({ sources: { watcher: { path } }, now });
    assert.equal(probes.watcher.state, 'unknown');
    assert.match(probes.watcher.reason, /no recognised timestamp field/);
  });

  it('supports an mtime probe for a daemon that only touches a file', () => {
    const root = workspace();
    const path = join(root, 'touch');
    writeFileSync(path, '');
    const seconds = (NOW - 5_000) / 1000;
    utimesSync(path, seconds, seconds);
    const probes = probeDaemons({ sources: { autoMerge: { path, field: 'mtime' } }, now });
    assert.equal(probes.autoMerge.state, 'up');
  });
});

describe('review-cycle burndown', () => {
  const capKey = { known: true, value: 4, source: 'file' };
  const windowKey = { known: true, value: 24, source: 'file' };
  const cycle = (over) => ({
    prUrl: 'https://github.com/o/r/pull/1', repo: 'o/r', pr: 1, headSha: 'abc', headShaShort: 'abc',
    used: 2, lastVerdictAt: new Date(NOW - 60_000).toISOString(), escalatedAt: null, escalated: false,
    ...over,
  });

  it('pairs the store count with the configured cap', () => {
    const result = buildReviewCycleBurndown({ cycles: [cycle()], capKey, windowKey, now });
    assert.equal(result.cap, 4);
    assert.equal(result.rows[0].used, 2);
    assert.equal(result.rows[0].remaining, 2);
    assert.equal(result.rows[0].exhausted, false);
  });

  it('counts a spent budget inside the window as exhausted', () => {
    const result = buildReviewCycleBurndown({ cycles: [cycle({ used: 4 })], capKey, windowKey, now });
    assert.equal(result.rows[0].exhausted, true);
    assert.equal(result.exhaustedCount, 1);
  });

  it('does not call a spent budget exhausted once its window has lapsed', () => {
    // The pipeline restarts the count at 1 past the window, so the wall is gone.
    const lapsed = cycle({ used: 4, lastVerdictAt: new Date(NOW - 48 * 3600 * 1000).toISOString() });
    const result = buildReviewCycleBurndown({ cycles: [lapsed], capKey, windowKey, now });
    assert.equal(result.rows[0].windowExpired, true);
    assert.equal(result.rows[0].exhausted, false);
    assert.equal(result.exhaustedCount, 0);
  });

  it('honours an escalation stamp on its own evidence', () => {
    const escalated = cycle({ used: 1, escalatedAt: '2026-08-18T00:00:00Z', escalated: true });
    const result = buildReviewCycleBurndown({ cycles: [escalated], capKey, windowKey, now });
    assert.equal(result.rows[0].exhausted, true);
  });

  it('reports unknown rather than zero when the cap could not be read', () => {
    const result = buildReviewCycleBurndown({
      cycles: [cycle()],
      capKey: { known: false, value: null },
      windowKey,
      now,
    });
    assert.equal(result.cap, null);
    assert.equal(result.rows[0].remaining, null);
    assert.equal(result.rows[0].exhausted, null);
    assert.equal(result.unknownCount, 1);
  });
});

describe('the review store cycle projection', () => {
  it('projects counter rows and parses repo/pr back out of the pipeline pr_url', () => {
    const root = workspace();
    const cfg = config(root);
    const store = openReviewStore(cfg);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(cfg.storePath);
    db.prepare(`INSERT INTO review_cycle_counters
      (pr_url, head_sha, verdict_count, last_verdict_at, escalated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('https://github.com/laceyenterprises/agent-os/pull/5543', 'deadbeefcafe', 3,
        '2026-08-19T11:00:00Z', null);
    db.close();

    const result = store.reviewCycles();
    assert.equal(result.cycles.length, 1);
    assert.equal(result.cycles[0].repo, 'laceyenterprises/agent-os');
    assert.equal(result.cycles[0].pr, 5543);
    assert.equal(result.cycles[0].used, 3);
    assert.equal(result.cycles[0].headShaShort, 'deadbee');
    assert.equal(result.cycles[0].escalated, false);
  });

  it('degrades to an empty burndown on a store with no counter table', () => {
    const root = workspace();
    const cfg = config(root, { ARF_STORE_PATH: join(root, 'absent.db') });
    const store = openReviewStore({ ...cfg, mode: 'in-os', readOnly: true });
    assert.deepEqual(store.reviewCycles().cycles, []);
  });
});

describe('the assembled payload', () => {
  it('carries daemons, both paths, both keys, and the burndown', () => {
    const root = pipelineRoot({ enabled: true, autonomous: true, cap: 4 });
    const cfg = config(root);
    const health = buildPipelineHealth({ config: cfg, store: openReviewStore(cfg), now });

    assert.deepEqual(health.daemons.map((d) => d.id), ['watcher', 'followUp', 'autoMerge']);
    assert.equal(health.daemons.find((d) => d.id === 'watcher').state, 'up');

    assert.deepEqual(health.mergePaths.map((p) => p.id), ['hammer', 'daemon-clean', 'python-backstop']);
    assert.equal(health.mergePaths.find((p) => p.id === 'hammer').armed, true);
    assert.equal(health.mergePaths.find((p) => p.id === 'daemon-clean').armed, true);

    assert.equal(health.governance.keys.enabled.value, true);
    assert.equal(health.governance.keys.autonomousMergeExecutionEnabled.value, true);
    assert.equal(health.governance.keys.strictNonBlockingRemediation.value, true);
    assert.equal(health.reviewCycle.cap, 4);
    assert.equal(health.reviewCycle.windowHours, 24);
    assert.equal(health.stopState.state, 'merging-possible');
  });

  it('shows the daemon-clean path disarmed when only the execution switch is off', () => {
    const root = pipelineRoot({ enabled: true, autonomous: false });
    const cfg = config(root);
    const health = buildPipelineHealth({ config: cfg, store: openReviewStore(cfg), now });
    const daemonClean = health.mergePaths.find((path) => path.id === 'daemon-clean');
    assert.equal(daemonClean.state, 'disarmed');
    assert.equal(health.governance.keys.enabled.value, true);
    assert.equal(health.governance.keys.autonomousMergeExecutionEnabled.value, false);
    // Not a stop: the watcher is up and caches config at boot.
    assert.equal(health.stopState.state, 'unknown');
  });

  it('reports the config layers it actually read', () => {
    const root = pipelineRoot();
    const cfg = config(root);
    const health = buildPipelineHealth({ config: cfg, store: openReviewStore(cfg), now });
    const read = health.governance.sources.filter((source) => source.readable);
    assert.equal(read.length, 1);
    assert.equal(read[0].path, join(root, 'config.yaml'));
    assert.ok(health.governance.configChangedAt);
  });

  it('degrades to unknown, never to stopped, with no pipeline present at all', () => {
    const root = workspace();
    const cfg = config(root);
    const health = buildPipelineHealth({ config: cfg, store: openReviewStore(cfg), now });
    assert.equal(health.governance.anySourceReadable, false);
    for (const path of health.mergePaths) {
      assert.notEqual(path.effective.state, 'stopped');
    }
    assert.equal(health.stopState.state, 'unknown');
  });
});

describe('the pipeline config section', () => {
  it('derives the four governance layers in the pipeline loader order', () => {
    const root = workspace();
    const { configFiles } = config(root).pipeline;
    assert.deepEqual(configFiles.map((file) => file.path), [
      join(root, 'config.yaml'),
      join(root, 'config.local.yaml'),
    ]);
  });

  it('lets the environment replace the layer list wholesale', () => {
    const root = workspace();
    const cfg = config(root, { ARF_PIPELINE_CONFIG_FILES: `${join(root, 'a.yaml')}:${join(root, 'b.yaml')}` });
    assert.deepEqual(cfg.pipeline.configFiles.map((file) => file.path), [
      join(root, 'a.yaml'), join(root, 'b.yaml'),
    ]);
    assert.equal(cfg.pipeline.configFilesSource, 'configured');
  });

  it('probes only the watcher by default, leaving the others unsourced', () => {
    const cfg = config(workspace());
    assert.ok(cfg.pipeline.heartbeats.watcher.path.endsWith('watcher-heartbeat.json'));
    assert.equal(cfg.pipeline.heartbeats.followUp, null);
    assert.equal(cfg.pipeline.heartbeats.autoMerge, null);
  });

  it('refuses an unknown key rather than silently keeping a default', () => {
    // A `heartbeatStaleMS` typo that kept the default would render a stalled
    // watcher as `up`, which is the one thing a liveness readout must not do.
    const root = workspace();
    const configFile = join(root, 'arf.json');
    writeFileSync(configFile, JSON.stringify({ pipeline: { heartbeatStaleMS: 1000 } }));
    assert.throws(
      () => loadConfig({ env: { ARF_CONFIG_FILE: configFile, ARF_STATE_ROOT: root }, cwd: root }),
      /unknown key "heartbeatStaleMS"/,
    );
  });

  it('refuses an unknown daemon id and a non-positive stale threshold', () => {
    const root = workspace();
    const bad = (pipeline) => {
      const configFile = join(root, `arf-${Math.abs(JSON.stringify(pipeline).length)}.json`);
      writeFileSync(configFile, JSON.stringify({ pipeline }));
      return () => loadConfig({ env: { ARF_CONFIG_FILE: configFile, ARF_STATE_ROOT: root }, cwd: root });
    };
    assert.throws(bad({ heartbeats: { watchr: '/tmp/x' } }), /unknown daemon "watchr"/);
    assert.throws(bad({ heartbeatStaleMs: 0 }), /must be a positive number/);
  });
});

describe('the /pipeline routes', () => {
  function response() {
    const res = {
      statusCode: null, headers: null, body: '', headersSent: false,
      writeHead(status, headers) { res.statusCode = status; res.headers = headers; res.headersSent = true; },
      end(chunk) { res.body = chunk ?? ''; },
    };
    return res;
  }

  async function get(path, cfg) {
    const res = response();
    await handleRequest(
      { config: cfg, store: openReviewStore(cfg), mirror: null, startedAt: 0 },
      { method: 'GET', url: path },
      res,
    );
    return res;
  }

  it('answers /pipeline/health with the payload, uncached', async () => {
    const cfg = config(pipelineRoot({ enabled: true, autonomous: false }));
    const res = await get('/pipeline/health', cfg);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.equal(body.mergePaths.length, 3);
    assert.equal(body.governance.keys.autonomousMergeExecutionEnabled.value, false);
  });

  it('answers /pipeline/health 200 even when nothing is configured', async () => {
    // A 503 here would take the panel dark exactly when an operator is trying
    // to find out whether merges stopped.
    const res = await get('/pipeline/health', config(workspace()));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).stopState.state, 'unknown');
  });

  it('renders /pipeline/panel as HTML naming both paths and both keys', async () => {
    const res = await get('/pipeline/panel', config(pipelineRoot({ enabled: true, autonomous: false })));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /data-path="hammer"/);
    assert.match(res.body, /data-path="daemon-clean"/);
    assert.match(res.body, /roles\.adversarial\.merge_authority\.enabled/);
    assert.match(res.body, /roles\.adversarial\.merge_authority\.autonomous_merge_execution_enabled/);
  });
});
