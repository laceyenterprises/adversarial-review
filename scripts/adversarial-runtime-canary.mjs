#!/usr/bin/env node
// Fallback-canary runner (ARC-09). Drives one synthetic review through the
// `local` outage-lifeline runtime, writes the canary status file the
// `runtime status` CLI surfaces, records the run in the run-ledger, and PAGES on
// failure. Scheduled daily by
// `launchd/ai.laceyenterprises.adversarial-runtime-canary.*.plist`.
//
// Modes:
//   --fixture   (default) drive the local runtime with a canned fixture
//               reviewer — hermetic, no CLI spawn, no network. Proves the
//               local-runtime PORT + admission + RunResult mapping + verdict
//               parse + status-file + alerting path all work. This is what CI
//               and dev hosts run, and the daily plist default until the real
//               reviewer spawn is production-wired end to end (ARC-08+).
//   --live      build a real `createLocalAgentRuntime` (real cli-direct spawn)
//               so the canary detects genuine rot in the lifeline. Requires a
//               host with the reviewer CLI authed (the watcher host).
//
// Exit code: 0 on PASS, 1 on FAIL (so launchd/CI treat a rotted lifeline as an
// error even independent of the page).

import { fileURLToPath } from 'node:url';

import { createLocalAgentRuntime } from '../src/adapters/agent-runtime/local/index.mjs';
import {
  createFixtureReviewerInner,
  runFallbackCanary,
  DEFAULT_CANARY_DOMAIN_ID,
} from '../src/adapters/agent-runtime/canary.mjs';
import { runRuntimeSettleSmoke } from '../src/runtime-settle-smoke-cli.mjs';

const SCHEDULED_HARD_EXIT_MS = 660_000;

function armScheduledHardExit({
  timeoutMs = SCHEDULED_HARD_EXIT_MS,
  setTimeoutImpl = setTimeout,
  exitImpl = process.exit,
  getExitCode = () => process.exitCode,
  stderr = process.stderr,
} = {}) {
  const timer = setTimeoutImpl(() => {
    stderr.write(`scheduled runtime canary exceeded hard deadline (${timeoutMs}ms); forcing exit\n`);
    exitImpl(getExitCode() || 1);
  }, timeoutMs);
  timer?.unref?.();
  return timer;
}

function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    domainId: DEFAULT_CANARY_DOMAIN_ID,
    live: false,
    json: false,
    settleSmoke: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.rootDir = argv[++i];
    else if (arg === '--domain') options.domainId = argv[++i];
    else if (arg === '--live') options.live = true;
    else if (arg === '--fixture') options.live = false;
    else if (arg === '--settle-smoke') options.settleSmoke = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv, dependencies = {}) {
  const createLocalRuntimeImpl = dependencies.createLocalRuntimeImpl || createLocalAgentRuntime;
  const createFixtureReviewerImpl = dependencies.createFixtureReviewerImpl || createFixtureReviewerInner;
  const runFallbackCanaryImpl = dependencies.runFallbackCanaryImpl || runFallbackCanary;
  const runSettleSmokeImpl = dependencies.runSettleSmokeImpl || runRuntimeSettleSmoke;
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write('Usage: adversarial-runtime-canary [--root <dir>] [--domain <id>] [--live|--fixture] [--settle-smoke] [--json]\n');
    return 0;
  }

  // Live mode runs the real admission gates (memory-pressure + quota + cap)
  // against a real spawn — part of proving the lifeline. Fixture mode is
  // deterministic on purpose: a canned reviewer AND a permissive admission, so a
  // loaded CI runner's memory-pressure reading can't spuriously fail the canary.
  const localRuntime = options.live
    ? createLocalRuntimeImpl({ rootDir: options.rootDir })
    : createLocalRuntimeImpl({
      rootDir: options.rootDir,
      cliDirect: createFixtureReviewerImpl(),
      admissionImpl: async ({ budget = {} } = {}) => ({
        admit: true,
        budget: {
          requestedTokens: budget.maxTokens ?? 200_000,
          requestedWallMs: budget.maxWallMs ?? 300_000,
        },
      }),
    });

  const outcome = await runFallbackCanaryImpl({
    rootDir: options.rootDir,
    localRuntime,
    domainId: options.domainId,
  });
  const settleOutcome = options.settleSmoke
    ? await runSettleSmokeImpl({
      rootDir: options.rootDir,
      runtime: 'agent-runtime',
    })
    : null;

  if (options.json) {
    const payload = settleOutcome
      ? { fallbackCanary: outcome.status, settleSmoke: settleOutcome.smoke }
      : outcome.status;
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const verdict = outcome.ok ? 'PASS' : 'FAIL';
    stdout.write(
      `fallback canary: ${verdict} (${outcome.status.detail}, ${Math.round(outcome.durationMs / 1000)}s)\n`,
    );
    if (settleOutcome) {
      stdout.write(
        `agent-runtime settle smoke: ${settleOutcome.ok ? 'PASS' : 'FAIL'} (${settleOutcome.smoke.detail})\n`,
      );
    }
  }
  return outcome.ok && (!settleOutcome || settleOutcome.ok) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // ExitTimeOut only bounds launchd's stop grace; it does not bound a
  // StartCalendarInterval job. Keep this timer unref'd so it does not delay a
  // clean process, while still forcing an exit if an unexpected handle keeps
  // the event loop alive or either scheduled check never resolves.
  armScheduledHardExit();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { SCHEDULED_HARD_EXIT_MS, armScheduledHardExit, main };
