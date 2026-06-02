// Conformance test suite for `config-loader.mjs`.
//
// Each test case maps to a row in the agent-os repo's
// `projects/cfg/LOADER-CONTRACT.md` §8 and mirrors the Python loader's
// `tests/test_loader.py` one-to-one.
//
// Run from inside this submodule: `node --test test/config-loader.test.mjs`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentOSConfig,
  AgentOSConfigError,
  loadConfig,
  validateSchema,
  SCHEMA_VERSION,
  getConfig,
  resetConfigCache,
} from '../src/config-loader.mjs';

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
    assert.equal(cfg.get('linear.issue_prefix'), 'LAC');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('linear issue prefix and session ledger database name env overrides resolve through cfg loader', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    const cfg = loadConfig({
      topPath: top,
      env: {
        AGENT_OS_LINEAR_ISSUE_PREFIX: 'ACME',
        AGENT_OS_SESSION_LEDGER_DATABASE_NAME: 'acme_ledger',
      },
    });
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

// ─── dispatch.default_worker_class_by_task_kind parity ──────────────────
// Pairs with the Python sibling tests at
// `platform/agent-os-config/src/agent_os_config/tests/test_dispatch_default_worker_class.py`.
// The strict-schema parity rule is the load-bearing one: a deploy
// `config.yaml` carrying `dispatch:` must parse cleanly through THIS Node
// loader (the adversarial-watcher's CFG entrypoint) — if it doesn't, the
// watcher crash-loops on the next deploy, which is the exact CFG-01
// failure mode (PR #196 / #208 lineage).

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
        reviewer: gemini
    `);
    assert.throws(
      () => loadConfig({ topPath: top, env: {} }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        const msg = err.message;
        assert.match(msg, /roles\.reviewer/);
        assert.match(msg, /gemini/);
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

test('validateSchema strict at top-level', () => {
  assert.throws(
    () => validateSchema({ version: 1, not_a_section: {} }),
    (err) => {
      assert.ok(err instanceof AgentOSConfigError);
      assert.match(err.message, /not_a_section/);
      return true;
    },
  );
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

// -------- Empty env-string for booleans must fail loud --------------------

test('empty-string env var for bool fails loud (does not silently coerce to false)', () => {
  const tmp = freshTmp();
  try {
    const top = join(tmp, 'config.yaml');
    writeFile(top, `
      version: 1
      feature_flags:
        claude_code_ambient_auth_fallback: true
    `);
    assert.throws(
      () =>
        loadConfig({
          topPath: top,
          env: { AGENT_OS_FEATURE_FLAGS_CLAUDE_CODE_AMBIENT_AUTH_FALLBACK: '' },
        }),
      (err) => {
        assert.ok(err instanceof AgentOSConfigError);
        assert.match(err.message, /claude_code_ambient_auth_fallback/);
        assert.match(err.message, /not a recognized boolean/);
        return true;
      },
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
