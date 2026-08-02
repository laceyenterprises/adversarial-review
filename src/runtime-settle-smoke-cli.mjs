import { fileURLToPath } from 'node:url';

import { createOsDispatchAgentRuntime } from './adapters/agent-runtime/os-dispatch/index.mjs';
import { writeSettleSmokeResult } from './adapters/agent-runtime/settle-smoke.mjs';

const USAGE = `\
Usage:
  adversarial-review runtime settle-smoke --runtime agent-runtime [--root <dir>] [--json]
`;

const DEFAULT_RUNTIME = 'agent-runtime';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const options = { rootDir: process.cwd(), runtime: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--runtime') {
      if (!argv[i + 1]) throw new Error('--runtime requires a runtime name');
      options.runtime = argv[++i];
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

function buildSettleSmokeRequest({ now = () => new Date() } = {}) {
  const at = now().toISOString();
  return {
    role: { id: 'reviewer:agent-runtime-settle-smoke', kind: 'reviewer', model: 'codex' },
    promptSet: 'runtime-settle-smoke',
    promptStage: 'first',
    subjectContent: {
      ref: {
        domainId: 'runtime-settle-smoke',
        subjectExternalId: 'sdk-settle-smoke-fixture',
        revisionRef: `settle-smoke-${at}`,
      },
      representation: [
        'Synthetic runtime settle smoke subject.',
        'Return a concise review verdict in the normal review format.',
        'This is a fixture subject, not a real PR.',
      ].join('\n'),
      observedAt: at,
    },
    idempotencyKey: `runtime-settle-smoke:sdk-settle-smoke-fixture:${at}:first:reviewer:1`,
    budget: { maxTokens: 50_000, maxWallMs: DEFAULT_TIMEOUT_MS },
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function workerRunIdOf(result) {
  const usage = result?.usage;
  return usage?.workerRunId || usage?.worker_run_id || null;
}

async function runRuntimeSettleSmoke({
  rootDir,
  runtime = DEFAULT_RUNTIME,
  now = () => new Date(),
  createRuntime = () => createOsDispatchAgentRuntime(),
  writeResultImpl = writeSettleSmokeResult,
} = {}) {
  if (!rootDir) throw new TypeError('runRuntimeSettleSmoke requires rootDir');
  if (runtime !== DEFAULT_RUNTIME) {
    throw new Error(`unsupported settle-smoke runtime: ${runtime}`);
  }

  const request = buildSettleSmokeRequest({ now });
  const startedAt = now().toISOString();
  const runtimeAdapter = createRuntime({ runtime });
  let handle = null;
  let result = null;
  let failure = null;

  try {
    handle = await runtimeAdapter.run(request);
    result = await handle.await();
  } catch (err) {
    failure = err?.message || String(err);
  }

  const workerRunId = workerRunIdOf(result);
  const smoke = {
    at: startedAt,
    startedAt,
    runtime,
    requestId: handle?.runRef || request.idempotencyKey,
    dispatched: Boolean(handle?.runRef),
    settled: result?.status === 'completed',
    attributed: Boolean(workerRunId),
    workerRunId,
    status: 'fail',
    detail: failure || null,
  };

  if (failure) {
    smoke.detail = `settle smoke failed before terminal result: ${failure}`;
  } else if (!smoke.dispatched) {
    smoke.detail = 'settle smoke did not receive a dispatch run reference';
  } else if (!smoke.settled) {
    smoke.detail = `settle smoke did not settle cleanly: status=${result?.status ?? 'unknown'}`;
  } else if (!smoke.attributed) {
    smoke.detail = 'settle smoke settled without worker_run_id attribution';
  } else {
    smoke.status = 'pass';
    smoke.detail = 'agent-runtime dispatch settled with worker_run_id attribution';
  }

  const persisted = writeResultImpl(rootDir, runtime, smoke);
  return { ok: smoke.status === 'pass', smoke: persisted || smoke, result };
}

async function runtimeSettleSmokeMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.runtime !== DEFAULT_RUNTIME) {
    stderr.write(`error: settle-smoke currently supports only ${DEFAULT_RUNTIME}\n\n${USAGE}`);
    return 2;
  }

  let outcome;
  try {
    outcome = await runRuntimeSettleSmoke({
      rootDir: options.rootDir,
      runtime: options.runtime,
      now: io.now,
      createRuntime: io.createRuntime,
      writeResultImpl: io.writeResultImpl,
    });
  } catch (err) {
    stderr.write(`error: runtime settle-smoke failed: ${err?.message || err}\n`);
    return 1;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(outcome.smoke, null, 2)}\n`);
  } else {
    stdout.write(`${outcome.smoke.status.toUpperCase()} ${outcome.smoke.runtime} ${outcome.smoke.at}\n`);
    stdout.write(`${outcome.smoke.detail}\n`);
  }
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runtimeSettleSmokeMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export {
  buildSettleSmokeRequest,
  runRuntimeSettleSmoke,
  runtimeSettleSmokeMain,
  workerRunIdOf,
};
