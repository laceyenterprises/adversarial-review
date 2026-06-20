// Conformance test suite for `config-loader.mjs`.
//
// Each test case maps to a row in the agent-os repo's
// `projects/cfg/LOADER-CONTRACT.md` §8 and mirrors the Python loader's
// `tests/test_loader.py` one-to-one.
//
// Run from inside this submodule: `node --test test/config-loader.test.mjs`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentOSConfig,
  AgentOSConfigError,
  loadConfig,
  validateSchema,
  SCHEMA_VERSION,
  getConfig,
  loadConfigCached,
  resetConfigCache,
} from '../src/config-loader.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_CONFIG_PATH = join(REPO_ROOT, 'config.yaml');
const FALLBACK_ROLE_CLASSES = [
  'claude-code',
  'codex',
  'claude-reviewer-lacey',
  'codex-reviewer-lacey',
  'merge-agent',
  'merge-agent-failure-recovery',
  'clio-agent',
];
const RETENTION_DEFAULTS = {
  policies: {
    standard_backup: {
      daily: 7,
      weekly: 4,
      monthly: 3,
    },
  },
  cadence: {
    weekly_day_of_week: 0,
    monthly_day_of_month: 1,
  },
  surfaces: {
    postgres_backups: {
      policy: 'standard_backup',
    },
  },
  ephemeral: {
    worker_worktrees_keep_hours: 168,
    worker_worktrees_per_run_limit: 200,
    follow_up_workspaces_keep_hours: 72,
    acpx_sessions_keep_days: 30,
    acpx_sessions_gib_cap: 10.0,
    acpx_sessions_min_idle_minutes: 60,
    openclaw_sessions_keep_days: 30,
    openclaw_sessions_min_idle_minutes: 60,
    claude_code_sessions_keep_days: 90,
    dispatch_audit_keep_days: 365,
  },
  sentinel: {
    disk_headroom: {
      threshold_pct: 85,
      threshold_pct_critical: 95,
      threshold_gib_free: 10,
      threshold_gib_free_critical: 2,
      page_dedupe_seconds: 3600,
    },
  },
};

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'cfg-loader-'));
}

function dedent(s) {
  const lines = s.replace(/^\n/, '').split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.match(/^[ \t]*/)[0].length;
    if (m < min) min = m;
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

function writeFile(path, contents) {
  writeFileSync(path, dedent(contents), { encoding: 'utf8' });
}

// -------- §1 + §8 rows 1-4, 12-14 ------------------------------------------

test('missing file returns defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'adversarial');
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'merge-agent');
    assert.equal(
      cfg.get('governance.emergency_stop_path'),
      '~/.agent-os/governance/emergency-stop',
    );
    assert.equal(cfg.get('roots.hq'), null);
    assert.equal(cfg.get('host.name'), null);
    assert.equal(cfg.get('host.tailscale_hostname'), null);
    assert.equal(cfg.get('tailscale.workstation_ip'), null);
    assert.equal(cfg.get('tailscale.daily_driver_ip'), null);
    assert.equal(cfg.get('tailscale.ipad_ip'), null);
    assert.equal(cfg.get('tailscale.iphone_ip'), null);
    assert.equal(cfg.get('launchd.label_prefix'), 'ai.laceyenterprises');
    assert.equal(cfg.get('session_ledger.database_name'), 'agent_os_ledger');
    assert.equal(cfg.get('operator.email'), 'virtualpaul@gmail.com');
    assert.equal(cfg.get('operator.full_name'), 'Paul Lacey');
    assert.equal(cfg.get('linear.team_name'), 'Laceyenterprises');
    assert.equal(cfg.get('linear.issue_prefix'), 'LAC');
    assert.equal(cfg.get('update.channel'), 'rolling');
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.compaction_rate_alarm_per_hour'), 3);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.compaction_rate_alarm_finding_dedupe_seconds'), 86400);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.token_budget_per_session'), 50000000);
    assert.deepEqual(cfg.get('agent_control.codex_runaway_guardrails.pr_class_additive_only_allowlist'), [
      'projects/*',
      'modules/worker-pool/post-merge-actions/*',
      'docs/POSTMORTEM-*.md',
      'docs/AUDIT-*.md',
    ]);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits'), 5);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats'), 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('update channel loads through strict Node schema and env override', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      update:
        channel: stable
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('update.channel'), 'stable');

    const envCfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_UPDATE_CHANNEL: 'pinned',
      },
    });
    assert.equal(envCfg.get('update.channel'), 'pinned');

    const bad = join(tmp, 'bad-update-channel.yaml');
    writeFile(bad, `
      version: 1
      update:
        channel: canary
    `);
    assert.throws(
      () => loadConfig({ topPath: bad, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'update.channel');
        assert.match(err.message, /not in allowlist/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('codex runaway guardrail vocabulary fatigue config resolves through strict schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      agent_control:
        codex_runaway_guardrails:
          vocabulary_fatigue_window_commits: 7
          vocabulary_fatigue_min_repeats: 4
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits'), 7);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats'), 4);

    const envCfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_TOKEN_BUDGET_PER_SESSION: '123456',
        AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_VOCABULARY_FATIGUE_WINDOW_COMMITS: '8',
        AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_VOCABULARY_FATIGUE_MIN_REPEATS: '5',
      },
    });
    assert.equal(envCfg.get('agent_control.codex_runaway_guardrails.token_budget_per_session'), 123456);
    assert.equal(envCfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits'), 8);
    assert.equal(envCfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats'), 5);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('codex runaway guardrail strict schema accepts Python-owned keys', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      agent_control:
        codex_runaway_guardrails:
          observed_repos:
            - laceyenterprises/agent-os
            - laceyenterprises/adversarial-review
          convergence_stall_commit_window_seconds: 1800
          convergence_stall_min_commits: 4
          convergence_stall_file_fetch_budget_per_cycle: 12
          convergence_stall_finding_dedupe_seconds: 600
          convergence_stall_repo_backoff_seconds: 30
          convergence_stall_observed_worker_classes:
            - codex
            - claude-code
          compaction_rate_alarm_per_hour: 7
          compaction_rate_alarm_finding_dedupe_seconds: 120
          token_budget_per_session: 200000
          pr_class_additive_only_allowlist:
            - projects/*
            - docs/AUDIT-*.md
          vocabulary_fatigue_window_commits: 7
          vocabulary_fatigue_min_repeats: 4
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.get('agent_control.codex_runaway_guardrails.observed_repos'), [
      'laceyenterprises/agent-os',
      'laceyenterprises/adversarial-review',
    ]);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_commit_window_seconds'), 1800);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_min_commits'), 4);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_file_fetch_budget_per_cycle'), 12);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_finding_dedupe_seconds'), 600);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_repo_backoff_seconds'), 30);
    assert.deepEqual(cfg.get('agent_control.codex_runaway_guardrails.convergence_stall_observed_worker_classes'), [
      'codex',
      'claude-code',
    ]);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.compaction_rate_alarm_per_hour'), 7);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.compaction_rate_alarm_finding_dedupe_seconds'), 120);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.token_budget_per_session'), 200000);
    assert.deepEqual(cfg.get('agent_control.codex_runaway_guardrails.pr_class_additive_only_allowlist'), [
      'projects/*',
      'docs/AUDIT-*.md',
    ]);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits'), 7);
    assert.equal(cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats'), 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('linear and session ledger env overrides resolve through cfg loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_LINEAR_TEAM_NAME: 'AcmeProduct',
        AGENT_OS_LINEAR_ISSUE_PREFIX: 'ACME',
        AGENT_OS_SESSION_LEDGER_DATABASE_NAME: 'acme_ledger',
      },
    });
    assert.equal(cfg.get('linear.team_name'), 'AcmeProduct');
    assert.equal(cfg.get('linear.issue_prefix'), 'ACME');
    assert.equal(cfg.get('session_ledger.database_name'), 'acme_ledger');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('linear issue prefix and session ledger database name reject invalid shapes', () => {
  const tmp = freshTmp();
  try {
    const badLinear = join(tmp, 'bad-linear.yaml');
    writeFile(badLinear, `
      version: 1
      linear:
        issue_prefix: acme
    `);
    assert.throws(
      () => loadConfig({ topPath: badLinear, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'linear.issue_prefix');
        assert.match(err.message, /Linear issue prefix/);
        return true;
      },
    );

    const badDatabase = join(tmp, 'bad-database.yaml');
    writeFile(badDatabase, `
      version: 1
      session_ledger:
        database_name: bad-name
    `);
    assert.throws(
      () => loadConfig({ topPath: badDatabase, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'session_ledger.database_name');
        assert.match(err.message, /SQL identifier/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('OSR-05 operator and workspace identity load through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      github:
        workspace_email_domain: cfg.example
      operator:
        email: operator@example.com
        full_name: Example Operator
      linear:
        team_name: ExampleTeam
        issue_prefix: EX
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('github.workspace_email_domain'), 'cfg.example');
    assert.equal(cfg.get('operator.email'), 'operator@example.com');
    assert.equal(cfg.get('operator.full_name'), 'Example Operator');
    assert.equal(cfg.get('linear.team_name'), 'ExampleTeam');
    assert.equal(cfg.get('linear.issue_prefix'), 'EX');

    const envCfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_GITHUB_WORKSPACE_EMAIL_DOMAIN: 'ops.example',
        AGENT_OS_OPERATOR_EMAIL: 'env-operator@example.com',
        AGENT_OS_OPERATOR_FULL_NAME: 'Env Operator',
        AGENT_OS_LINEAR_TEAM_NAME: 'EnvTeam',
      },
    });
    assert.equal(envCfg.get('github.workspace_email_domain'), 'ops.example');
    assert.equal(envCfg.get('operator.email'), 'env-operator@example.com');
    assert.equal(envCfg.get('operator.full_name'), 'Env Operator');
    assert.equal(envCfg.get('linear.team_name'), 'EnvTeam');
    assert.equal(
      envCfg.resolutionTrace('github.workspace_email_domain').at(-1).source,
      'env:AGENT_OS_GITHUB_WORKSPACE_EMAIL_DOMAIN',
    );
    assert.equal(
      envCfg.resolutionTrace('operator.email').at(-1).source,
      'env:AGENT_OS_OPERATOR_EMAIL',
    );
    assert.equal(
      envCfg.resolutionTrace('operator.full_name').at(-1).source,
      'env:AGENT_OS_OPERATOR_FULL_NAME',
    );
    assert.equal(
      envCfg.resolutionTrace('linear.team_name').at(-1).source,
      'env:AGENT_OS_LINEAR_TEAM_NAME',
    );

    const legacyEnvCfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_GITHUB_ORG_EMAIL_DOMAIN: 'legacy.example' },
    });
    assert.equal(legacyEnvCfg.get('github.workspace_email_domain'), 'legacy.example');
    assert.equal(
      legacyEnvCfg.resolutionTrace('github.workspace_email_domain').at(-1).source,
      'env:AGENT_OS_GITHUB_ORG_EMAIL_DOMAIN',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('OSR-05 operator and linear sections reject unknown keys', () => {
  const tmp = freshTmp();
  try {
    const badOperator = join(tmp, 'bad-operator.yaml');
    writeFile(badOperator, `
      version: 1
      operator:
        email: operator@example.com
        full_name: Example Operator
        handle: example
    `);
    assert.throws(
      () => loadConfig({ topPath: badOperator, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'operator.handle');
        assert.match(err.message, /unknown key/);
        return true;
      },
    );

    const badLinear = join(tmp, 'bad-linear-extra.yaml');
    writeFile(badLinear, `
      version: 1
      linear:
        team_name: ExampleTeam
        issue_prefix: EX
        project_slug: example
    `);
    assert.throws(
      () => loadConfig({ topPath: badLinear, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'linear.project_slug');
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('empty file returns defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFileSync(top, '', { encoding: 'utf8' });
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'adversarial');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('null top returns defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, '# nothing\n');
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'adversarial');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roots.hq from top-level resolves with trace', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /foo
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), '/foo');
    const trace = cfg.resolutionTrace('roots.hq');
    assert.deepEqual(trace.map((e) => e.source), ['code-default', 'top']);
    assert.equal(trace[trace.length - 1].value, '/foo');
    assert.ok(trace[trace.length - 1].path.endsWith('config.yaml'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roots runtime/admin users load through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        runtime_user: _runtime-agent
        admin_user: fork-admin
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.runtime_user'), '_runtime-agent');
    assert.equal(cfg.get('roots.admin_user'), 'fork-admin');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roots runtime/admin users reject invalid local username shapes', () => {
  const tmp = freshTmp();
  try {
    const cases = [
      ['runtime_user', "''"],
      ['runtime_user', "'   '"],
      ['runtime_user', 'bad/name'],
      ['admin_user', '-leading-dash'],
      ['admin_user', 'bad$user'],
    ];
    for (const [key, value] of cases) {
      const top = join(tmp, `bad-${key}-${value.replaceAll(/[^A-Za-z0-9_-]/g, '_')}.yaml`);
      writeFile(top, `
        version: 1
        roots:
          ${key}: ${value}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, `roots.${key}`);
          assert.match(err.message, /local username/);
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top overrides module on canonical key', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    const top = join(tmp, 'config.yaml');
    writeFile(mod, `
      roles:
        reviewer: codex
    `);
    writeFile(top, `
      version: 1
      roles:
        reviewer: claude-code
    `);
    const cfg = loadConfig({ topPath: top, modulePaths: [mod], env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
    const sources = cfg.resolutionTrace('roles.reviewer').map((e) => e.source);
    assert.equal(sources[0], 'code-default');
    assert.ok(sources[1].startsWith('module:'));
    assert.equal(sources[2], 'top');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level alias overrides module (LOADER-CONTRACT §4)', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    const top = join(tmp, 'config.yaml');
    writeFile(mod, `
      __aliases:
        merge_agent.worker_class: roles.merge_agent_worker_class
      merge_agent:
        worker_class: codex
    `);
    writeFile(top, `
      version: 1
      roles:
        merge_agent_worker_class: claude-code
    `);
    const cfg = loadConfig({ topPath: top, modulePaths: [mod], env: {} });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'claude-code');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('local.yaml overrides top', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      roots:
        hq: /from-local
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), '/from-local');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level config.yaml rejects an unknown nested worker_pool key (worker_pool is now a known partial mirror)', () => {
  // As of the deep-reconcile CFG knob (2026-06-19) `worker_pool` is a KNOWN
  // partial root in this reader (mirrors only dag.autowalk.deep_reconcile), no
  // longer a foreign top-level section. The canonical config.yaml stays strict,
  // so an unknown nested worker_pool key still fails loud.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      worker_pool:
        anything: true
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /worker_pool/);
        assert.match(err.message, /unknown key/);
        // source is now line-annotated (config.yaml:N) — a nested unknown-key
        // error rather than a whole-section foreign rejection.
        assert.ok(String(err.source).startsWith(top));
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level config.yaml accepts the mirrored worker_pool.dag.autowalk.deep_reconcile key', () => {
  // The point of the partial mirror: this key may be written to the shared
  // canonical config.yaml without crashing the adversarial watcher.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      worker_pool:
        dag:
          autowalk:
            deep_reconcile: true
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('worker_pool.dag.autowalk.deep_reconcile'), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('versioned config.local.yaml tolerates unknown nested worker_pool keys and reads the mirrored one', () => {
  // worker_pool is now a known partial root; in operator-local config.local.yaml
  // unknown nested worker_pool.* keys (dispatch/memory/etc., owned by the Python
  // CFG reader) are tolerated-dropped (nested-unknown drop, debug log — NOT a
  // top-level foreign warn), while the mirrored deep_reconcile key is read.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      version: 1
      roots:
        hq: /from-local
      worker_pool:
        anything: true
        dag:
          autowalk:
            deep_reconcile: true
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), '/from-local');
    assert.equal(cfg.get('worker_pool.anything'), null);
    assert.equal(cfg.get('worker_pool.dag.autowalk.deep_reconcile'), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('unversioned config.local.yaml tolerates unknown nested worker_pool keys', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      roots:
        hq: /from-local
      worker_pool:
        anything: true
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), '/from-local');
    assert.equal(cfg.get('worker_pool.anything'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level config.yaml rejects an unknown nested main_catchup key', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      main_catchup:
        anything: true
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /main_catchup/);
        assert.match(err.message, /unknown key/);
        assert.ok(String(err.source).startsWith(top));
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level config.yaml accepts the mirrored main_catchup daemon keys', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      main_catchup:
        poll_interval_seconds: 301
        drain_timeout: 6m
        stale_drain_reap_seconds: 601
        submodule_update_timeout_seconds: 121
        recovery_max_attempts: 6
        bounce_throttle_interval_seconds: 302
        adversarial_review_drain_timeout_seconds: 240
        adversarial_watcher_drain_bounce_slack_seconds: 45
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('main_catchup.poll_interval_seconds'), 301);
    assert.equal(cfg.get('main_catchup.drain_timeout'), '6m');
    assert.equal(cfg.get('main_catchup.stale_drain_reap_seconds'), 601);
    assert.equal(cfg.get('main_catchup.submodule_update_timeout_seconds'), 121);
    assert.equal(cfg.get('main_catchup.recovery_max_attempts'), 6);
    assert.equal(cfg.get('main_catchup.bounce_throttle_interval_seconds'), 302);
    assert.equal(cfg.get('main_catchup.adversarial_review_drain_timeout_seconds'), 240);
    assert.equal(cfg.get('main_catchup.adversarial_watcher_drain_bounce_slack_seconds'), 45);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main_catchup mirrored defaults match the Python daemon constants', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('main_catchup.poll_interval_seconds'), 300);
    assert.equal(cfg.get('main_catchup.drain_timeout'), '5m');
    assert.equal(cfg.get('main_catchup.stale_drain_reap_seconds'), 600);
    assert.equal(cfg.get('main_catchup.submodule_update_timeout_seconds'), 120);
    assert.equal(cfg.get('main_catchup.recovery_max_attempts'), 5);
    assert.equal(cfg.get('main_catchup.bounce_throttle_interval_seconds'), 300);
    assert.equal(cfg.get('main_catchup.adversarial_review_drain_timeout_seconds'), 180);
    assert.equal(cfg.get('main_catchup.adversarial_watcher_drain_bounce_slack_seconds'), 120);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('config.local.yaml tolerates unknown nested main_catchup keys and reads mirrored ones', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      roots:
        hq: /from-local
      main_catchup:
        anything: true
        poll_interval_seconds: 301
        adversarial_review_drain_timeout_seconds: 300
        adversarial_watcher_drain_bounce_slack_seconds: 60
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), '/from-local');
    assert.equal(cfg.get('main_catchup.anything'), null);
    assert.equal(cfg.get('main_catchup.poll_interval_seconds'), 301);
    assert.equal(cfg.get('main_catchup.adversarial_review_drain_timeout_seconds'), 300);
    assert.equal(cfg.get('main_catchup.adversarial_watcher_drain_bounce_slack_seconds'), 60);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('config.local.yaml tolerates a NESTED unknown key under an owned root (no watcher crash)', () => {
  // Mirror of agent-os#1743: a nested unknown key under a root THIS reader owns
  // (here retention.policies.standard_backup, a strict nested dict) must be
  // dropped, not raised, when it appears in the live-edited local override.
  // The watcher crash-loop class (enabling a feature via a schema key the
  // running daemon's schema lags on) must become a no-op, not an outage.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      version: 1
      retention:
        policies:
          standard_backup:
            daily: 3
            bogus_key_not_in_schema: 1
    `);
    // Must NOT throw — the unknown nested key is dropped.
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('retention.policies.standard_backup.daily'), 3);
    assert.equal(
      cfg.get('retention.policies.standard_backup.bogus_key_not_in_schema'),
      null,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('config.local.yaml rejects arbitrary unknown top-level keys as typos', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(local, `
      version: 1
      retentoin:
        policies:
          standard_backup:
            daily: 3
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /retentoin/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checked-in config.yaml STILL rejects a nested unknown key (strict preserved)', () => {
  // The tolerance is scoped to *.local.yaml only — the version-controlled
  // config.yaml keeps catching genuine typos at review/CI time.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        policies:
          standard_backup:
            daily: 3
            bogus_key_not_in_schema: 1
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /bogus_key_not_in_schema/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('topPath deliberately pointed at config.local.yaml stays strict outside Layer 4', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.local.yaml');
    writeFile(top, `
      version: 1
      retention:
        policies:
          standard_backup:
            daily: 3
            bogus_key_not_in_schema: 1
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /bogus_key_not_in_schema/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('module *.local.yaml tolerates a nested unknown key; module config.yaml stays strict', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const mod = join(tmp, 'mod.yaml');
    const modLocal = join(tmp, 'mod.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(mod, `
      roles:
        reviewer: codex
    `);
    writeFile(modLocal, `
      roles:
        reviewer: claude-code
      retention:
        policies:
          standard_backup:
            bogus_key_not_in_schema: 1
    `);
    // module-local nested unknown is dropped, not raised.
    const cfg = loadConfig({ topPath: top, modulePaths: [mod], env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
    assert.equal(
      cfg.get('retention.policies.standard_backup.bogus_key_not_in_schema'),
      null,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('module path supplied directly as *.local.yaml stays strict outside Layer 4', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const modLocal = join(tmp, 'mod.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(modLocal, `
      roles:
        reviewer: claude-code
      retention:
        policies:
          standard_backup:
            bogus_key_not_in_schema: 1
    `);
    assert.throws(
      () => loadConfig({ topPath: top, modulePaths: [modLocal], env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /bogus_key_not_in_schema/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('module *.local.yaml rejects arbitrary unknown top-level keys as typos', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const mod = join(tmp, 'mod.yaml');
    const modLocal = join(tmp, 'mod.local.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /from-top
    `);
    writeFile(mod, `
      roles:
        reviewer: codex
    `);
    writeFile(modLocal, `
      retentoin:
        policies:
          standard_backup:
            daily: 3
    `);
    assert.throws(
      () => loadConfig({ topPath: top, modulePaths: [mod], env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /retentoin/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention full block accepts schema-default values', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        policies:
          standard_backup:
            daily: 7
            weekly: 4
            monthly: 3
        cadence:
          weekly_day_of_week: 0
          monthly_day_of_month: 1
        surfaces:
          postgres_backups:
            policy: standard_backup
        ephemeral:
          worker_worktrees_keep_hours: 168
          worker_worktrees_per_run_limit: 200
          follow_up_workspaces_keep_hours: 72
          acpx_sessions_keep_days: 30
          acpx_sessions_gib_cap: 10.0
          acpx_sessions_min_idle_minutes: 60
          openclaw_sessions_keep_days: 30
          openclaw_sessions_min_idle_minutes: 60
          claude_code_sessions_keep_days: 90
          dispatch_audit_keep_days: 365
        sentinel:
          disk_headroom:
            threshold_pct: 85
            threshold_pct_critical: 95
            threshold_gib_free: 10
            threshold_gib_free_critical: 2
            page_dedupe_seconds: 3600
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.get('retention'), RETENTION_DEFAULTS);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention partial override keeps non-overridden schema defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        ephemeral:
          acpx_sessions_keep_days: 14
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.get('retention'), {
      ...RETENTION_DEFAULTS,
      ephemeral: {
        ...RETENTION_DEFAULTS.ephemeral,
        acpx_sessions_keep_days: 14,
      },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention absent block materializes schema defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.get('retention'), RETENTION_DEFAULTS);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sentinel routing-tier outage detector loads through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      sentinel:
        detectors:
          litellm_routing_tier_outage:
            enabled: false
            log_path: /tmp/adversarial-watcher.log
            window_seconds: 180
            event_count_threshold: 5
            severity: SEV-1
            comms_channels:
              - email
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('sentinel.detectors.litellm_routing_tier_outage.enabled'), false);
    assert.equal(cfg.get('sentinel.detectors.litellm_routing_tier_outage.log_path'), '/tmp/adversarial-watcher.log');
    assert.equal(cfg.get('sentinel.detectors.litellm_routing_tier_outage.window_seconds'), 180);
    assert.equal(cfg.get('sentinel.detectors.litellm_routing_tier_outage.event_count_threshold'), 5);
    assert.equal(cfg.get('sentinel.detectors.litellm_routing_tier_outage.severity'), 'SEV-1');
    assert.deepEqual(cfg.get('sentinel.detectors.litellm_routing_tier_outage.comms_channels'), ['email']);

    const envCfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_ENABLED: 'true',
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_LOG_PATH: '/tmp/env-adversarial-watcher.log',
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_WINDOW_SECONDS: '120',
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_EVENT_COUNT_THRESHOLD: '4',
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_SEVERITY: 'SEV-3',
        AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_COMMS_CHANNELS: 'email,telegram',
      },
    });
    assert.equal(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.enabled'), true);
    assert.equal(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.log_path'), '/tmp/env-adversarial-watcher.log');
    assert.equal(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.window_seconds'), 120);
    assert.equal(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.event_count_threshold'), 4);
    assert.equal(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.severity'), 'SEV-3');
    assert.deepEqual(envCfg.get('sentinel.detectors.litellm_routing_tier_outage.comms_channels'), ['email', 'telegram']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level sentinel disk headroom loads through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      sentinel:
        disk_headroom:
          top_consumer_roots: /Users/airlock,/Users/placey
          top_consumer_limit: 4
          df_timeout_seconds: 1.5
          du_timeout_seconds: 35.0
          sensor_failure_page_threshold: 3
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('sentinel.disk_headroom.top_consumer_roots'), '/Users/airlock,/Users/placey');
    assert.equal(cfg.get('sentinel.disk_headroom.top_consumer_limit'), 4);
    assert.equal(cfg.get('sentinel.disk_headroom.df_timeout_seconds'), 1.5);
    assert.equal(cfg.get('sentinel.disk_headroom.du_timeout_seconds'), 35.0);
    assert.equal(cfg.get('sentinel.disk_headroom.sensor_failure_page_threshold'), 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checked-in top-level sentinel detector config loads through strict Node schema', () => {
  const top = join(REPO_ROOT, '..', '..', 'config.yaml');
  const cfg = loadConfig({ topPath: top, env: {} });

  assert.equal(cfg.get('sentinel.spec_drift.cycle_interval_seconds'), 86400);
  assert.equal(cfg.get('sentinel.deploy_checkout.repo_path'), '/Users/airlock/agent-os');
  assert.deepEqual(cfg.get('sentinel.deploy_checkout.worker_identity_emails'), [
    'claude-code@laceyenterprises.com',
    'clio-agent@laceyenterprises.com',
    'codex@laceyenterprises.com',
    'merge-agent@laceyenterprises.com',
  ]);
  assert.equal(cfg.get('sentinel.codex_compaction.rate_alarm_per_hour'), 3);
  assert.deepEqual(cfg.get('sentinel.convergence_stall.observed_worker_classes'), [
    'codex',
    'claude-code',
    'clio-agent',
  ]);

  const envCfg = loadConfig({
    topPath: top,
    env: {
      HQ_SENTINEL_CODEX_COMPACTION_RATE_ALARM_PER_HOUR: '6',
    },
  });
  assert.equal(envCfg.get('sentinel.codex_compaction.rate_alarm_per_hour'), 6);

  const legacyEnvCfg = loadConfig({
    topPath: top,
    env: {
      SENTINEL_CODEX_COMPACTION_RATE_ALARM_PER_HOUR: '7',
    },
  });
  assert.equal(legacyEnvCfg.get('sentinel.codex_compaction.rate_alarm_per_hour'), 7);
});

test('retention surfaces reject unknown keys with structured path', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        surfaces:
          foo:
            policy: standard_backup
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'retention.surfaces.foo');
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention rejects unknown top-level nested blocks', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        unknown_block: {}
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'retention.unknown_block');
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention rejects out-of-range calendar and percentage values', () => {
  const cases = [
    ['retention.cadence.weekly_day_of_week', '          cadence:\n            weekly_day_of_week: 7', 7],
    ['retention.cadence.monthly_day_of_month', '          cadence:\n            monthly_day_of_month: 0', 0],
    ['retention.cadence.monthly_day_of_month', '          cadence:\n            monthly_day_of_month: 32', 32],
    ['retention.sentinel.disk_headroom.threshold_pct', '          sentinel:\n            disk_headroom:\n              threshold_pct: 101', 101],
    ['retention.sentinel.disk_headroom.threshold_pct_critical', '          sentinel:\n            disk_headroom:\n              threshold_pct_critical: 101', 101],
    ['retention.sentinel.disk_headroom.threshold_gib_free_critical', '          sentinel:\n            disk_headroom:\n              threshold_gib_free_critical: -1', -1],
    ['retention.sentinel.disk_headroom.page_dedupe_seconds', '          sentinel:\n            disk_headroom:\n              page_dedupe_seconds: -1', -1],
  ];
  const tmp = freshTmp();
  try {
    for (const [keyPath, yaml, got] of cases) {
      const top = join(tmp, `${keyPath}-${got}.yaml`);
      writeFile(top, `
        version: 1
        retention:
${yaml}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, keyPath);
          assert.equal(err.got, got);
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention rejects negative keep_days values', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        ephemeral:
          acpx_sessions_keep_days: -1
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'retention.ephemeral.acpx_sessions_keep_days');
        assert.equal(err.got, -1);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention rejects negative policy cadence counts', () => {
  const tmp = freshTmp();
  try {
    for (const key of ['daily', 'weekly', 'monthly']) {
      const top = join(tmp, `${key}.yaml`);
      writeFile(top, `
        version: 1
        retention:
          policies:
            standard_backup:
              ${key}: -1
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, `retention.policies.standard_backup.${key}`);
          assert.equal(err.got, -1);
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention surface policy stays shape-only at loader layer', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      retention:
        surfaces:
          postgres_backups:
            policy: nonexistent
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    // Cross-reference validation belongs to the reaper, not this loader.
    assert.equal(cfg.get('retention.surfaces.postgres_backups.policy'), 'nonexistent');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retention full block resolves identically from config.yaml and config.local.yaml', () => {
  const tmp = freshTmp();
  try {
    const topOnly = join(tmp, 'top-only.yaml');
    writeFile(topOnly, `
      version: 1
      retention:
        policies:
          standard_backup:
            daily: 7
            weekly: 4
            monthly: 3
        cadence:
          weekly_day_of_week: 0
          monthly_day_of_month: 1
        surfaces:
          postgres_backups:
            policy: standard_backup
        ephemeral:
          worker_worktrees_keep_hours: 168
          worker_worktrees_per_run_limit: 200
          follow_up_workspaces_keep_hours: 72
          acpx_sessions_keep_days: 30
          acpx_sessions_gib_cap: 10.0
          acpx_sessions_min_idle_minutes: 60
          openclaw_sessions_keep_days: 30
          openclaw_sessions_min_idle_minutes: 60
          claude_code_sessions_keep_days: 90
          dispatch_audit_keep_days: 365
        sentinel:
          disk_headroom:
            threshold_pct: 85
            threshold_pct_critical: 95
            threshold_gib_free: 10
            threshold_gib_free_critical: 2
            page_dedupe_seconds: 3600
    `);
    const splitTop = join(tmp, 'config.yaml');
    const local = join(tmp, 'config.local.yaml');
    writeFile(splitTop, `
      version: 1
    `);
    writeFile(local, `
      retention:
        policies:
          standard_backup:
            daily: 7
            weekly: 4
            monthly: 3
        cadence:
          weekly_day_of_week: 0
          monthly_day_of_month: 1
        surfaces:
          postgres_backups:
            policy: standard_backup
        ephemeral:
          worker_worktrees_keep_hours: 168
          worker_worktrees_per_run_limit: 200
          follow_up_workspaces_keep_hours: 72
          acpx_sessions_keep_days: 30
          acpx_sessions_gib_cap: 10.0
          acpx_sessions_min_idle_minutes: 60
          openclaw_sessions_keep_days: 30
          openclaw_sessions_min_idle_minutes: 60
          claude_code_sessions_keep_days: 90
          dispatch_audit_keep_days: 365
        sentinel:
          disk_headroom:
            threshold_pct: 85
            threshold_pct_critical: 95
            threshold_gib_free: 10
            threshold_gib_free_critical: 2
            page_dedupe_seconds: 3600
    `);
    const topCfg = loadConfig({ topPath: topOnly, env: {} });
    const localCfg = loadConfig({ topPath: splitTop, env: {} });
    assert.deepEqual(topCfg.get('retention'), RETENTION_DEFAULTS);
    assert.deepEqual(localCfg.get('retention'), RETENTION_DEFAULTS);
    assert.deepEqual(localCfg.get('retention'), topCfg.get('retention'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('env override canonical wins', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        reviewer: codex
    `);
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_REVIEWER: 'claude-code' },
    });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roles.hermes provider mirrors Python schema and env alias', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        hermes:
          provider: openai-codex
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.hermes.provider'), 'openai-codex');

    const envCfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_HERMES_PROVIDER: 'nous-portal' },
    });
    assert.equal(envCfg.get('roles.hermes.provider'), 'nous-portal');
    assert.equal(
      envCfg.resolutionTrace('roles.hermes.provider').at(-1).source,
      'env:AGENT_OS_ROLES_HERMES_PROVIDER',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('host and tailscale sections load through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      host:
        name: laceyent-mbpro
        tailscale_hostname: laceyent-mbpro.tail7a19d9.ts.net
      tailscale:
        workstation_ip: 100.64.0.10
        daily_driver_ip: 100.64.0.11
        ipad_ip: 100.64.0.12
        iphone_ip: 100.64.0.13
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('host.name'), 'laceyent-mbpro');
    assert.equal(cfg.get('host.tailscale_hostname'), 'laceyent-mbpro.tail7a19d9.ts.net');
    assert.equal(cfg.get('tailscale.workstation_ip'), '100.64.0.10');
    assert.equal(cfg.get('tailscale.daily_driver_ip'), '100.64.0.11');
    assert.equal(cfg.get('tailscale.ipad_ip'), '100.64.0.12');
    assert.equal(cfg.get('tailscale.iphone_ip'), '100.64.0.13');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('host and tailscale canonical env aliases override defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_HOST_NAME: 'env-host',
        AGENT_OS_TAILSCALE_HOSTNAME: 'env-host.tailnet.example',
        AGENT_OS_TAILSCALE_WORKSTATION_IP: '100.64.1.10',
        AGENT_OS_TAILSCALE_DAILY_DRIVER_IP: '100.64.1.11',
        AGENT_OS_TAILSCALE_IPAD_IP: '100.64.1.12',
        AGENT_OS_TAILSCALE_IPHONE_IP: '100.64.1.13',
      },
    });
    assert.equal(cfg.get('host.name'), 'env-host');
    assert.equal(cfg.get('host.tailscale_hostname'), 'env-host.tailnet.example');
    assert.equal(cfg.get('tailscale.workstation_ip'), '100.64.1.10');
    assert.equal(cfg.get('tailscale.daily_driver_ip'), '100.64.1.11');
    assert.equal(cfg.get('tailscale.ipad_ip'), '100.64.1.12');
    assert.equal(cfg.get('tailscale.iphone_ip'), '100.64.1.13');
    assert.equal(
      cfg.resolutionTrace('host.name').at(-1).source,
      'env:AGENT_OS_HOST_NAME',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('launchd label prefix loads through strict Node schema and env alias', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      launchd:
        label_prefix: ai.example
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('launchd.label_prefix'), 'ai.example');

    const envCfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_LAUNCHD_LABEL_PREFIX: 'ai.env' },
    });
    assert.equal(envCfg.get('launchd.label_prefix'), 'ai.env');
    assert.equal(
      envCfg.resolutionTrace('launchd.label_prefix').at(-1).source,
      'env:AGENT_OS_LAUNCHD_LABEL_PREFIX',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('OSR-04 host-local roots load through strict Node schema and env aliases', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      openclaw:
        install_root: /cfg/openclaw
      codex:
        acp_state_home: /cfg/codex-acp
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('openclaw.install_root'), '/cfg/openclaw');
    assert.equal(cfg.get('codex.acp_state_home'), '/cfg/codex-acp');
    const envCfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_OPENCLAW_INSTALL_ROOT: '/env/openclaw',
        AGENT_OS_CODEX_ACP_STATE_HOME: '/env/codex-acp',
      },
    });
    assert.equal(envCfg.get('openclaw.install_root'), '/env/openclaw');
    assert.equal(envCfg.get('codex.acp_state_home'), '/env/codex-acp');
    assert.equal(
      envCfg.resolutionTrace('openclaw.install_root').at(-1).source,
      'env:AGENT_OS_OPENCLAW_INSTALL_ROOT',
    );
    assert.equal(
      envCfg.resolutionTrace('codex.acp_state_home').at(-1).source,
      'env:AGENT_OS_CODEX_ACP_STATE_HOME',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── dispatch.default_worker_class_by_task_kind parity ──────────────────
// Pairs with the Python sibling tests at
// `platform/agent-os-config/src/agent_os_config/tests/test_dispatch_default_worker_class.py`.
// The strict-schema parity rule is the load-bearing one: a deploy
// `config.yaml` carrying `dispatch:` must parse cleanly through THIS Node
// loader (the adversarial-watcher's CFG entrypoint) — if it doesn't, the
// watcher crash-loops on the next deploy, which is the exact CFG-01
// strict-loader drift failure mode.

test('dispatch.default_worker_class_by_task_kind defaults coding/research/etc to codex', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `version: 1\n`);
    const cfg = loadConfig({ topPath: top, env: {} });
    for (const kind of ['coding', 'research', 'drafting', 'analysis', 'other']) {
      assert.equal(
        cfg.get(`dispatch.default_worker_class_by_task_kind.${kind}`),
        'codex',
        `task_kind=${kind} should default to codex`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch.default_worker_class_by_task_kind defaults merge family to merge-agent', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `version: 1\n`);
    const cfg = loadConfig({ topPath: top, env: {} });
    for (const kind of [
      'merge',
      'merge_conflict_resolution',
      'merge_comment_only_followups',
    ]) {
      assert.equal(
        cfg.get(`dispatch.default_worker_class_by_task_kind.${kind}`),
        'merge-agent',
        `task_kind=${kind} should default to merge-agent`,
      );
    }
    assert.equal(
      cfg.get(
        'dispatch.default_worker_class_by_task_kind.merge_agent_failure_recovery',
      ),
      'codex',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch top-level file overrides default coding worker class', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      dispatch:
        default_worker_class_by_task_kind:
          coding: claude-code
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(
      cfg.get('dispatch.default_worker_class_by_task_kind.coding'),
      'claude-code',
    );
    // Other kinds still take the schema default.
    assert.equal(
      cfg.get('dispatch.default_worker_class_by_task_kind.research'),
      'codex',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch per-task-kind env var overrides file', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      dispatch:
        default_worker_class_by_task_kind:
          coding: claude-code
    `);
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_CODING: 'codex',
      },
    });
    assert.equal(
      cfg.get('dispatch.default_worker_class_by_task_kind.coding'),
      'codex',
    );
    assert.equal(
      cfg.resolutionTrace('dispatch.default_worker_class_by_task_kind.coding').at(-1).source,
      'env:AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_CODING',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch strict schema rejects unknown task_kind', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      dispatch:
        default_worker_class_by_task_kind:
          synthesizing: codex
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      AgentOSConfigError,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch strict schema rejects worker class outside the enum', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      dispatch:
        default_worker_class_by_task_kind:
          coding: linkedin-pipeline
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      AgentOSConfigError,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tailscale hostname legacy env alias wins without canonical', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: { TAILSCALE_HOSTNAME: 'legacy-host.tailnet.example' },
    });
    assert.equal(cfg.get('host.tailscale_hostname'), 'legacy-host.tailnet.example');
    assert.equal(
      cfg.resolutionTrace('host.tailscale_hostname').at(-1).source,
      'env:TAILSCALE_HOSTNAME',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('legacy env alias wins without canonical', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: { ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'codex' },
    });
    assert.equal(cfg.get('roles.reviewer'), 'codex');
    const trace = cfg.resolutionTrace('roles.reviewer');
    const sources = trace.map((e) => e.source);
    assert.ok(sources.includes('env:ADVERSARIAL_REVIEW_DEFAULT_REVIEWER'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roles.reviewer accepts gemini from the legacy default reviewer env', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: { ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'gemini' },
    });
    assert.equal(cfg.get('roles.reviewer'), 'gemini');
    const sources = cfg.resolutionTrace('roles.reviewer').map((e) => e.source);
    assert.ok(sources.includes('env:ADVERSARIAL_REVIEW_DEFAULT_REVIEWER'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('canonical + alias same value ok', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_ROLES_REVIEWER: 'claude-code',
        ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'claude-code',
      },
    });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
    const sources = cfg
      .resolutionTrace('roles.reviewer')
      .map((e) => e.source);
    assert.ok(sources.includes('env:AGENT_OS_ROLES_REVIEWER'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('unsupported MHX title tags do not widen role and dispatch enums', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        reviewer: opencode
        merge_agent_worker_class: hermes
      dispatch:
        default_worker_class_by_task_kind:
          coding: opencode
          research: pi
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /roles\.reviewer/);
        assert.match(err.message, /opencode/);
        assert.match(err.message, /claude-code|codex|claude|gemini|adversarial/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roles.remediator accepts gemini from top-level config and both env names', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        remediator: gemini
    `);
    const fileCfg = loadConfig({ topPath: top, env: {} });
    assert.equal(fileCfg.get('roles.remediator'), 'gemini');
    assert.equal(fileCfg.resolutionTrace('roles.remediator').at(-1).source, 'top');

    const canonicalCfg = loadConfig({
      topPath: '/dev/null',
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'gemini',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
    });
    assert.equal(canonicalCfg.get('roles.remediator'), 'gemini');
    assert.equal(
      canonicalCfg.resolutionTrace('roles.remediator').at(-1).source,
      'env:AGENT_OS_ROLES_REMEDIATOR',
    );

    const legacyCfg = loadConfig({
      topPath: '/dev/null',
      env: {
        ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: 'gemini',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
    });
    assert.equal(legacyCfg.get('roles.remediator'), 'gemini');
    assert.equal(
      legacyCfg.resolutionTrace('roles.remediator').at(-1).source,
      'env:ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('canonical + alias conflict fails loud', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    assert.throws(
      () =>
        loadConfig({
          topPath: top,
          env: {
            AGENT_OS_ROLES_REVIEWER: 'claude-code',
            ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'codex',
          },
        }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        const msg = err.message;
        assert.match(msg, /AGENT_OS_ROLES_REVIEWER/);
        assert.match(msg, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER/);
        assert.match(msg, /claude-code/);
        assert.match(msg, /codex/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli overrides env', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_REVIEWER: 'codex' },
      cliOverrides: { 'roles.reviewer': 'claude-code' },
    });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
    const sources = cfg
      .resolutionTrace('roles.reviewer')
      .map((e) => e.source);
    assert.equal(sources[sources.length - 1], 'cli');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- §8 rows 5-9, 15-16 -----------------------------------------------

test('malformed YAML fails loud with path:line', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: "/unterminated
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /malformed YAML/);
        assert.ok(err.message.includes(top));
        assert.match(err.message, new RegExp(`${top.replace(/[.\\^$*+?()[\]{}|]/g, '\\$&')}:\\d+`));
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown key fails loud naming nearest valid', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /foo
        not_a_root: /bar
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /roots\.not_a_root/);
        assert.match(err.message, /unknown key/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('wrong type fails loud', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: 42
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /roots\.hq/);
        assert.match(err.message, /string/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('YAML 1.2: bare \'no\' fails loud (AC-11)', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      feature_flags:
        live_steer_allow_unvetted: no
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        const msg = err.message;
        assert.match(msg, /feature_flags\.live_steer_allow_unvetted/);
        assert.match(msg, /no/);
        assert.match(msg, /true/);
        assert.match(msg, /false/);
        assert.match(msg, /YAML 1\.2/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('YAML 1.1 yes/off/on/y/n all fail', () => {
  for (const bad of ['yes', 'off', 'on', 'y', 'n', 'Yes', 'OFF']) {
    const tmp = freshTmp();
    try {
      const top = join(tmp, 'config.yaml');
      writeFile(top, `
        version: 1
        feature_flags:
          live_steer_allow_unvetted: ${bad}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        AgentOSConfigError,
        `expected ${bad} to be rejected`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('YAML 1.2 true/false parse as bool', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      feature_flags:
        live_steer_allow_unvetted: true
        claude_code_ambient_auth_fallback: false
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.strictEqual(cfg.get('feature_flags.live_steer_allow_unvetted'), true);
    assert.strictEqual(cfg.get('feature_flags.claude_code_ambient_auth_fallback'), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('enum violation fails loud', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        reviewer: unknown-reviewer
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        const msg = err.message;
        assert.match(msg, /roles\.reviewer/);
        assert.match(msg, /unknown-reviewer/);
        assert.match(msg, /claude-code/);
        assert.match(msg, /adversarial/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('claude normalizes to claude-code', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        reviewer: claude
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'claude-code');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('schema version 2 fails loud', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 2
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /unknown schema version/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('missing schema version fails loud', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      roots:
        hq: /foo
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /missing schema version/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('session_ledger postgres_runtime alias coerces', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    let cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on' },
    });
    assert.equal(cfg.get('session_ledger.backend'), 'postgres');
    cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off' },
    });
    assert.equal(cfg.get('session_ledger.backend'), 'sqlite');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roles.adversarial.orchestration_mode default, local override, env override, and accessor all resolve in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');

    const defaultCfg = loadConfig({ topPath: top, env: {} });
    assert.equal(defaultCfg.get('roles.adversarial.orchestration_mode'), 'native');
    assert.equal(defaultCfg.getOrchestrationMode(), 'native');

    writeFile(join(tmp, 'config.local.yaml'), `
      version: 1
      roles:
        adversarial:
          orchestration_mode: agentos
    `);
    const localCfg = loadConfig({ topPath: top, env: {} });
    assert.equal(localCfg.get('roles.adversarial.orchestration_mode'), 'agentos');
    assert.equal(localCfg.getOrchestrationMode(), 'agentos');

    const envCfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'agentos' },
    });
    assert.equal(envCfg.get('roles.adversarial.orchestration_mode'), 'agentos');
    assert.equal(envCfg.getOrchestrationMode(), 'agentos');
    assert.equal(
      envCfg.resolutionTrace('roles.adversarial.orchestration_mode').at(-1).source,
      'env:AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('roles.adversarial.orchestration_mode rejects unsupported values in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');
    assert.throws(
      () => loadConfig({
        topPath: top,
        env: { AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'managed' },
      }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.adversarial.orchestration_mode');
        assert.equal(err.got, 'managed');
        assert.equal(err.envName, 'AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE');
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- §9 -----------------------------------------------------------------

test('resolutionTrace returns ordered entries with stable source labels', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: /Users/airlock/agent-os-hq
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    const trace = cfg.resolutionTrace('roots.hq');
    assert.equal(trace.length, 2);
    assert.equal(trace[0].source, 'code-default');
    assert.equal(trace[1].source, 'top');
    assert.equal(trace[1].value, '/Users/airlock/agent-os-hq');
    assert.equal(trace[1].path, top);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolutionTrace for unknown key is empty', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.resolutionTrace('roles.does_not_exist'), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- §4 same-file alias conflict --------------------------------------

test('same-file alias conflict fails loud', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    writeFile(mod, `
      __aliases:
        merge_agent.worker_class: roles.merge_agent_worker_class
      merge_agent:
        worker_class: codex
      roles:
        merge_agent_worker_class: claude-code
    `);
    const top = join(tmp, 'no_top.yaml');
    assert.throws(
      () => loadConfig({ topPath: top, modulePaths: [mod], env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /same-file alias conflict/);
        assert.match(err.message, /merge_agent\.worker_class/);
        assert.match(err.message, /roles\.merge_agent_worker_class/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('same-file alias same value ok', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    writeFile(mod, `
      __aliases:
        merge_agent.worker_class: roles.merge_agent_worker_class
      merge_agent:
        worker_class: codex
      roles:
        merge_agent_worker_class: codex
    `);
    const top = join(tmp, 'no_top.yaml');
    const cfg = loadConfig({ topPath: top, modulePaths: [mod], env: {} });
    assert.equal(cfg.get('roles.merge_agent_worker_class'), 'codex');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- validateSchema standalone ----------------------------------------

test('validateSchema returns present keys only', () => {
  const validated = validateSchema({ version: 1, roots: { hq: '/foo' } });
  assert.deepEqual(validated, { version: 1, roots: { hq: '/foo' } });
});

test('validateSchema rejects unsupported MHX title tags in shared CFG enums', () => {
  assert.throws(
    () => validateSchema({
      version: 1,
      roles: {
        reviewer: 'pi',
        merge_agent_worker_class: 'gemini',
      },
      dispatch: {
        default_worker_class_by_task_kind: {
          coding: 'opencode',
          merge: 'merge-agent',
        },
      },
    }),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /roles\.reviewer/);
      assert.match(err.message, /pi/);
      return true;
    },
  );
});

test('validateSchema rejects unknown nested worker_pool keys unless nested-local tolerance is explicit', () => {
  assert.throws(
    () => validateSchema(
      { version: 1, worker_pool: { anything: true } },
      { source: '/tmp/config.local.yaml' },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /worker_pool/);
      assert.match(err.message, /unknown key/);
      return true;
    },
  );
});

test('validateSchema foreign top-level tolerance does not make worker_pool foreign', () => {
  assert.throws(
    () => validateSchema(
      { version: 1, worker_pool: { anything: true } },
      { source: '/tmp/config.yaml', tolerateForeignTopLevelSections: true },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /worker_pool/);
      assert.match(err.message, /unknown key/);
      return true;
    },
  );
});

test('validateSchema tolerates unknown nested worker_pool keys in local files and keeps the mirrored one', () => {
  // config.local.yaml is shared by several loaders (CFG-01 python loader, this
  // adversarial-review loader, ...). worker_pool is now a KNOWN partial root in
  // this reader; its unknown nested keys (owned by the Python CFG reader) are
  // tolerated-dropped per-key under tolerateNestedUnknownLocalKeys, while the
  // mirrored deep_reconcile is validated and kept.
  const out = validateSchema(
    {
      version: 1,
      worker_pool: { anything: true, dag: { autowalk: { deep_reconcile: true } } },
    },
    {
      source: '/tmp/config.local.yaml',
      tolerateForeignTopLevelSections: true,
      tolerateNestedUnknownLocalKeys: true,
    },
  );
  assert.equal(out.version, 1);
  assert.equal(out.worker_pool?.anything, undefined, 'unknown nested key dropped');
  assert.equal(out.worker_pool?.dag?.autowalk?.deep_reconcile, true);
});

test('validateSchema rejects unknown nested main_catchup keys unless nested-local tolerance is explicit', () => {
  assert.throws(
    () => validateSchema(
      { version: 1, main_catchup: { anything: true } },
      { source: '/tmp/config.local.yaml' },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /main_catchup\.anything/);
      assert.match(err.message, /unknown key/);
      return true;
    },
  );
});

test('validateSchema foreign top-level tolerance does not make main_catchup foreign', () => {
  assert.throws(
    () => validateSchema(
      { version: 1, main_catchup: { anything: true } },
      { source: '/tmp/config.yaml', tolerateForeignTopLevelSections: true },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /main_catchup\.anything/);
      assert.match(err.message, /unknown key/);
      return true;
    },
  );
});

test('validateSchema tolerates unknown nested main_catchup keys in local files and keeps mirrored drain keys', () => {
  const out = validateSchema(
    {
      version: 1,
      main_catchup: {
        anything: true,
        poll_interval_seconds: 300,
        adversarial_review_drain_timeout_seconds: 240,
        adversarial_watcher_drain_bounce_slack_seconds: 45,
      },
    },
    {
      source: '/tmp/config.local.yaml',
      tolerateForeignTopLevelSections: true,
      tolerateNestedUnknownLocalKeys: true,
    },
  );
  assert.equal(out.version, 1);
  assert.equal(out.main_catchup?.anything, undefined, 'unknown nested key dropped');
  assert.equal(out.main_catchup?.poll_interval_seconds, 300);
  assert.equal(out.main_catchup?.adversarial_review_drain_timeout_seconds, 240);
  assert.equal(out.main_catchup?.adversarial_watcher_drain_bounce_slack_seconds, 45);
});

test('validateSchema rejects arbitrary unknown top-level keys as typos', () => {
  assert.throws(
    () => validateSchema(
      { version: 1, not_a_section: { anything: true } },
      { source: '/tmp/config.local.yaml' },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /not_a_section/);
      assert.match(err.message, /unknown key/);
      return true;
    },
  );
});

test('validateSchema stays strict on unknown keys INSIDE a known section', () => {
  // Public validation stays strict even when the source filename looks like a
  // local override; Layer-4 callers must opt in after discovering a real sibling.
  assert.throws(
    () => validateSchema(
      { version: 1, remediation: { max_concur_jobs: 10 } },
      { source: '/tmp/config.local.yaml' },
    ),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /max_concur_jobs/);
      return true;
    },
  );
});

test('validateSchema can explicitly tolerate nested unknown keys for local-layer callers', () => {
  const out = validateSchema(
    {
      version: 1,
      retention: {
        policies: {
          standard_backup: {
            daily: 3,
            bogus_key_not_in_schema: 1,
          },
        },
      },
    },
    {
      source: '/tmp/config.local.yaml',
      tolerateNestedUnknownLocalKeys: true,
    },
  );
  assert.equal(out.retention.policies.standard_backup.daily, 3);
  assert.equal(out.retention.policies.standard_backup.bogus_key_not_in_schema, undefined);
});

// -------- Null-handling: explicit null must NOT bypass the schema ---------

test('explicit null on non-nullable enum fails loud (does not silently revert to default)', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        reviewer: ~
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /roles\.reviewer/);
        assert.match(err.message, /null/);
        assert.match(err.message, /string/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit null on nullable field is accepted', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roots:
        hq: ~
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roots.hq'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit null on merge_agent_worker_class fails (non-nullable enum)', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        merge_agent_worker_class: null
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /merge_agent_worker_class/);
        assert.match(err.message, /null/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- submodules pass-through (__strict: false) -----------------------

test('submodules subtree round-trips through merged config', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      submodules:
        worker_pool:
          foo: 1
          bar:
            baz: hello
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('submodules.worker_pool.foo'), 1);
    assert.equal(cfg.get('submodules.worker_pool.bar.baz'), 'hello');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('submodules accepts arbitrary keys through validateSchema', () => {
  const validated = validateSchema({
    version: 1,
    submodules: { anything_goes: { nested: true } },
  });
  assert.deepEqual(validated.submodules, { anything_goes: { nested: true } });
});

// -------- Empty env-string for booleans coerces to false ------------------

test('empty-string env var for bool coerces to false', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      feature_flags:
        claude_code_ambient_auth_fallback: true
    `);
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_FEATURE_FLAGS_CLAUDE_CODE_AMBIENT_AUTH_FALLBACK: '' },
    });
    assert.equal(cfg.get('feature_flags.claude_code_ambient_auth_fallback'), false);
    assert.equal(
      cfg.resolutionTrace('feature_flags.claude_code_ambient_auth_fallback').at(-1).source,
      'env:AGENT_OS_FEATURE_FLAGS_CLAUDE_CODE_AMBIENT_AUTH_FALLBACK',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- __aliases canonical key must exist in schema --------------------

test('module __aliases targeting unknown canonical key fails loud', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    writeFile(mod, `
      __aliases:
        foo.bar: roles.nonexistent
      foo:
        bar: codex
    `);
    const top = join(tmp, 'no_top.yaml');
    assert.throws(
      () => loadConfig({ topPath: top, modulePaths: [mod], env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /roles\.nonexistent/);
        assert.match(err.message, /__aliases/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('module __aliases targeting submodules subtree is accepted (non-strict)', () => {
  const tmp = freshTmp();
  try {
    const mod = join(tmp, 'mod.yaml');
    writeFile(mod, `
      __aliases:
        worker_pool.size: submodules.worker_pool.size
      worker_pool:
        size: 4
    `);
    const top = join(tmp, 'no_top.yaml');
    const cfg = loadConfig({ topPath: top, modulePaths: [mod], env: {} });
    assert.equal(cfg.get('submodules.worker_pool.size'), 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- Round-2 review remediations -------------------------------------

test('localSibling refuses non-yaml/yml top path (Layer 4 skipped)', () => {
  const tmp = freshTmp();
  try {
    // Top path with an unconventional extension.
    const top = join(tmp, 'config.conf');
    writeFile(top, `
      version: 1
      roles:
        reviewer: codex
    `);
    // A `.local` sibling that, if synthesized, would be picked up and
    // (incorrectly) override the top value. The new contract refuses to
    // compute that sibling, so the override must NOT apply.
    writeFile(join(tmp, 'config.conf.local'), `
      version: 1
      roles:
        reviewer: claude
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.reviewer'), 'codex');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('getConfig invalidates cache when top YAML mtime changes', () => {
  const tmp = freshTmp();
  const top = join(tmp, 'config.yaml');
  const originalEnv = process.env.AGENT_OS_CONFIG_PATH;
  try {
    process.env.AGENT_OS_CONFIG_PATH = top;
    resetConfigCache();
    writeFile(top, `
      version: 1
      roles:
        reviewer: codex
    `);
    assert.equal(getConfig('roles.reviewer'), 'codex');

    // Sleep enough to guarantee a fresh mtime even on coarse filesystems.
    // Using a busy-wait to keep the test synchronous.
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }
    writeFile(top, `
      version: 1
      roles:
        reviewer: adversarial
    `);
    assert.equal(getConfig('roles.reviewer'), 'adversarial');
  } finally {
    if (originalEnv === undefined) delete process.env.AGENT_OS_CONFIG_PATH;
    else process.env.AGENT_OS_CONFIG_PATH = originalEnv;
    resetConfigCache();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- HRR-02b Node loader mirror --------------------------------------

test('fallback_path defaults to none for all mirrored role classes when unset everywhere', () => {
  const tmp = freshTmp();
  try {
    const cfg = loadConfig({ topPath: join(tmp, 'missing.yaml'), env: {} });
    for (const roleClass of FALLBACK_ROLE_CLASSES) {
      assert.equal(cfg.get(`roles.${roleClass}.fallback_path`), 'none');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('module config.yaml ships safe fallback_path defaults for reviewer and merge-agent classes', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
    `);
    const cfg = loadConfig({ topPath: top, modulePaths: [MODULE_CONFIG_PATH], env: {} });
    for (const roleClass of FALLBACK_ROLE_CLASSES) {
      assert.equal(cfg.get(`roles.${roleClass}.fallback_path`), 'none');
    }
    for (const roleClass of [
      'merge-agent',
      'claude-reviewer-lacey',
      'codex-reviewer-lacey',
      'merge-agent-failure-recovery',
    ]) {
      assert.ok(
        cfg.resolutionTrace(`roles.${roleClass}.fallback_path`).some(
          (entry) => entry.source === `module:${MODULE_CONFIG_PATH}`,
        ),
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path accepts all HRR-02a allowlisted values', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    for (const value of ['none', 'litellm-vk', 'litellm-vk-then-deferral']) {
      writeFile(top, `
        version: 1
        roles:
          claude-code:
            fallback_path: ${value}
      `);
      const cfg = loadConfig({ topPath: top, env: {} });
      assert.equal(cfg.get('roles.claude-code.fallback_path'), value);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path rejects direct-api-key with tagged config error', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        claude-code:
          fallback_path: direct-api-key
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.claude-code.fallback_path');
        assert.equal(err.got, 'direct-api-key');
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path rejects wrong-namespace enum values', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        claude-code:
          fallback_path: claude-code
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.claude-code.fallback_path');
        assert.equal(err.got, 'claude-code');
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path canonical env override beats module yaml', () => {
  const tmp = freshTmp();
  try {
    const modulePath = join(tmp, 'module.yaml');
    writeFile(modulePath, `
      roles:
        claude-code:
          fallback_path: none
    `);
    const cfg = loadConfig({
      topPath: join(tmp, 'missing.yaml'),
      modulePaths: [modulePath],
      env: {
        AGENT_OS_ROLES_CLAUDE_CODE_FALLBACK_PATH: 'litellm-vk',
      },
    });
    assert.equal(cfg.get('roles.claude-code.fallback_path'), 'litellm-vk');
    assert.equal(
      cfg.resolutionTrace('roles.claude-code.fallback_path').at(-1).source,
      'env:AGENT_OS_ROLES_CLAUDE_CODE_FALLBACK_PATH',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path legacy env alias resolves with the same precedence', () => {
  const tmp = freshTmp();
  try {
    const modulePath = join(tmp, 'module.yaml');
    writeFile(modulePath, `
      roles:
        claude-code:
          fallback_path: none
    `);
    const cfg = loadConfig({
      topPath: join(tmp, 'missing.yaml'),
      modulePaths: [modulePath],
      env: {
        LITELLM_VK_FALLBACK_FOR_CLAUDE_CODE: 'litellm-vk',
      },
    });
    assert.equal(cfg.get('roles.claude-code.fallback_path'), 'litellm-vk');
    assert.equal(
      cfg.resolutionTrace('roles.claude-code.fallback_path').at(-1).source,
      'env:LITELLM_VK_FALLBACK_FOR_CLAUDE_CODE',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path canonical and legacy env aliases fail loud on conflict', () => {
  const tmp = freshTmp();
  try {
    for (const roleClass of FALLBACK_ROLE_CLASSES) {
      const envSegment = roleClass.replaceAll('-', '_').toUpperCase();
      assert.throws(
        () => loadConfig({
          topPath: join(tmp, 'missing.yaml'),
          env: {
            [`AGENT_OS_ROLES_${envSegment}_FALLBACK_PATH`]: 'none',
            [`LITELLM_VK_FALLBACK_FOR_${envSegment}`]: 'litellm-vk',
          },
        }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, `roles.${roleClass}.fallback_path`);
          assert.match(err.message, /conflict/i);
          assert.equal(err.envName, null);
          assert.deepEqual(err.conflictingEnvNames, [
            `AGENT_OS_ROLES_${envSegment}_FALLBACK_PATH`,
            `LITELLM_VK_FALLBACK_FOR_${envSegment}`,
          ]);
          return true;
        },
        `expected alias conflict for ${roleClass}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback_path env-sourced validation errors populate envName', () => {
  const tmp = freshTmp();
  try {
    assert.throws(
      () => loadConfig({
        topPath: join(tmp, 'missing.yaml'),
        env: {
          AGENT_OS_ROLES_CLAUDE_CODE_FALLBACK_PATH: 'direct-api-key',
        },
      }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.claude-code.fallback_path');
        assert.equal(err.envName, 'AGENT_OS_ROLES_CLAUDE_CODE_FALLBACK_PATH');
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('quota_probe cadence defaults resolve to 3600 when unset', () => {
  const tmp = freshTmp();
  try {
    const cfg = loadConfig({ topPath: join(tmp, 'missing.yaml'), env: {} });
    assert.equal(cfg.get('roles.quota_probe.ok_tick_seconds'), 3600);
    assert.equal(cfg.get('roles.quota_probe.exhausted_unknown_tick_seconds'), 3600);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentOSConfigError normalizes derived envName tokens', () => {
  assert.equal(new AgentOSConfigError('broken', { source: 'env:' }).envName, null);
  assert.equal(
    new AgentOSConfigError('broken', { source: 'env:  AGENT_OS_ROLES_REVIEWER  ' }).envName,
    'AGENT_OS_ROLES_REVIEWER',
  );
  assert.equal(
    new AgentOSConfigError('broken', { envName: '  AGENT_OS_ROLES_CODEX_FALLBACK_PATH  ' }).envName,
    'AGENT_OS_ROLES_CODEX_FALLBACK_PATH',
  );
  assert.deepEqual(
    new AgentOSConfigError('broken', {
      conflictingEnvNames: ['  AGENT_OS_ROLES_CODEX_FALLBACK_PATH  ', '', null],
    }).conflictingEnvNames,
    ['AGENT_OS_ROLES_CODEX_FALLBACK_PATH'],
  );
});

test('AMA merge_authority spec YAML and env aliases load through strict Node schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            enabled: false
            worker_class: codex
            merge_method: squash
            strict_non_blocking_remediation: false
            eligibility:
              risk_classes: ["low"]
              fast_merge_labels:
                - "fast-merge:test-fixtures"
                - "fast-merge:docs"
              reviewer_family_policy: audit_existing_gate_contract
              ci_green_classifier: existingAdversarialMergeClassifier
            branch_protection:
              required_gate_context_source: resolveGateStatusContext
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.adversarial.merge_authority.enabled'), false);
    assert.equal(cfg.get('roles.adversarial.merge_authority.worker_class'), 'codex');
    assert.equal(cfg.get('roles.adversarial.merge_authority.merge_method'), 'squash');
    assert.equal(cfg.get('roles.adversarial.merge_authority.strict_non_blocking_remediation'), false);
    assert.equal(cfg.getMergeAuthorityConfig().strictNonBlockingRemediation, false);
    assert.deepEqual(cfg.get('roles.adversarial.merge_authority.eligibility.risk_classes'), ['low']);
    assert.deepEqual(
      cfg.get('roles.adversarial.merge_authority.eligibility.fast_merge_labels'),
      ['fast-merge:test-fixtures', 'fast-merge:docs'],
    );
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.eligibility.reviewer_family_policy'),
      'audit_existing_gate_contract',
    );
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.eligibility.ci_green_classifier'),
      'existingAdversarialMergeClassifier',
    );
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.branch_protection.required_gate_context_source'),
      'resolveGateStatusContext',
    );
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.branch_protection.required'),
      true,
    );

    const canonicalFalseEnvCfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED: '0' },
    });
    assert.equal(canonicalFalseEnvCfg.get('roles.adversarial.merge_authority.enabled'), false);
    assert.equal(
      canonicalFalseEnvCfg.resolutionTrace('roles.adversarial.merge_authority.enabled').at(-1).source,
      'env:AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority worker class defaults to hammer in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.adversarial.merge_authority.worker_class'), 'hammer');
    assert.equal(cfg.getMergeAuthorityConfig().workerClass, 'hammer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority accepts hammer as closer worker class in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            worker_class: hammer
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.adversarial.merge_authority.worker_class'), 'hammer');
    assert.equal(cfg.getMergeAuthorityConfig().workerClass, 'hammer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority accepts gemini as closer worker class in Node loader', () => {
  // GMW-04: gemini is a selectable AMA closer harness.
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            worker_class: gemini
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.get('roles.adversarial.merge_authority.worker_class'), 'gemini');
    assert.equal(cfg.getMergeAuthorityConfig().workerClass, 'gemini');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority public docs list the Node loader worker_class enum', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/config-loader.mjs'), 'utf8');
  const enumMatch = source.match(/worker_class:\s*\{[\s\S]*?__enum:\s*\[([^\]]+)\]/);
  assert.ok(enumMatch, 'expected merge_authority.worker_class enum in config-loader schema');
  const enumValues = Array.from(enumMatch[1].matchAll(/'([^']+)'/g), (match) => match[1]);
  assert.deepEqual(enumValues, ['codex', 'claude-code', 'hammer', 'gemini']);

  for (const relativePath of [
    'projects/adversarial-merge-authority/SPEC.md',
    'docs/SPEC-adversarial-review-auto-remediation.md',
    'docs/RUNBOOK-ama-closure.md',
  ]) {
    const doc = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    for (const workerClass of enumValues) {
      assert.ok(
        doc.includes(`\`${workerClass}\``),
        `${relativePath} must document ${workerClass} as an AMA closer worker class`,
      );
    }
  }
});

test('AMA merge_authority risk_classes reject unsupported values in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            eligibility:
              risk_classes: ["extreme"]
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.adversarial.merge_authority.eligibility.risk_classes[0]');
        assert.equal(err.got, 'extreme');
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority accepts all four risk classes + high_risk_requires_two_key in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            eligibility:
              risk_classes: ["low", "medium", "high", "critical"]
              high_risk_requires_two_key: false
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(
      cfg.get('roles.adversarial.merge_authority.eligibility.risk_classes'),
      ['low', 'medium', 'high', 'critical'],
    );
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key'),
      false,
    );
    // The camelCase AMA accessor surfaces both.
    const ma = cfg.getMergeAuthorityConfig();
    assert.deepEqual(ma.eligibility.riskClasses, ['low', 'medium', 'high', 'critical']);
    assert.equal(ma.eligibility.highRiskRequiresTwoKey, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA merge_authority high_risk_requires_two_key defaults to true', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            enabled: true
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(
      cfg.get('roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key'),
      true,
    );
    assert.equal(cfg.getMergeAuthorityConfig().eligibility.highRiskRequiresTwoKey, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// AMA-02 — the JS-camelCase accessor that AMA-02 consumers
// (`src/ama/eligibility.mjs`, AMA-03 watcher dispatch path, AMA-03 closer
// worker prompt) use to read the resolved merge-authority subtree without
// re-typing dotted keys.
test('AMA getMergeAuthorityConfig returns the camelCased subtree with defaults intact', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');
    const cfg = loadConfig({ topPath: top, env: {} });
    const ma = cfg.getMergeAuthorityConfig();
    assert.equal(ma.enabled, false);
    assert.equal(ma.workerClass, 'hammer');
    assert.equal(ma.mergeMethod, 'squash');
    assert.deepEqual(ma.eligibility.riskClasses, ['low']);
    assert.deepEqual(
      ma.eligibility.fastMergeLabels,
      ['fast-merge:test-fixtures', 'fast-merge:docs'],
    );
    assert.equal(ma.eligibility.reviewerFamilyPolicy, 'audit_existing_gate_contract');
    assert.equal(ma.eligibility.ciGreenClassifier, 'existingAdversarialMergeClassifier');
    assert.equal(ma.branchProtection.requiredGateContextSource, 'resolveGateStatusContext');
    assert.equal(ma.branchProtection.required, true);
    assert.equal(ma.autoHammerOnEligibilityMiss, false);
    assert.equal(ma.dispatchTimeoutMs, 300000);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA dispatch_timeout_ms is operator-overridable', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(
      top,
      'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      dispatch_timeout_ms: 240000\n',
    );
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.equal(cfg.getMergeAuthorityConfig().dispatchTimeoutMs, 240000);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA getMergeAuthorityConfig surfaces operator overrides from top-level YAML', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            enabled: true
            worker_class: claude-code
            merge_method: merge
            eligibility:
              risk_classes: ["low", "medium"]
              fast_merge_labels: ["fast-merge:docs"]
            branch_protection:
              required: false
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    const ma = cfg.getMergeAuthorityConfig();
    assert.equal(ma.enabled, true);
    assert.equal(ma.workerClass, 'claude-code');
    assert.equal(ma.mergeMethod, 'merge');
    assert.deepEqual(ma.eligibility.riskClasses, ['low', 'medium']);
    assert.deepEqual(ma.eligibility.fastMergeLabels, ['fast-merge:docs']);
    assert.equal(ma.branchProtection.required, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA getMergeAuthorityConfig reflects the canonical env override', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED: 'true' },
    });
    const ma = cfg.getMergeAuthorityConfig();
    assert.equal(ma.enabled, true);
    // Defaults for everything else remain untouched.
    assert.equal(ma.workerClass, 'hammer');
    assert.equal(ma.mergeMethod, 'squash');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA_ENABLED retired env var fails loud only for enabling values in Node loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      roles:
        adversarial:
          merge_authority:
            enabled: true
    `);
    for (const value of ['true', '1']) {
      assert.throws(
        () => loadConfig({ topPath: top, env: { AMA_ENABLED: value } }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, 'roles.adversarial.merge_authority.enabled');
          assert.equal(err.envName, 'AMA_ENABLED');
          assert.equal(err.source, 'env:AMA_ENABLED');
          assert.equal(err.got, value);
          assert.match(
            err.message,
            /AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED/,
          );
          return true;
        },
      );
    }
    for (const value of ['false', '0', '']) {
      const cfg = loadConfig({ topPath: top, env: { AMA_ENABLED: value } });
      assert.equal(cfg.get('roles.adversarial.merge_authority.enabled'), true);
      assert.notEqual(
        cfg.resolutionTrace('roles.adversarial.merge_authority.enabled').at(-1).source,
        'env:AMA_ENABLED',
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AMA getMergeAuthorityConfig returns defensive copies for collection fields', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, 'version: 1\n');
    const cfg = loadConfig({ topPath: top, env: {} });
    const first = cfg.getMergeAuthorityConfig();
    first.eligibility.riskClasses.push('medium');
    first.eligibility.fastMergeLabels.push('fast-merge:submodule-bump');

    const second = cfg.getMergeAuthorityConfig();
    assert.deepEqual(second.eligibility.riskClasses, ['low']);
    assert.deepEqual(
      second.eligibility.fastMergeLabels,
      ['fast-merge:test-fixtures', 'fast-merge:docs'],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('quota_probe ok_tick_seconds enforces HRR-02a range bounds', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    for (const value of [299, 21601]) {
      writeFile(top, `
        version: 1
        roles:
          quota_probe:
            ok_tick_seconds: ${value}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, 'roles.quota_probe.ok_tick_seconds');
          assert.equal(err.got, value);
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('quota_probe exhausted_unknown_tick_seconds enforces HRR-02a range bounds', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    for (const value of [599, 21601]) {
      writeFile(top, `
        version: 1
        roles:
          quota_probe:
            exhausted_unknown_tick_seconds: ${value}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, 'roles.quota_probe.exhausted_unknown_tick_seconds');
          assert.equal(err.got, value);
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('quota_probe cadence env overrides are honored', () => {
  const tmp = freshTmp();
  try {
    const cfg = loadConfig({
      topPath: join(tmp, 'missing.yaml'),
      env: {
        AGENT_OS_ROLES_QUOTA_PROBE_OK_TICK_SECONDS: '4200',
        AGENT_OS_ROLES_QUOTA_PROBE_EXHAUSTED_UNKNOWN_TICK_SECONDS: '1800',
      },
    });
    assert.equal(cfg.get('roles.quota_probe.ok_tick_seconds'), 4200);
    assert.equal(cfg.get('roles.quota_probe.exhausted_unknown_tick_seconds'), 1800);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('quota_probe cadence env rejects non-numeric values before range checks', () => {
  const tmp = freshTmp();
  try {
    assert.throws(
      () => loadConfig({
        topPath: join(tmp, 'missing.yaml'),
        env: {
          AGENT_OS_ROLES_QUOTA_PROBE_OK_TICK_SECONDS: 'not-a-number',
        },
      }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.equal(err.key, 'roles.quota_probe.ok_tick_seconds');
        assert.equal(err.got, 'not-a-number');
        assert.equal(err.envName, 'AGENT_OS_ROLES_QUOTA_PROBE_OK_TICK_SECONDS');
        assert.match(err.message, /not an integer/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('policy dedup uncommitted_line_threshold mirrors default, range bounds, and env override', () => {
  const tmp = freshTmp();
  try {
    let cfg = loadConfig({ topPath: join(tmp, 'missing.yaml'), env: {} });
    assert.equal(cfg.get('policy.dedup.uncommitted_line_threshold'), 30);

    const top = join(tmp, 'config.yaml');
    for (const value of [9, 1001]) {
      writeFile(top, `
        version: 1
        policy:
          dedup:
            uncommitted_line_threshold: ${value}
      `);
      assert.throws(
        () => loadConfig({ topPath: top, env: {} }),
        (err) => {
          assert.ok(err instanceof AgentOSConfigError);
          assert.equal(err.key, 'policy.dedup.uncommitted_line_threshold');
          assert.equal(err.got, value);
          return true;
        },
      );
    }

    cfg = loadConfig({
      topPath: join(tmp, 'missing.yaml'),
      env: {
        AGENT_OS_POLICY_DEDUP_UNCOMMITTED_LINE_THRESHOLD: '44',
      },
    });
    assert.equal(cfg.get('policy.dedup.uncommitted_line_threshold'), 44);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resume_context_envelope mirrors default and env override', () => {
  const tmp = freshTmp();
  try {
    let cfg = loadConfig({ topPath: join(tmp, 'missing.yaml'), env: {} });
    assert.equal(cfg.get('feature_flags.resume_context_envelope'), true);

    cfg = loadConfig({
      topPath: join(tmp, 'missing.yaml'),
      env: {
        AGENT_OS_FEATURE_FLAGS_RESUME_CONTEXT_ENVELOPE: 'false',
      },
    });
    assert.equal(cfg.get('feature_flags.resume_context_envelope'), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -------- APC-01: apps.<id> keyed-map surface --------------------------------

test('apps.<id> YAML entry resolves with full schema defaults', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        bar:
          mode: standalone
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.get('apps.bar'), {
      mode: 'standalone',
      subscribes: [],
      contract_version: '1.0',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('apps.<id> YAML entry with dots is defaulted as one keyed-map entry', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        "foo.bar":
          mode: standalone
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.values.apps['foo.bar'], {
      mode: 'standalone',
      subscribes: [],
      contract_version: '1.0',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(cfg.values.apps, 'foo'), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('apps.<id> YAML entry with prototype-like segment cannot pollute prototypes', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        "foo.__proto__":
          mode: standalone
    `);
    const cfg = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(cfg.values.apps['foo.__proto__'], {
      mode: 'standalone',
      subscribes: [],
      contract_version: '1.0',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(cfg.values.apps, 'foo'), false);
    assert.equal(Object.prototype.subscribes, undefined);
    assert.equal(Object.prototype.contract_version, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('apps.<id> rejects an unknown key via the strict child schema', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        bar:
          mode: standalone
          bogus: 1
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /bogus/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGENT_OS_APPS_<id>_SUBSCRIBES coerces to a list', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        bar:
          mode: standalone
    `);
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_APPS_BAR_SUBSCRIBES: 'a,b' },
    });
    assert.deepEqual(cfg.get('apps.bar.subscribes'), ['a', 'b']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGENT_OS_APPS_<id> preserves file-declared app default provenance', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps:
        foo:
          mode: standalone
    `);
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_APPS_FOO_SUBSCRIBES: 'a' },
    });

    assert.deepEqual(cfg.get('apps.foo'), {
      mode: 'standalone',
      subscribes: ['a'],
      contract_version: '1.0',
    });
    assert.equal(cfg.sources['apps.foo.contract_version'], 'code-default');
    assert.equal(
      cfg.sources['apps.foo.subscribes'],
      'env:AGENT_OS_APPS_FOO_SUBSCRIBES',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('env-only apps.<id> converges on the same defaulted shape as a YAML entry', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps: {}
    `);
    const cfg = loadConfig({
      topPath: top,
      env: { AGENT_OS_APPS_FOO_MODE: 'standalone' },
    });
    // Regression: an env-only app previously yielded { mode } with
    // `subscribes`/`contract_version` undefined, crashing consumers that
    // iterate `apps.<id>.subscribes`. It must now match a YAML-declared app.
    assert.deepEqual(cfg.get('apps.foo'), {
      mode: 'standalone',
      subscribes: [],
      contract_version: '1.0',
    });
    assert.deepEqual(cfg.get('apps.foo.subscribes'), []);
    assert.equal(
      cfg.sources['apps.foo.contract_version'],
      'code-default (env-registered app)',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('env-only apps.<id> supports prototype-bearing keyed-map ids', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      apps: {}
    `);
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_APPS_CONSTRUCTOR_MODE: 'standalone',
        AGENT_OS_APPS_PROTOTYPE_MODE: 'standalone',
      },
    });

    for (const appId of ['constructor', 'prototype']) {
      assert.equal(Object.prototype.hasOwnProperty.call(cfg.values.apps, appId), true);
      assert.deepEqual(cfg.values.apps[appId], {
        mode: 'standalone',
        subscribes: [],
        contract_version: '1.0',
      });
    }
    assert.equal(Object.prototype.subscribes, undefined);
    assert.equal(Object.prototype.contract_version, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('apps.<id> env value change busts the config cache', () => {
  const tmp = freshTmp();
  const top = join(tmp, 'config.yaml');
  try {
    writeFile(top, `
      version: 1
      apps:
        bar:
          mode: standalone
    `);
    resetConfigCache();
    let cfg = loadConfigCached({
      topPath: top,
      env: { AGENT_OS_APPS_BAR_CONTRACT_VERSION: '1.0' },
    });
    assert.equal(cfg.get('apps.bar.contract_version'), '1.0');

    cfg = loadConfigCached({
      topPath: top,
      env: { AGENT_OS_APPS_BAR_CONTRACT_VERSION: '2.0' },
    });
    assert.equal(cfg.get('apps.bar.contract_version'), '2.0');
  } finally {
    resetConfigCache();
    rmSync(tmp, { recursive: true, force: true });
  }
});
