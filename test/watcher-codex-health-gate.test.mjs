import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  codexSpawningPauseDecision,
  logCodexHealthPause,
} from '../src/codex-health-gate.mjs';

test('watcher codex health gate pauses on fresh oauth degraded status', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'codex-health-gate-'));
  try {
    const statusPath = path.join(hqRoot, 'codex-health', 'status.json');
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify({
      observedAt: '2026-05-10T17:00:00Z',
      status: 'degraded',
      classifier: 'codex_oauth_refresh_failed',
      lastHealthyAt: '2026-05-10T11:00:00Z',
    }));

    const decision = codexSpawningPauseDecision({
      env: { HQ_ROOT: hqRoot },
      nowMs: Date.parse('2026-05-10T17:03:00Z'),
    });

    assert.equal(decision.pause, true);
    assert.equal(decision.classifier, 'codex_oauth_refresh_failed');
    assert.equal(decision.lastHealthyAt, '2026-05-10T11:00:00Z');

    const lines = [];
    logCodexHealthPause({ log: (line) => lines.push(line) }, decision, {
      repo: 'laceyenterprises/agent-os',
      prNumber: 516,
      site: 'watcher',
    });
    assert.match(lines[0], /event=codex_health_paused/);
    assert.match(lines[0], /classifier=codex_oauth_refresh_failed/);
    assert.match(lines[0], /lastHealthyAt=2026-05-10T11:00:00Z/);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('watcher codex health gate ignores stale degraded status', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'codex-health-gate-'));
  try {
    const statusPath = path.join(hqRoot, 'codex-health', 'status.json');
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify({
      observedAt: '2026-05-10T17:00:00Z',
      status: 'degraded',
      classifier: 'codex_oauth_refresh_failed',
    }));

    const decision = codexSpawningPauseDecision({
      env: { HQ_ROOT: hqRoot },
      nowMs: Date.parse('2026-05-10T17:06:00Z'),
    });

    assert.equal(decision.pause, false);
    assert.equal(decision.reason, 'stale-status');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});
