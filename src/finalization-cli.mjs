// `adversarial-review finalization shadow-report` (ARC-16, SPEC §1 Win 3). A
// read-only surface over the recorded shadow observations (`finalization_shadow`
// in the app store): it folds the recorded `(v1 action, v2 decision)` pairs into
// the divergence report and the operator promotion verdict. It NEVER mutates
// state and NEVER acts on a decision — shadow mode is log-only.
//
// The window and the "now" the report ages against are the CLI's only clock
// reads; the model builder (`shadow-report.mjs`) is pure and takes both as data.

import { openQueueStatus, renderQueueStatus } from './finalization/queue-status.mjs';
import { queueProbeMain } from './finalization/queue-probe.mjs';
import { fileURLToPath } from 'node:url';

import { openReadOnlyFinalizationShadowStore } from './finalization/shadow-store.mjs';
import { buildShadowReport, renderShadowReport } from './finalization/shadow-report.mjs';

const USAGE = `\
Usage:
  adversarial-review finalization shadow-report [--days <7>] [--root <dir>] [--json]
  adversarial-review finalization queue status --repo OWNER/REPO --base REF [--root DIR] [--config FILE] [--json]
  adversarial-review finalization queue receipt --repo OWNER/REPO --pr N [--base REF] [--root DIR] [--config FILE] [--json]
  adversarial-review finalization queue probe --capability routing|canary --json [--root DIR] [--config FILE]
`;

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), days: 7, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--days') {
      if (!argv[i + 1]) throw new Error('--days requires a number');
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--days requires a positive number');
      options.days = n;
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

// `finalization <subcommand>`. Only `shadow-report` exists today; an unknown
// subcommand fails loud with usage so a typo never silently no-ops.
function finalizationMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const now = io.now || new Date().toISOString();
  const openStore = io.openStore || openReadOnlyFinalizationShadowStore;
  const [subcommand, ...rest] = argv;

  if (subcommand === 'queue') return queueMain(rest, io);

  if (subcommand === '--help' || subcommand === '-h' || subcommand === undefined) {
    stdout.write(USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand !== 'shadow-report') {
    stderr.write(`error: unknown finalization command ${subcommand}\n\n${USAGE}`);
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
  let store;
  try {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('shadow-report requires a valid `now` ISO timestamp');
    const from = new Date(nowMs - options.days * 24 * 60 * 60 * 1000).toISOString();
    store = openStore({ rootDir: options.rootDir });
    const observations = store.read({ from, to: now });
    const coverage = typeof store.readCoverage === 'function' ? store.readCoverage() : null;
    const queueHistory = store.readQueueHistory?.({ to: now }) ?? null;
    model = buildShadowReport({ observations, now, windowDays: options.days, coverage, queueHistory });
  } catch (err) {
    stderr.write(`error: could not build shadow report: ${err?.message || err}\n`);
    return 1;
  } finally {
    if (store && typeof store.close === 'function') store.close();
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(model, null, 2)}\n`);
  } else {
    stdout.write(`${renderShadowReport(model)}\n`);
  }
  // A non-promotable report is not an error; exit 0. Tooling reads `--json`.
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = finalizationMain(process.argv.slice(2));
}

export { finalizationMain };

export function queueMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  const [command, ...rest] = argv;
  if (command === 'probe') {
    try { return queueProbeMain(rest, { stdout, probe: io.probe }); }
    catch { stderr.write('invalid queue probe arguments\n'); return 2; }
  }
  if (!['status', 'receipt'].includes(command)) { stderr.write(USAGE); return 2; }
  const options = { rootDir: process.cwd(), json: false };
  const names = { '--repo': 'repository', '--base': 'base', '--pr': 'prNumber', '--root': 'rootDir', '--config': 'configPath' };
  try {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') options.json = true;
      else if (names[rest[i]] && rest[i + 1] && !rest[i + 1].startsWith('--')) options[names[rest[i]]] = rest[++i];
      else throw new Error('invalid argument');
    }
    if (!options.repository || (command === 'status' && (!options.base || options.prNumber))
      || (command === 'receipt' && !/^[1-9][0-9]*$/.test(options.prNumber ?? ''))) throw new Error('missing lane/PR');
    if (options.prNumber) options.prNumber = Number(options.prNumber);
  } catch { stderr.write(USAGE); return 2; }
  let store;
  try {
    store = (io.openQueueStatus || openQueueStatus)({ ...options, now: io.now });
    const model = command === 'status' ? store.status(options) : store.receipt(options);
    stdout.write(options.json || command === 'receipt' ? JSON.stringify(model, null, 2) + '\n' : renderQueueStatus(model) + '\n');
    return 0;
  } catch { stderr.write('queue store/config/receipt read failed\n'); return 1; }
  finally { store?.close(); }
}
