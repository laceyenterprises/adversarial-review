// `adversarial-review runtime status` (ARC-09, SPEC §1 Win 1). A read-only,
// side-effect-free surface over the durable runtime artifacts. Prints the
// operator status block (or `--json` for tooling), and never mutates state.

import { fileURLToPath } from 'node:url';

import { buildRuntimeStatus, renderRuntimeStatus } from './runtime-status.mjs';

const USAGE = `\
Usage:
  adversarial-review runtime status [--root <dir>] [--window <24h>] [--json]
`;

const DURATION_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseWindowMs(text) {
  const match = /^(\d+)\s*([smhd])?$/.exec(String(text).trim());
  if (!match) throw new Error(`invalid --window duration: ${text}`);
  const value = Number(match[1]);
  const unit = match[2] || 'h';
  return value * DURATION_UNITS[unit];
}

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), windowMs: 24 * 60 * 60 * 1000, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--window') {
      if (!argv[i + 1]) throw new Error('--window requires a duration');
      options.windowMs = parseWindowMs(argv[++i]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// `runtime <subcommand>`. Only `status` exists today; unknown subcommands fail
// loud with usage so a typo doesn't silently no-op.
function runtimeMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const [subcommand, ...rest] = argv;

  if (subcommand === '--help' || subcommand === '-h' || subcommand === undefined) {
    stdout.write(USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand !== 'status') {
    stderr.write(`error: unknown runtime command ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  let options;
  try {
    options = parseArgs(rest);
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  let model;
  try {
    model = buildRuntimeStatus(options.rootDir, { windowMs: options.windowMs });
  } catch (err) {
    stderr.write(`error: could not build runtime status: ${err?.message || err}\n`);
    return 1;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(model, null, 2)}\n`);
  } else {
    stdout.write(`${renderRuntimeStatus(model)}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runtimeMain(process.argv.slice(2));
}

export { parseWindowMs, runtimeMain };
