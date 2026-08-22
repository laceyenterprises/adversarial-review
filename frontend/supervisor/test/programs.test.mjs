/**
 * ARF-08: the program set, its config, and the `arf` CLI.
 *
 * The supervisor's config is where the standalone/in-OS distinction becomes
 * load-bearing rather than descriptive, and where a typo has the same shape as
 * every other silently-ignored config key: a supervisor that comes up looking
 * healthy while watching the wrong set of processes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MERGE_PATH_IDS } from '../../gate/gate-contract.mjs';
import { loadConfig } from '../../server/src/config.mjs';
import { parseArgs, run } from '../src/cli.mjs';
import { ARF_SERVER_ENTRY, ProgramSetError, childEnvironment, resolveProgramSet } from '../src/programs.mjs';
import { SupervisorConfigError, normalizeSupervisorConfig } from '../src/program-config.mjs';

function configWith(section, { mode = 'standalone' } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'arf-progcfg-'));
  writeFileSync(join(stateRoot, 'config.json'), JSON.stringify({ mode, supervisor: section }));
  return loadConfig({ env: { ARF_STATE_ROOT: stateRoot } });
}

function normalize(section, extra = {}) {
  return normalizeSupervisorConfig({
    file: section, stateRoot: '/tmp/arf-state', baseDir: '/tmp/arf-state', ...extra,
  });
}

describe('supervisor config', () => {
  it('defaults its directories under the state root', () => {
    const config = configWith({});
    assert.equal(config.supervisor.logDir, join(config.stateRoot, 'logs'));
    assert.equal(config.supervisor.runDir, join(config.stateRoot, 'run'));
  });

  it('defaults to supervising the ARF server and nothing else', () => {
    const config = configWith({});
    assert.equal(config.supervisor.serverEnabled, true);
    assert.deepEqual(config.supervisor.programs, []);
  });

  it('refuses an unknown key in the section', () => {
    assert.throws(() => normalize({ progams: [] }), SupervisorConfigError);
  });

  it('refuses an unknown key in a program', () => {
    assert.throws(
      () => normalize({ programs: [{ id: 'x', command: '/bin/true', autoRestrt: false }] }),
      (err) => err instanceof SupervisorConfigError && /autoRestrt/.test(err.message),
    );
  });

  it('refuses a program with no command', () => {
    assert.throws(() => normalize({ programs: [{ id: 'x' }] }), SupervisorConfigError);
  });

  it('refuses a duplicate program id', () => {
    // Two programs with one id would share a log file, a status entry, and the
    // restart bookkeeping — so one of them would be silently unsupervised.
    assert.throws(
      () => normalize({
        programs: [
          { id: 'x', command: '/bin/true' },
          { id: 'x', command: '/bin/false' },
        ],
      }),
      (err) => /duplicate id "x"/.test(err.message),
    );
  });

  it('refuses a program claiming the built-in server id', () => {
    assert.throws(
      () => normalize({ programs: [{ id: 'arf-server', command: '/bin/true' }] }),
      (err) => /reserved/.test(err.message),
    );
  });

  it('refuses a non-string env value', () => {
    // `false` becoming the string "false" — which every shell and config loader
    // reads as *set* — is a specific way to arm something meant to be disabled.
    assert.throws(
      () => normalize({ programs: [{ id: 'x', command: '/bin/true', env: { DEBUG: false } }] }),
      (err) => /must be a string/.test(err.message),
    );
  });

  it('refuses an unknown role', () => {
    assert.throws(
      () => normalize({ programs: [{ id: 'x', role: 'daemon', command: '/bin/true' }] }),
      (err) => /role must be one of/.test(err.message),
    );
  });

  it('reads the program list from a file when the env names one', () => {
    // A nested list cannot come through the environment, so it names a file —
    // the same seam `broker.rolesFile` uses.
    const dir = mkdtempSync(join(tmpdir(), 'arf-progfile-'));
    const file = join(dir, 'programs.json');
    writeFileSync(file, JSON.stringify([{ id: 'watcher', role: 'pipeline', command: '/bin/sleep', args: ['60'] }]));

    const normalized = normalize({}, { env: { programsFile: file }, baseDir: dir });
    assert.equal(normalized.programs.length, 1);
    assert.equal(normalized.programs[0].role, 'pipeline');
  });

  it('refuses a named program file that does not exist', () => {
    assert.throws(
      () => normalize({}, { env: { programsFile: '/nope/programs.json' }, baseDir: '/tmp' }),
      (err) => /unreadable/.test(err.message),
    );
  });
});

describe('program set resolution', () => {
  it('launches the ARF server with the running Node binary, not "node"', () => {
    // A standalone install must work with no `node` on PATH; using the string
    // "node" would make that a machine-dependent boot failure.
    const [server] = resolveProgramSet({ config: configWith({}) });
    assert.equal(server.id, 'arf-server');
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [ARF_SERVER_ENTRY]);
  });

  it('supervises pipeline daemons in standalone mode', () => {
    const config = configWith({
      programs: [
        { id: 'watcher', role: 'pipeline', command: '/bin/sleep', args: ['60'] },
        { id: 'auto-merge', role: 'pipeline', command: '/bin/sleep', args: ['60'] },
      ],
    });
    const programs = resolveProgramSet({ config });
    assert.deepEqual(programs.map((p) => p.id), ['arf-server', 'watcher', 'auto-merge']);
  });

  it('refuses pipeline daemons in in-os mode, naming the program', () => {
    const config = configWith(
      { programs: [{ id: 'watcher', role: 'pipeline', command: '/bin/sleep', args: ['60'] }] },
      { mode: 'in-os' },
    );
    assert.throws(
      () => resolveProgramSet({ config }),
      (err) => err instanceof ProgramSetError && /watcher/.test(err.message) && /standalone-only/.test(err.message),
    );
  });

  it('allows a non-pipeline program in in-os mode', () => {
    const config = configWith(
      { programs: [{ id: 'tunnel', role: 'aux', command: '/bin/sleep', args: ['60'] }] },
      { mode: 'in-os' },
    );
    assert.deepEqual(resolveProgramSet({ config }).map((p) => p.id), ['arf-server', 'tunnel']);
  });

  it('skips a disabled program', () => {
    const config = configWith({
      programs: [{ id: 'tunnel', role: 'aux', command: '/bin/sleep', enabled: false }],
    });
    assert.deepEqual(resolveProgramSet({ config }).map((p) => p.id), ['arf-server']);
  });

  it('refuses a supervisor with nothing to supervise', () => {
    // Otherwise it would sit there looking perfectly healthy.
    const config = configWith({ serverEnabled: false });
    assert.throws(() => resolveProgramSet({ config }), ProgramSetError);
  });

  it('exports the gate path into every child', () => {
    // This is how a supervised pipeline daemon finds the gate with nothing else
    // configured: one variable, from the process that already knows the state
    // root.
    const config = configWith({});
    const env = childEnvironment(config, 'watcher');
    assert.equal(env.ARF_GATE_FILE, config.governance.gatePath);
    assert.equal(env.ARF_STATE_ROOT, config.stateRoot);
    assert.equal(env.ARF_PROGRAM_ID, 'watcher');
    assert.equal(env.ARF_SUPERVISED_BY, 'arf-supervisor');
  });
});

describe('governance config', () => {
  it('puts the gate and its audit under the state root by default', () => {
    const config = configWith({});
    assert.equal(config.governance.gatePath, join(config.stateRoot, 'governance', 'gate.json'));
    assert.equal(config.governance.gateAuditPath, join(config.stateRoot, 'governance', 'gate-audit.jsonl'));
  });

  it('takes the gate path from ARF_GATE_FILE, the same variable the pipeline reads', () => {
    const config = loadConfig({ env: { ARF_STATE_ROOT: mkdtempSync(join(tmpdir(), 'arf-gp-')), ARF_GATE_FILE: '/tmp/somewhere/gate.json' } });
    assert.equal(config.governance.gatePath, '/tmp/somewhere/gate.json');
  });

  it('refuses an audit path that is the gate document', () => {
    // The audit is appended to and the gate is replaced by rename; pointed at
    // one file, the first audit line would corrupt the live gate and every
    // merge path would fail closed.
    assert.throws(
      () => loadConfig({
        env: {
          ARF_STATE_ROOT: mkdtempSync(join(tmpdir(), 'arf-gp-')),
          ARF_GATE_FILE: '/tmp/g.json',
          ARF_GATE_AUDIT_FILE: '/tmp/g.json',
        },
      }),
      (err) => /must not be the gate document/.test(err.message),
    );
  });
});

describe('arf CLI', () => {
  function collect() {
    const lines = [];
    return { io: { out: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)) }, lines };
  }

  it('parses flags, inline values, and bare switches', () => {
    assert.deepEqual(
      parseArgs(['gate', 'disarm', '--path', 'hammer', '--reason=rebase storm', '--json']),
      { positional: ['gate', 'disarm'], flags: { path: 'hammer', reason: 'rebase storm', json: true } },
    );
  });

  it('requires an explicit scope on a flip', async () => {
    // A disarm with an implied scope would either stop everything or stop
    // nothing, and both are wrong to guess when the command's whole purpose is
    // stopping merges.
    const config = configWith({});
    const { io, lines } = collect();
    const code = await run(['gate', 'disarm', '--actor', 'paul', '--reason', 'x'], { io, config });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /--all or --path/);
  });

  it('refuses --all together with --path', async () => {
    const config = configWith({});
    const { io, lines } = collect();
    const code = await run(['gate', 'disarm', '--all', '--path', 'hammer', '--actor', 'p', '--reason', 'x'], { io, config });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /mutually exclusive/);
  });

  it('requires an actor and a reason', async () => {
    const config = configWith({});
    const { io, lines } = collect();
    assert.equal(await run(['gate', 'init', '--reason', 'x'], { io, config }), 2);
    assert.match(lines.join('\n'), /--actor is required/);
  });

  it('installs, disarms both MSM paths, and reports them', async () => {
    const config = configWith({});
    const { io } = collect();

    assert.equal(await run(['gate', 'init', '--actor', 'paul', '--reason', 'install'], { io, config }), 0);
    for (const path of ['hammer', 'daemon-clean']) {
      assert.equal(
        await run(['gate', 'disarm', '--path', path, '--actor', 'paul', '--reason', 'stop'], { io, config }),
        0,
      );
    }

    const { io: statusIo, lines: statusLines } = collect();
    await run(['gate', 'status'], { io: statusIo, config });
    const rendered = statusLines.join('\n');
    assert.match(rendered, /hammer\s+DISARMED/);
    assert.match(rendered, /daemon-clean\s+DISARMED/);
    assert.match(rendered, /python-backstop\s+armed/);
  });

  it('exits 3 for a disarmed path and 4 for a broken gate', async () => {
    const config = configWith({});
    const { io } = collect();
    await run(['gate', 'init', '--actor', 'paul', '--reason', 'install'], { io, config });
    await run(['gate', 'disarm', '--path', 'hammer', '--actor', 'paul', '--reason', 'stop'], { io, config });

    assert.equal(await run(['gate', 'check', '--path', 'hammer'], { io, config }), 3);
    assert.equal(await run(['gate', 'check', '--path', 'daemon-clean'], { io, config }), 0);

    writeFileSync(config.governance.gatePath, '{ truncated');
    assert.equal(await run(['gate', 'check', '--path', 'hammer'], { io, config }), 4);
  });

  it('emergency-stops every path with --all', async () => {
    const config = configWith({});
    const { io } = collect();
    await run(['gate', 'init', '--actor', 'paul', '--reason', 'install'], { io, config });
    await run(['gate', 'disarm', '--all', '--actor', 'paul', '--reason', 'emergency stop'], { io, config });

    for (const id of MERGE_PATH_IDS) {
      assert.equal(await run(['gate', 'check', '--path', id], { io, config }), 3);
    }
  });

  it('refuses a stale-read re-arm from the CLI too', async () => {
    const config = configWith({});
    const { io, lines } = collect();
    await run(['gate', 'init', '--actor', 'paul', '--reason', 'install'], { io, config });
    await run(['gate', 'disarm', '--all', '--actor', 'ada', '--reason', 'emergency stop'], { io, config });

    const code = await run(
      ['gate', 'arm', '--all', '--actor', 'paul', '--reason', 'looks fine', '--expect-seq', '1'],
      { io, config },
    );
    assert.equal(code, 4);
    assert.match(lines.join('\n'), /gate has moved/);
    assert.equal(await run(['gate', 'check', '--path', 'hammer'], { io, config }), 3, 'the emergency stop survived');
  });

  it('reports an unknown command and an unknown gate subcommand', async () => {
    const config = configWith({});
    const { io, lines } = collect();
    assert.equal(await run(['fly'], { io, config }), 2);
    assert.equal(await run(['gate', 'wobble'], { io, config }), 2);
    assert.match(lines.join('\n'), /unknown command "fly"/);
    assert.match(lines.join('\n'), /unknown gate subcommand "wobble"/);
  });

  it('says when there is no supervisor to report on', async () => {
    const config = configWith({});
    const { io, lines } = collect();
    assert.equal(await run(['status'], { io, config }), 2);
    assert.match(lines.join('\n'), /is "arf up" running/);
  });
});
