/**
 * ARF-08: the app boots green with no agent-os runtime services present.
 *
 * `no-agent-os-imports.test.mjs` proves ARF does not *import* anything from
 * agent-os. That is a static property and it is not the same claim as this one:
 * a tree with no forbidden imports can still refuse to start because it wanted
 * a launchd job, a session-ledger socket, a broker on localhost, `hq` on PATH,
 * or a `~/.agent-os` that happens to exist on the machine the tests ran on.
 *
 * So this boots the real thing, as a real subprocess, in an environment built
 * from scratch:
 *
 *   - no `AGENT_OS_*`, `HQ_*`, or `OP_*` variables — nothing is inherited;
 *   - a `PATH` of `/usr/bin:/bin`, which deliberately has **no `node` on it**,
 *     so a supervisor that shelled out to `node` rather than using
 *     `process.execPath` would fail here;
 *   - a `HOME` pointing at an empty temporary directory, so nothing under the
 *     developer's real home can be quietly load-bearing;
 *   - a fresh state root with no config file, no store, and no gate.
 *
 * And then asserts the app is genuinely usable in that environment: it serves
 * its health, version, and governance surfaces; the gate can be installed and
 * flipped through the CLI; the running server observes the flip without being
 * restarted; a killed child comes back; and shutdown leaves nothing behind.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { MERGE_PATH_IDS } from '../../gate/gate-contract.mjs';

// test -> supervisor -> arf
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARF_BIN = join(ARF_ROOT, 'supervisor', 'bin', 'arf');

/** Variables whose presence would mean an agent-os runtime is in the picture. */
const AGENT_OS_ENV_PREFIXES = ['AGENT_OS', 'HQ_', 'OP_', 'CWP_', 'SESSION_LEDGER'];

async function until(predicate, { timeoutMs = 15_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${what} not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('standalone boot with no agent-os runtime present', () => {
  let stateRoot;
  let env;
  let supervisor;
  let baseUrl;
  let supervisorLog = '';

  before(async () => {
    stateRoot = mkdtempSync(join(tmpdir(), 'arf-standalone-'));
    const home = mkdtempSync(join(tmpdir(), 'arf-home-'));

    // Built from nothing, not filtered from process.env: a filter is a list of
    // things somebody remembered, and the point is to inherit nothing at all.
    env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      ARF_STATE_ROOT: stateRoot,
      ARF_HOST: '127.0.0.1',
      // Port 0 lets the OS pick, so a busy port on the test machine cannot make
      // this fail for an unrelated reason. The real port is read back out of the
      // child's log, which also proves the supervisor's log wiring works.
      ARF_PORT: '0',
    };

    supervisor = spawn(process.execPath, [ARF_BIN, 'up'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    supervisor.stdout.setEncoding('utf8');
    supervisor.stderr.setEncoding('utf8');
    supervisor.stdout.on('data', (chunk) => { supervisorLog += chunk; });
    supervisor.stderr.on('data', (chunk) => { supervisorLog += chunk; });

    const serverLog = join(stateRoot, 'logs', 'arf-server.log');
    const port = await until(() => {
      if (!existsSync(serverLog)) return null;
      const match = readFileSync(serverLog, 'utf8').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      return match ? match[1] : null;
    }, { what: `the ARF server to report its port (supervisor said: ${supervisorLog})` });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supervisor && supervisor.exitCode === null) {
      supervisor.kill('SIGTERM');
      await new Promise((r) => supervisor.once('exit', r));
    }
  });

  /** Run an `arf` subcommand in the same scrubbed environment. */
  function arf(args) {
    return spawnSync(process.execPath, [ARF_BIN, ...args], { env, encoding: 'utf8' });
  }

  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  }

  it('inherits no agent-os environment, and has no node on PATH', () => {
    for (const key of Object.keys(env)) {
      for (const prefix of AGENT_OS_ENV_PREFIXES) {
        assert.ok(!key.startsWith(prefix), `${key} leaked into the standalone environment`);
      }
    }
    // If `node` were reachable, a supervisor that shelled out to it would pass
    // this suite while still being broken on a machine without it.
    assert.equal(spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'which', 'node']).status, 1);
  });

  it('serves /healthz with a store it provisioned itself', async () => {
    const { status, body } = await get('/healthz');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.store.mode, 'standalone');
    assert.equal(body.store.available, true, 'a standalone install owns and creates its own store');
  });

  it('serves /version', async () => {
    const { status, body } = await get('/version');
    assert.equal(status, 200);
    assert.equal(body.name, '@arf/server');
  });

  it('serves the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  it('reports an uninstalled gate rather than failing', async () => {
    const { status, body } = await get('/v1/governance/gate');
    assert.equal(status, 200);
    assert.equal(body.installed, false);
    for (const id of MERGE_PATH_IDS) assert.equal(body.effective[id], false);
  });

  it('installs the gate from the CLI, with no daemon involved', () => {
    const result = arf(['gate', 'init', '--actor', 'paul', '--reason', 'standalone install']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gate created/);
  });

  it('the already-running server sees the install without a restart', async () => {
    const before = (await get('/healthz')).body.uptimeMs;
    const { body } = await get('/v1/governance/gate');
    assert.equal(body.installed, true);
    for (const id of MERGE_PATH_IDS) assert.equal(body.effective[id], true);
    // Uptime moving forward, not resetting, is what says the process is the
    // same one that answered before the gate existed.
    assert.ok((await get('/healthz')).body.uptimeMs >= before);
  });

  it('flips a merge path from the CLI and the running server reflects it', async () => {
    const result = arf(['gate', 'disarm', '--path', 'hammer', '--actor', 'paul', '--reason', 'rebase storm']);
    assert.equal(result.status, 0, result.stderr);

    const { body } = await get('/v1/governance/gate');
    assert.equal(body.effective.hammer, false);
    assert.equal(body.effective['daemon-clean'], true, 'the other MSM path is untouched');
  });

  it('answers `arf gate check` with the contract exit codes', () => {
    assert.equal(arf(['gate', 'check', '--path', 'daemon-clean']).status, 0);
    assert.equal(arf(['gate', 'check', '--path', 'hammer']).status, 3);
    // The aggregate is the worst path, so a wrapper cannot read a zero as
    // "everything is armed".
    assert.equal(arf(['gate', 'check']).status, 3);
  });

  it('answers `arf status` from the status file', () => {
    const result = arf(['status', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.programs.length, 1);
    assert.equal(status.programs[0].id, 'arf-server');
    assert.equal(status.programs[0].state, 'running');
    assert.equal(status.supervisor.mode, 'standalone');
  });

  it('records the flips in an audit trail', () => {
    const result = arf(['gate', 'audit', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const records = JSON.parse(result.stdout);
    assert.deepEqual(records.map((record) => record.event), ['init', 'disarm']);
    assert.equal(records[1].actor, 'paul');
  });

  it('restarts the server when it is killed, and serves again', async () => {
    const status = JSON.parse(arf(['status', '--json']).stdout);
    const firstPid = status.programs[0].pid;
    process.kill(firstPid, 'SIGKILL');

    const restarted = await until(() => {
      const next = JSON.parse(arf(['status', '--json']).stdout).programs[0];
      return next.pid && next.pid !== firstPid && next.state === 'running' ? next : null;
    }, { what: 'the supervisor to restart the ARF server' });
    assert.equal(restarted.restarts, 1);

    // The restarted server binds a fresh ephemeral port, so the log is where the
    // new one is. Waited for rather than read once: `state: running` means the
    // process exists, which is a moment earlier than it having bound a socket —
    // and reading the log at that moment is a race, not a failure.
    const ports = await until(() => {
      const serverLog = readFileSync(join(stateRoot, 'logs', 'arf-server.log'), 'utf8');
      const found = [...serverLog.matchAll(/listening on http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]);
      return found.length === 2 ? found : null;
    }, { what: 'the restarted server to log its own listen line' });

    const health = await fetch(`http://127.0.0.1:${ports[1]}/healthz`);
    assert.equal(health.status, 200);
    baseUrl = `http://127.0.0.1:${ports[1]}`;
  });

  it('kept the disarm across the restart', async () => {
    // The gate is durable state, not process state: a restarted merge path must
    // not come back armed because it forgot.
    const { body } = await get('/v1/governance/gate');
    assert.equal(body.effective.hammer, false);
  });

  it('keeps every file it created inside its own state root', () => {
    // The standalone claim is only true if the app is self-contained on disk as
    // well as in its imports.
    const entries = readdirSync(stateRoot).sort();
    assert.deepEqual(entries, ['governance', 'logs', 'review-store.db', 'run'].sort());
    assert.deepEqual(readdirSync(join(stateRoot, 'governance')).sort(), ['gate-audit.jsonl', 'gate.json']);
    assert.deepEqual(readdirSync(join(stateRoot, 'run')).sort(), ['supervisor.json', 'supervisor.pid']);
  });

  it('shuts down on SIGTERM, taking its children with it', async () => {
    const childPid = JSON.parse(arf(['status', '--json']).stdout).programs[0].pid;
    supervisor.kill('SIGTERM');
    const code = await new Promise((r) => supervisor.once('exit', r));
    assert.equal(code, 0, supervisorLog);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'the child must not be orphaned');
    assert.ok(!existsSync(join(stateRoot, 'run', 'supervisor.pid')), 'the instance lock is released');
  });
});

describe('standalone boot: refusals that must be loud', () => {
  it('refuses a pipeline-role program outside standalone mode', () => {
    // In `in-os` mode launchd already owns the watcher; a second copy would race
    // the same review claims and the same merge lease.
    const stateRoot = mkdtempSync(join(tmpdir(), 'arf-inos-'));
    mkdirSync(stateRoot, { recursive: true });
    const config = {
      mode: 'in-os',
      supervisor: {
        programs: [{ id: 'watcher', role: 'pipeline', command: '/bin/sleep', args: ['60'] }],
      },
    };
    const configPath = join(stateRoot, 'config.json');
    spawnSync('/bin/sh', ['-c', `cat > ${configPath}`], { input: JSON.stringify(config) });

    const result = spawnSync(process.execPath, [ARF_BIN, 'up'], {
      env: { PATH: '/usr/bin:/bin', HOME: stateRoot, ARF_STATE_ROOT: stateRoot, ARF_PORT: '0' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /standalone-only/);
  });

  it('refuses an unknown supervisor config key at boot', () => {
    // The same unknown-key strictness the rest of ARF's config has: a silently
    // ignored `progams` typo would leave the supervisor watching nothing but
    // the server, and looking perfectly healthy while doing it.
    const stateRoot = mkdtempSync(join(tmpdir(), 'arf-badcfg-'));
    const configPath = join(stateRoot, 'config.json');
    spawnSync('/bin/sh', ['-c', `cat > ${configPath}`], {
      input: JSON.stringify({ supervisor: { progams: [] } }),
    });

    const result = spawnSync(process.execPath, [ARF_BIN, 'status'], {
      env: { PATH: '/usr/bin:/bin', HOME: stateRoot, ARF_STATE_ROOT: stateRoot },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown key "progams"/);
  });
});
