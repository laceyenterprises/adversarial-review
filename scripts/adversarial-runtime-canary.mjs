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

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), domainId: DEFAULT_CANARY_DOMAIN_ID, live: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.rootDir = argv[++i];
    else if (arg === '--domain') options.domainId = argv[++i];
    else if (arg === '--live') options.live = true;
    else if (arg === '--fixture') options.live = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err?.message || err}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write('Usage: adversarial-runtime-canary [--root <dir>] [--domain <id>] [--live|--fixture] [--json]\n');
    return 0;
  }

  // Live mode runs the real admission gates (memory-pressure + quota + cap)
  // against a real spawn — part of proving the lifeline. Fixture mode is
  // deterministic on purpose: a canned reviewer AND a permissive admission, so a
  // loaded CI runner's memory-pressure reading can't spuriously fail the canary.
  const localRuntime = options.live
    ? createLocalAgentRuntime({ rootDir: options.rootDir })
    : createLocalAgentRuntime({
      rootDir: options.rootDir,
      cliDirect: createFixtureReviewerInner(),
      admissionImpl: async ({ budget = {} } = {}) => ({
        admit: true,
        budget: {
          requestedTokens: budget.maxTokens ?? 200_000,
          requestedWallMs: budget.maxWallMs ?? 300_000,
        },
      }),
    });

  const outcome = await runFallbackCanary({
    rootDir: options.rootDir,
    localRuntime,
    domainId: options.domainId,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome.status, null, 2)}\n`);
  } else {
    const verdict = outcome.ok ? 'PASS' : 'FAIL';
    process.stdout.write(
      `fallback canary: ${verdict} (${outcome.status.detail}, ${Math.round(outcome.durationMs / 1000)}s)\n`,
    );
  }
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { main };
