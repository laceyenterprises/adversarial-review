/**
 * `arf` — the standalone app's command line (ARF-08).
 *
 * Two jobs, and no more:
 *
 *   arf up                 run the supervisor in the foreground
 *   arf status             what the supervisor is running
 *   arf gate ...           install, read, and flip the arm/disarm gate
 *
 * `arf gate check` is the third integration style for honoring the gate,
 * alongside the Node and Python clients: a shell merge path can gate itself
 * with `arf gate check --path hammer || exit` and no code change at all. Its
 * exit codes come from the contract — `0` armed, `3` disarmed by an operator,
 * `4` fail-closed refusal — so a wrapper can page on a broken gate without
 * paging on a deliberate stop.
 *
 * Running in the foreground is deliberate. A standalone app that daemonizes
 * itself has to reimplement pidfile handling, log rotation, and reparenting,
 * and the environments that would want it (launchd, systemd, Docker, tmux, a
 * terminal) all supervise a foreground process better than it can supervise
 * itself.
 */

import { loadConfig } from '../../server/src/config.mjs';
import { EXIT_CODES, MASTER_SCOPE, MERGE_PATH_IDS, exitCodeFor } from '../../gate/gate-contract.mjs';
import { GateStore } from '../../server/src/governance/gate-store.mjs';
import { Supervisor, readStatusFile } from './supervisor.mjs';
import { resolveProgramSet } from './programs.mjs';

const USAGE = `arf — the Adversarial Review Frontend, standalone

usage:
  arf up                                    run the supervisor in the foreground
  arf status [--json]                       what the supervisor is running
  arf gate init [--disarmed] --actor A --reason R
  arf gate status [--json]
  arf gate arm    (--path ID | --all) --actor A --reason R [--expect-seq N]
  arf gate disarm (--path ID | --all) --actor A --reason R [--expect-seq N]
  arf gate check  [--path ID] [--json]      exit 0 armed / 3 disarmed / 4 refused
  arf gate audit  [--limit N] [--json]

merge paths: ${MERGE_PATH_IDS.join(', ')}
`;

/** A deliberately small flag parser: `--key value`, `--flag`, and positionals. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    i += 1;
  }
  return { positional, flags };
}

/**
 * The scope an arm/disarm applies to.
 *
 * There is no default. `arf gate disarm --actor me --reason x` with an implied
 * scope would either stop everything or stop nothing, and both are wrong to
 * guess at when the command's whole purpose is stopping merges.
 */
function requireScopeFlag(flags) {
  const all = flags.all === true || flags.all === 'true';
  const path = typeof flags.path === 'string' ? flags.path : null;
  if (all && path) throw new Error('--all and --path are mutually exclusive');
  if (all) return MASTER_SCOPE;
  if (path) return path;
  throw new Error(`one of --all or --path <${MERGE_PATH_IDS.join('|')}> is required`);
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function optionalSeq(flags) {
  if (flags['expect-seq'] === undefined) return undefined;
  const seq = Number(flags['expect-seq']);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('--expect-seq must be a positive integer');
  return seq;
}

function renderGateStatus(described, out) {
  out(`gate: ${described.gatePath}`);
  if (!described.installed) {
    out(described.error
      ? `  NOT USABLE — ${described.error.code}: ${described.error.detail}`
      : '  not installed — run "arf gate init"; every configured merge path is refusing');
    return;
  }
  out(`  seq ${described.gate.seq}  updated ${described.gate.updatedAt}`);
  out(`  master: ${described.gate.master.armed ? 'armed' : 'DISARMED'}`
    + `  (${described.gate.master.actor ?? '—'}: ${described.gate.master.reason ?? '—'})`);
  for (const path of described.gate.paths) {
    out(`  ${path.id.padEnd(16)} ${path.effective ? 'armed   ' : 'DISARMED'} `
      + `${path.msm ? 'msm ' : '    '} ${path.effectiveReason}`);
  }
}

async function commandUp(config, io) {
  const supervisor = new Supervisor({ programs: resolveProgramSet({ config }), config });
  supervisor.acquireInstanceLock();
  supervisor.on('started', (event) => io.out(`arf: started ${event.id} pid ${event.pid}`));
  supervisor.on('exited', (event) => io.out(
    `arf: ${event.id} exited (code=${event.code} signal=${event.signal}${event.error ? ` error=${event.error}` : ''})`,
  ));
  supervisor.on('failed', (event) => io.err(
    `arf: ${event.id} FAILED after ${event.consecutiveFailures} consecutive failures — not restarting`,
  ));
  supervisor.start();
  io.out(`arf: supervising ${supervisor.programs.size} program(s); state root ${config.stateRoot}`);

  return new Promise((resolveRun) => {
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      io.out(`arf: ${signal} received, stopping children`);
      await supervisor.stop();
      resolveRun(0);
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  });
}

/**
 * Run one command.
 *
 * `io` and `config` are injectable so the tests can drive every branch without
 * a subprocess or a real state root.
 *
 * @returns {Promise<number>} the process exit code
 */
export async function run(argv, { io = { out: console.log, err: console.error }, config: injected } = {}) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (!command || command === 'help' || flags.help === true) {
    io.out(USAGE);
    return command ? EXIT_CODES.allowed : EXIT_CODES.usage;
  }

  let config;
  try {
    config = injected ?? loadConfig();
  } catch (err) {
    io.err(`arf: config error: ${err.message}`);
    return EXIT_CODES.usage;
  }

  if (command === 'up') return commandUp(config, io);

  if (command === 'status') {
    const status = readStatusFile(config.supervisor.runDir);
    if (!status) {
      io.err(`arf: no supervisor status at ${config.supervisor.runDir}; is "arf up" running?`);
      return EXIT_CODES.usage;
    }
    if (flags.json === true) {
      io.out(JSON.stringify(status, null, 2));
      return EXIT_CODES.allowed;
    }
    io.out(`supervisor pid ${status.supervisor.pid}  started ${status.supervisor.startedAt}`);
    for (const program of status.programs) {
      io.out(`  ${program.id.padEnd(16)} ${String(program.state).padEnd(9)} pid ${program.pid ?? '—'}`
        + `  restarts ${program.restarts}  started ${program.startedAt ?? '—'}`);
    }
    return EXIT_CODES.allowed;
  }

  if (command !== 'gate') {
    io.err(`arf: unknown command "${command}"\n\n${USAGE}`);
    return EXIT_CODES.usage;
  }

  const store = new GateStore({
    gatePath: config.governance.gatePath,
    auditPath: config.governance.gateAuditPath,
  });
  const sub = positional[1];

  try {
    if (sub === 'init') {
      const result = store.init({
        actor: requireFlag(flags, 'actor'),
        reason: requireFlag(flags, 'reason'),
        armed: flags.disarmed !== true,
      });
      io.out(result.created
        ? `arf: gate created at ${config.governance.gatePath} (seq ${result.document.seq})`
        : `arf: gate already exists at ${config.governance.gatePath} (seq ${result.document.seq}) — left as is`);
      return EXIT_CODES.allowed;
    }

    if (sub === 'status') {
      const described = store.describe();
      if (flags.json === true) {
        io.out(JSON.stringify(described, null, 2));
      } else {
        renderGateStatus(described, io.out);
      }
      return EXIT_CODES.allowed;
    }

    if (sub === 'arm' || sub === 'disarm') {
      const scope = requireScopeFlag(flags);
      const result = store.set({
        scope,
        armed: sub === 'arm',
        actor: requireFlag(flags, 'actor'),
        reason: requireFlag(flags, 'reason'),
        expectedSeq: optionalSeq(flags),
      });
      io.out(`arf: ${sub}ed ${scope} (seq ${result.document.seq})`);
      renderGateStatus(store.describe(), io.out);
      return EXIT_CODES.allowed;
    }

    if (sub === 'check') {
      if (typeof flags.path === 'string') {
        const decision = store.reader.decide(flags.path);
        io.out(flags.json === true
          ? JSON.stringify(decision, null, 2)
          : `${decision.allowed ? 'armed' : 'refused'}: ${decision.reason}`);
        return exitCodeFor(decision);
      }
      const decisions = store.reader.decideAll();
      if (flags.json === true) {
        io.out(JSON.stringify(decisions, null, 2));
      } else {
        for (const id of MERGE_PATH_IDS) {
          io.out(`${id.padEnd(16)} ${decisions[id].allowed ? 'armed   ' : 'REFUSED '} ${decisions[id].reason}`);
        }
      }
      // The worst outcome across the paths, so a wrapper checking "is anything
      // armed" cannot read a zero as "all clear".
      return Math.max(...MERGE_PATH_IDS.map((id) => exitCodeFor(decisions[id])));
    }

    if (sub === 'audit') {
      const limit = flags.limit === undefined ? 20 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      const records = store.auditTail(limit);
      if (flags.json === true) {
        io.out(JSON.stringify(records, null, 2));
      } else if (records.length === 0) {
        io.out(`arf: no gate audit records at ${config.governance.gateAuditPath}`);
      } else {
        for (const record of records) {
          io.out(`${record.at}  ${String(record.event).padEnd(7)} ${String(record.scope).padEnd(16)} `
            + `${record.actor}: ${record.reason}`);
        }
      }
      return EXIT_CODES.allowed;
    }

    io.err(`arf: unknown gate subcommand "${sub ?? ''}"\n\n${USAGE}`);
    return EXIT_CODES.usage;
  } catch (err) {
    io.err(`arf: ${err.message}`);
    // A gate command that could not be carried out is a refusal, not a success
    // with a message — a script running `arf gate disarm` must see a non-zero
    // exit when the disarm did not happen. The two non-zero codes stay
    // meaningful: `usage` for a request that was wrong, `refused` for one that
    // was right and the gate would not carry out.
    const badRequest = err.code === undefined || err.code === 'bad_request';
    return badRequest ? EXIT_CODES.usage : EXIT_CODES.refused;
  }
}
