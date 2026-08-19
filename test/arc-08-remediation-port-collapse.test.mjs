// ARC-08 — Unify remediation dispatch through the AgentRuntime port.
//
// These tests pin the three ticket-mandated invariants that the giant
// end-to-end suites in follow-up-remediation.test.mjs don't isolate:
//   1. the two forked dispatch paths are gone (grep gate proves absence);
//   2. the health router — not the env fork — selects os vs local, while a
//      job that already claimed a path stays on it (SPEC §6.3);
//   3. remediator worker-class selection is a role-registry default that the
//      domain (builder-tag) can override, with a documented codex fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync as readTextFileSync } from 'node:fs';

import * as remediation from '../src/follow-up-remediation.mjs';
import {
  createRemediationRuntime,
  resolveRemediationRuntimeMode,
  resolveRemediationDispatchPathForJob,
  resolveRoleRegistryRemediator,
} from '../src/follow-up-remediation.mjs';
import { DEFAULT_ROLE_TOP_PATH } from '../src/role-config.mjs';

const SRC_PATH = fileURLToPath(new URL('../src/follow-up-remediation.mjs', import.meta.url));
const SRC = readFileSync(SRC_PATH, 'utf8');
const CLAUDE_LEAF_PATH = fileURLToPath(new URL('../src/remediation-claude-code-worker.mjs', import.meta.url));
const CLAUDE_LEAF_SRC = readTextFileSync(CLAUDE_LEAF_PATH, 'utf8');

// ── 1. Grep gate: the forked-path selectors are deleted ────────────────────

test('grep gate: the forked-path selector functions are deleted', () => {
  // The env-only fork predicate and the self-spawn switch dispatcher are the
  // two functions the collapse removes. Their definitions must be gone.
  assert.doesNotMatch(SRC, /function\s+shouldDispatchRemediationViaHq\b/);
  assert.doesNotMatch(SRC, /function\s+spawnRemediationWorker\b/);
  // …and they must not survive as re-exports either.
  assert.equal(remediation.shouldDispatchRemediationViaHq, undefined);
  assert.equal(remediation.spawnRemediationWorker, undefined);
});

test('grep gate: consume dispatches through one port call, not the hq-vs-spawn fork', () => {
  // The old fork was `hqDispatchEnabled ? await dispatchRemediationViaHq(...) :
  // spawnRemediationWorker(...)`. Neither branch of that ternary may remain.
  assert.doesNotMatch(SRC, /\?\s*await\s+dispatchRemediationViaHq\(/);
  assert.doesNotMatch(SRC, /:\s*spawnRemediationWorker\(/);
  // The collapse routes every remediation through the runtime facade.
  assert.match(SRC, /remediationRuntime\.run\(/);
  assert.equal(typeof createRemediationRuntime, 'function');
});

test('grep gate: remediation surfaces no longer import direct spawnDetachedCli', () => {
  assert.doesNotMatch(SRC, /\bspawnDetachedCli\b/);
  assert.doesNotMatch(CLAUDE_LEAF_SRC, /\bspawnDetachedCli\b/);
});

// ── 2. Health-router-driven mode selection + stickiness ────────────────────

test('resolveRemediationRuntimeMode: a fresh job takes the live health-router mode', () => {
  const freshJob = { jobId: 'job-1', remediationPlan: {} };
  assert.equal(
    resolveRemediationRuntimeMode(freshJob, { healthRouter: { getMode: () => 'os' } }),
    'os',
  );
  assert.equal(
    resolveRemediationRuntimeMode(freshJob, { healthRouter: { getMode: () => 'local' } }),
    'local',
  );
});

test('resolveRemediationRuntimeMode: a claimed path is sticky and overrides the router (SPEC §6.3)', () => {
  // A job mid-flight on the hq path must reconcile on hq even after the router
  // has failed over to local — no mid-run migration.
  const hqJob = { remediationPlan: { dispatchPath: 'hq' } };
  assert.equal(
    resolveRemediationRuntimeMode(hqJob, { healthRouter: { getMode: () => 'local' } }),
    'os',
  );
  // …and a bare job stays local even when the router is healthy.
  const bareJob = { remediationPlan: { dispatchPath: 'bare' } };
  assert.equal(
    resolveRemediationRuntimeMode(bareJob, { healthRouter: { getMode: () => 'os' } }),
    'local',
  );
  // Legacy jobs (pre-dispatchPath field) infer stickiness from worker fields.
  const legacyHqJob = { remediationWorker: { dispatchId: 'd1' } };
  assert.equal(
    resolveRemediationRuntimeMode(legacyHqJob, { healthRouter: { getMode: () => 'local' } }),
    'os',
  );
});

test('resolveRemediationRuntimeMode: no router falls back to the config-derived path (v1 parity)', () => {
  const freshJob = { remediationPlan: {} };
  // Deterministic true branch of the config predicate.
  assert.equal(
    resolveRemediationRuntimeMode(freshJob, { env: { ADV_WITH_HQ_INTEGRATION: '1' } }),
    'os',
  );
  // The fallback maps 1:1 onto the retained v1 dispatch-path resolver.
  assert.equal(
    resolveRemediationDispatchPathForJob(freshJob, { ADV_WITH_HQ_INTEGRATION: '1' }),
    'hq',
  );
});

// ── 3. Role-registry default with a domain override ────────────────────────

test('resolveRoleRegistryRemediator: reads the registry default, falls back to codex', () => {
  // Registry absent (today's strict schema omits roles.registry) → documented
  // codex fallback.
  const codexFallbackLoader = () => ({ get: (_key, def) => def });
  assert.equal(
    resolveRoleRegistryRemediator({ env: {}, loaderImpl: codexFallbackLoader }),
    'codex',
  );

  // Registry present → the pinned class is honored (and normalized).
  let observedTopPath = null;
  const registryLoader = ({ topPath } = {}) => {
    observedTopPath = topPath;
    return {
      get: (key, def) => (key === 'roles.registry.remediator.workerClass' ? 'gemini' : def),
    };
  };
  assert.equal(
    resolveRoleRegistryRemediator({ env: {}, loaderImpl: registryLoader }),
    'gemini',
  );
  assert.equal(observedTopPath, DEFAULT_ROLE_TOP_PATH);
});

test('pickRemediationWorkerClass: explicit config topPath keeps domain lookup on bundled root', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'arc-08-domain-remediator-'));
  try {
    const topPath = join(rootDir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n', 'utf8');
    const registryLoader = () => ({
      get: (key, def) => (key === 'roles.remediator' ? 'adversarial' : def),
      getOrchestrationMode: () => 'native',
    });

    assert.equal(
      remediation.pickRemediationWorkerClass(
        { domainId: 'code-pr' },
        { env: {}, topPath, loaderImpl: registryLoader },
      ),
      'codex',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('pickRemediationWorkerClass: builder-tag domain override beats the registry default', () => {
  const registryLoader = () => ({
    // No operator pin (roles.remediator → 'adversarial' means "unset"), but the
    // registry default would resolve to gemini.
    get: (key, def) => {
      if (key === 'roles.remediator') return 'adversarial';
      if (key === 'roles.registry.remediator.workerClass') return 'gemini';
      return def;
    },
    getOrchestrationMode: () => 'native',
  });
  // A codex-built PR routes remediation to the opposite model (domain override),
  // not the registry default.
  assert.equal(
    remediation.pickRemediationWorkerClass({ builderTag: 'codex' }, { env: {}, loaderImpl: registryLoader }),
    'claude-code',
  );
  // With no builder tag, the registry default wins.
  assert.equal(
    remediation.pickRemediationWorkerClass({}, { env: {}, loaderImpl: registryLoader }),
    'gemini',
  );
});

test('resolveRemediationRuntimeMode pins os-mode for a claude-code remediator (bare cannot auth the claude CLI, #5546)', () => {
  // A claude-code remediation only authenticates via the os/hq-dispatch broker
  // path; bare/local leaves the claude CLI "Not logged in". So os-mode is forced
  // for claude-code even when the health router is local or the job is sticky-bare.
  assert.equal(
    resolveRemediationRuntimeMode({}, { workerClass: 'claude-code', healthRouter: { getMode: () => 'local' } }),
    'os',
  );
  assert.equal(resolveRemediationRuntimeMode({}, { workerClass: 'claude-code' }), 'os');
  // codex is unaffected -- it spawns fine in bare mode via its native ~/.codex auth.
  assert.equal(
    resolveRemediationRuntimeMode({}, { workerClass: 'codex', healthRouter: { getMode: () => 'local' } }),
    'local',
  );
});
