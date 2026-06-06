// CFG-02 cascade tests for the file→env resolution order across role
// pins. Each test exercises the SPEC §3 precedence chain (module → top →
// env) and the SPEC §10.1 / §10.2 alias rules. The fixtures use synthetic
// config.yaml files in a tmpdir so the tests are hermetic against the
// host's real ~/agent-os/config.yaml.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadRoleConfig,
  resolveDefaultMergeAgentWorkerClass,
  resolveDefaultRemediator,
  resolveDefaultReviewer,
  validateStartupRoleConfig,
} from '../src/role-config.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'cfg-02-cascade-'));
}

function writeYaml(path, body) {
  writeFileSync(path, body, { encoding: 'utf8' });
}

const REVIEWER_ROUTE_BY_MODEL = {
  claude: { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
  codex: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
  gemini: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
  pi: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
  opencode: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
  hermes: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
};

// ── §3 precedence: module file → env override ───────────────────────────

test('CFG-02 remediator: module file value with no env returns module value', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');
    const cfg = loadRoleConfig({
      env: {},
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.remediator'), 'codex');
    const trace = cfg.resolutionTrace('roles.remediator');
    assert.ok(trace[trace.length - 1].source.startsWith('module:'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 remediator: env override beats module file (canonical env)', async () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');
    const cfg = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.remediator'), 'claude-code');
    const trace = cfg.resolutionTrace('roles.remediator');
    assert.equal(trace[trace.length - 1].source, 'env:AGENT_OS_ROLES_REMEDIATOR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 remediator: legacy env alias honored when canonical unset', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');
    const cfg = loadRoleConfig({
      env: {
        ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.remediator'), 'claude-code');
    const trace = cfg.resolutionTrace('roles.remediator');
    assert.equal(trace[trace.length - 1].source, 'env:ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 remediator: canonical + legacy env conflict fails loud (§10.1)', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');
    assert.throws(
      () => loadRoleConfig({
        env: {
          AGENT_OS_ROLES_REMEDIATOR: 'claude-code',
          ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: 'codex',
          AGENT_OS_CONFIG_PATH: '/dev/null',
        },
        topPath: '/dev/null',
        modulePaths: [modulePath],
      }),
      (err) => {
        assert.match(err.message, /AGENT_OS_ROLES_REMEDIATOR/);
        assert.match(err.message, /ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR/);
        assert.match(err.message, /conflict/i);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── §3 precedence: top-level beats module ───────────────────────────────

test('CFG-02 remediator: top-level beats module on canonical key', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const topPath = join(tmp, 'top.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');
    writeYaml(topPath, 'version: 1\nroles:\n  remediator: claude-code\n');
    const cfg = loadRoleConfig({
      env: {},
      topPath,
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.remediator'), 'claude-code');
    const trace = cfg.resolutionTrace('roles.remediator');
    assert.equal(trace[trace.length - 1].source, 'top');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── §10.3 enum violation: fails loud at startup with key+value+allowed set ──

test('CFG-02 schema invalid (unknown-reviewer) fails loud with key and allowed set', () => {
  const tmp = makeTmp();
  try {
    const topPath = join(tmp, 'top.yaml');
    writeYaml(topPath, 'version: 1\nroles:\n  reviewer: unknown-reviewer\n');
    assert.throws(
      () => validateStartupRoleConfig({
        env: { AGENT_OS_CONFIG_PATH: topPath },
        topPath,
        modulePaths: [],
      }),
      (err) => {
        assert.match(err.message, /roles\.reviewer/);
        assert.match(err.message, /unknown-reviewer/);
        assert.match(err.message, /claude-code|codex|adversarial|gemini|pi|opencode|hermes/);
        // The loader includes the source `path:line` on the error object.
        assert.ok(typeof err.source === 'string' && err.source.includes(topPath));
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── §10.2 merge-agent: top-level alias overrides module (canonical-key form) ──

test('CFG-02 merge-agent: module-only worker_class returns module value', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(
      modulePath,
      '__aliases:\n  merge_agent.worker_class: roles.merge_agent_worker_class\nmerge_agent:\n  worker_class: codex\n',
    );
    const cfg = loadRoleConfig({
      env: {},
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'codex');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 merge-agent: top-level roles.merge_agent_worker_class beats module merge_agent.worker_class via __aliases', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const topPath = join(tmp, 'top.yaml');
    writeYaml(
      modulePath,
      '__aliases:\n  merge_agent.worker_class: roles.merge_agent_worker_class\nmerge_agent:\n  worker_class: codex\n',
    );
    writeYaml(
      topPath,
      'version: 1\nroles:\n  merge_agent_worker_class: claude-code\n',
    );
    const cfg = loadRoleConfig({
      env: {},
      topPath,
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'claude-code');
    const trace = cfg.resolutionTrace('roles.merge_agent_worker_class');
    assert.equal(trace[trace.length - 1].source, 'top');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 merge-agent: env override wins over top-level + module (canonical env)', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const topPath = join(tmp, 'top.yaml');
    writeYaml(
      modulePath,
      '__aliases:\n  merge_agent.worker_class: roles.merge_agent_worker_class\nmerge_agent:\n  worker_class: codex\n',
    );
    writeYaml(
      topPath,
      'version: 1\nroles:\n  merge_agent_worker_class: claude-code\n',
    );
    const cfg = loadRoleConfig({
      env: { AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS: 'merge-agent' },
      topPath,
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'merge-agent');
    const trace = cfg.resolutionTrace('roles.merge_agent_worker_class');
    assert.equal(trace[trace.length - 1].source, 'env:AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 merge-agent: env override wins over top-level + module (legacy env)', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const topPath = join(tmp, 'top.yaml');
    writeYaml(
      modulePath,
      '__aliases:\n  merge_agent.worker_class: roles.merge_agent_worker_class\nmerge_agent:\n  worker_class: codex\n',
    );
    writeYaml(
      topPath,
      'version: 1\nroles:\n  merge_agent_worker_class: claude-code\n',
    );
    const cfg = loadRoleConfig({
      env: { ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS: 'merge-agent' },
      topPath,
      modulePaths: [modulePath],
    });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'merge-agent');
    const trace = cfg.resolutionTrace('roles.merge_agent_worker_class');
    assert.equal(
      trace[trace.length - 1].source,
      'env:ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── resolver wrappers: end-to-end ──────────────────────────────────────

test('CFG-02 resolveDefaultRemediator returns null for adversarial default', () => {
  // No env, no top file, module config defaults to `adversarial` — which is
  // the "no pin, use per-tag routing" sentinel. The resolver maps it to null.
  assert.equal(
    resolveDefaultRemediator({
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      topPath: '/dev/null',
    }),
    null,
  );
});

test('CFG-02 resolveDefaultReviewer returns null for adversarial default', () => {
  assert.equal(
    resolveDefaultReviewer({
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      topPath: '/dev/null',
      reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
    }),
    null,
  );
});

test('CFG-02 resolveDefaultMergeAgentWorkerClass returns merge-agent default', () => {
  assert.equal(
    resolveDefaultMergeAgentWorkerClass({
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      topPath: '/dev/null',
    }),
    'merge-agent',
  );
});

test('CFG-02 resolveDefaultReviewer normalizes claude-code → claude family for route lookup', () => {
  const tmp = makeTmp();
  try {
    const topPath = join(tmp, 'top.yaml');
    writeYaml(topPath, 'version: 1\nroles:\n  reviewer: claude-code\n');
    const route = resolveDefaultReviewer({
      env: {},
      topPath,
      modulePaths: [],
      reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
    });
    assert.deepEqual(route, REVIEWER_ROUTE_BY_MODEL.claude);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 resolveDefaultReviewer handles legacy `claude` value (normalized to claude-code)', () => {
  const tmp = makeTmp();
  try {
    const topPath = join(tmp, 'top.yaml');
    writeYaml(topPath, 'version: 1\nroles:\n  reviewer: claude\n');
    const route = resolveDefaultReviewer({
      env: {},
      topPath,
      modulePaths: [],
      reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
    });
    assert.deepEqual(route, REVIEWER_ROUTE_BY_MODEL.claude);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CFG-02 resolveDefaultReviewer accepts MHX-09 reviewer worker classes', () => {
  const tmp = makeTmp();
  try {
    const topPath = join(tmp, 'top.yaml');
    writeYaml(topPath, 'version: 1\nroles:\n  reviewer: opencode\n');
    const route = resolveDefaultReviewer({
      env: {},
      topPath,
      modulePaths: [],
      reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
    });
    assert.deepEqual(route, REVIEWER_ROUTE_BY_MODEL.opencode);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
