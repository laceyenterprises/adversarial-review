import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertClaudeHealthAllowsSpawn,
  readClaudeHealthGate,
} from '../src/claude-health-gate.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function writeDegradedStatus(dir) {
  const statusPath = join(dir, 'status.json');
  writeFileSync(statusPath, JSON.stringify({
    observedAt: new Date().toISOString(),
    status: 'degraded',
    classifier: 'claude_oauth_expired',
    lastHealthyAt: '2026-05-10T17:00:00Z',
  }));
  return statusPath;
}

test('claude health gate pauses on fresh oauth-expired status', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-health-gate-'));
  const statusPath = writeDegradedStatus(root);
  const gate = readClaudeHealthGate({
    statusPath,
    now: () => new Date('2026-05-10T18:01:00Z'),
  });

  assert.equal(gate.paused, true);
  assert.throws(
    () => assertClaudeHealthAllowsSpawn({ statusPath, now: () => new Date('2026-05-10T18:01:00Z') }),
    /event=claude_health_paused/
  );
});

test('watcher reviewer gate pauses claude reviewer before subprocess', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-health-watcher-'));
  const statusPath = writeDegradedStatus(root);
  const gate = readClaudeHealthGate({ env: { CLAUDE_HEALTH_STATUS_PATH: statusPath } });

  assert.equal(gate.paused, true);
  assert.equal(gate.classifier, 'claude_oauth_expired');
});

test('follow-up claude-code remediation gate pauses before subprocess', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-health-followup-'));
  const statusPath = writeDegradedStatus(root);

  assert.throws(
    () => assertClaudeHealthAllowsSpawn({ env: { CLAUDE_HEALTH_STATUS_PATH: statusPath } }),
    /event=claude_health_paused/
  );
});

test('claude-code HQ adapter pauses before worker spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-health-adapter-'));
  const statusPath = writeDegradedStatus(root);
  const workspace = join(root, 'workspace');
  const logDir = join(root, 'hq', 'workers', 'worker-1', 'logs');
  const binDir = join(root, 'bin');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const promptPath = join(root, 'prompt.md');
  writeFileSync(promptPath, 'do work\n');
  const fakeClaude = join(binDir, 'claude');
  writeFileSync(fakeClaude, '#!/usr/bin/env bash\necho should-not-run\n');
  spawnSync('/bin/chmod', ['755', fakeClaude]);

  const adapter = resolve(REPO_ROOT, 'modules', 'worker-pool', 'lib', 'adapters', 'claude-code.sh');
  const payload = JSON.stringify({
    runId: 'run-test',
    workspacePath: workspace,
    promptPath,
    logDir,
    workerId: 'worker-1',
    ticketRef: 'LAC-520',
    ownerUser: '',
    spawnToken: 'token',
  });
  const result = spawnSync('/bin/bash', [adapter, 'spawn'], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: root,
      CLAUDE_HEALTH_STATUS_PATH: statusPath,
    },
  });

  assert.equal(result.status, 75);
  assert.match(result.stderr, /event=claude_health_paused/);
});
