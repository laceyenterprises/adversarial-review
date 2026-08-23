#!/usr/bin/env node
/**
 * AMV-03 — standalone standup verification from ARF's new home.
 *
 * ARF moved out of `apps/arf` in agent-os and into this repo at `frontend/`
 * (mounted as `tools/adversarial-review/frontend/` when agent-os inits the
 * submodule). The move is only real if the app still *stands up* from here, so
 * this script boots the packaged app exactly as an operator would and asserts
 * every surface the old home gave:
 *
 *   - the supervisor starts and the server listens          (`arf up`)
 *   - `/healthz` answers 200 from ARF's own standalone store
 *   - Screen A serves its shell, its modules, and its data
 *   - Screen B serves the governance panel, fully drawn
 *   - the pipeline paths resolve to *this repo's* root, not to the old
 *     `tools/adversarial-review/` prefix under an agent-os checkout
 *   - the gate CLI installs, arms, disarms, and checks with contract exit codes
 *   - the running server reads the same gate document the CLI just wrote
 *   - the ARF-09 end-to-end smoke passes
 *
 * Three rules shape how it does that.
 *
 * **It runs in a sandbox it owns.** The child environment is built from scratch
 * rather than inherited, with `ARF_STATE_ROOT` and `HOME` pointed inside a fresh
 * temp directory. No `ARF_MODE`, no `ARF_STORE_PATH`, no `ARF_CONFIG_FILE`
 * survives from the caller, so this can never attach to a live pipeline's
 * single-writer `reviews.db`, and `~/.arf/config.json` cannot silently change
 * what is being verified. The `/healthz` check asserts the store path really is
 * inside the sandbox rather than trusting that.
 *
 * **It tears down what it starts.** The supervisor is stopped and the sandbox
 * removed on every exit path — success, failure, exception, or Ctrl-C — and the
 * teardown is itself asserted: the port must stop answering and the sandbox must
 * be gone. A verification that leaves a server running has not verified that the
 * app can be stopped.
 *
 * **It is idempotent.** Every run gets its own `mkdtemp` sandbox and binds port
 * 0, so runs do not collide with each other or with a live ARF, and back-to-back
 * runs produce the same result.
 *
 * Screen A is client-rendered, so "renders" is asserted through what the server
 * can actually be held to: the shell carries the tab label and the mount point,
 * the modules that fill that mount point are served non-empty, and the data
 * endpoint answers 200 with an *available* store. That last part is the honest
 * empty state — zero pull requests from a store ARF can read is a true answer,
 * while an error or an unavailable store rendering as "no reviews" is the lie
 * this check exists to catch.
 *
 * Not wired into CI: the repo's workflow matrix is Node 20/22 and ARF's
 * `engines` require >= 23.4. This is an operator/standup command, run by hand
 * from a checkout that has the submodule inited.
 *
 *   node frontend/scripts/standup-verify.mjs [--json]
 *
 * Exits 0 when every check passes, 1 when any fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts -> frontend (the ARF root)
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// frontend -> the adversarial-review repo root, which is also ARF's default
// `pipelineRoot` from this location. The whole point of the move is that these
// two are one directory apart.
const PIPELINE_ROOT = resolve(ARF_ROOT, '..');
const ARF_BIN = join(ARF_ROOT, 'supervisor', 'bin', 'arf');
const E2E_SMOKE = join('server', 'test', 'e2e-smoke.test.mjs');

const BOOT_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const E2E_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 15_000;

/** Contract exit codes for `arf gate check` — see `gate/gate-contract.mjs`. */
const GATE_EXIT = { allowed: 0, usage: 2, disarmed: 3, refused: 4 };

const ACTOR = 'amv-03-standup-verify';

const results = [];
let failures = 0;

/**
 * Record one check. `fn` returns a detail string on success and throws on
 * failure; a throw is the failure, so an assertion and an unexpected exception
 * are reported the same way.
 */
async function check(name, fn) {
  // Once teardown has begun — a Ctrl-C mid-run — no further check may start.
  // Spawning into a sandbox that is being removed is how a "cleans up after
  // itself" script leaves a directory behind.
  if (teardown) {
    failures += 1;
    results.push({ name, ok: false, detail: 'not run: teardown already in progress' });
    return;
  }
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, detail: String(err?.message ?? err) });
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function mustEqual(actual, expected, what) {
  must(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * The environment ARF's children run in.
 *
 * Built from nothing rather than spread over `process.env`: an inherited
 * `ARF_MODE=in-os` or `ARF_STORE_PATH` would silently re-point this verification
 * at a live pipeline store, which is the one thing it must never touch.
 */
function sandboxEnv(sandbox) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(sandbox, 'home'),
    ARF_STATE_ROOT: sandbox,
    // Port 0 so concurrent runs — and a live ARF on 8787 — cannot collide.
    ARF_PORT: '0',
  };
}

/**
 * Short-lived children (the `arf` CLI calls, the smoke run) that are currently
 * running.
 *
 * Teardown has to wait for these, not just for the server: an `arf gate init`
 * still in flight when a Ctrl-C removes the sandbox will happily re-create
 * `<sandbox>/governance/` on its way out, and the "tears down what it starts"
 * promise would be broken by a directory nobody was watching.
 */
const liveChildren = new Set();

function run(command, args, { env, cwd = ARF_ROOT, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // A check can make several `arf` calls; an interrupt between two of them
    // must not spawn the rest into a sandbox teardown is already removing.
    if (teardown) {
      rejectPromise(new Error(`${args.join(' ')} not started: teardown in progress`));
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${args.join(' ')} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (err) => { clearTimeout(timer); liveChildren.delete(child); rejectPromise(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolvePromise({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}

/** SIGKILL a child and wait for it to actually be gone. */
function reap(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => {
    child.once('exit', r);
    child.kill('SIGKILL');
  });
}

/** `arf <args>` against the sandbox, returning the raw result (exit code included). */
function arf(sandbox, args, options = {}) {
  return run(process.execPath, [ARF_BIN, ...args], { env: sandboxEnv(sandbox), ...options });
}

async function until(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // An interrupt during the boot wait ends the wait now rather than in 30s.
    if (teardown) throw new Error('teardown in progress');
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what()} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function get(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body };
}

/** A 200 with a body, or a thrown failure naming the path. Never a silent empty screen. */
async function get200(baseUrl, path, { minBytes = 1 } = {}) {
  const res = await get(baseUrl, path);
  mustEqual(res.status, 200, `GET ${path} status`);
  must(
    res.body.length >= minBytes,
    `GET ${path} returned ${res.body.length} bytes, expected at least ${minBytes} — the screen would render empty`,
  );
  return res;
}

async function getJson200(baseUrl, path) {
  const res = await get200(baseUrl, path);
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error(`GET ${path} did not return JSON: ${err.message}`);
  }
}

function mustContain(haystack, needle, what) {
  must(haystack.includes(needle), `${what}: missing ${JSON.stringify(needle)}`);
}

// ---------------------------------------------------------------------------

// `arf-standup-verify-`, not `arf-standup-`: the standup test fixtures already
// use the shorter prefix, and a shared prefix would make this script's leftovers
// indistinguishable from theirs — exactly the question teardown has to answer.
const sandbox = mkdtempSync(join(tmpdir(), 'arf-standup-verify-'));
mkdirSync(join(sandbox, 'home'), { recursive: true });

let server = null;
let serverLog = '';
let baseUrl = null;
/**
 * The single in-flight teardown, or null before one starts.
 *
 * Memoized as a *promise* rather than tracked with a boolean, so a second
 * caller waits for the first teardown to finish instead of returning while it
 * is still reaping children. A `finally` that returned early here would let the
 * process exit before the sandbox was actually removed — which is how the
 * interrupted path first leaked a directory.
 */
let teardown = null;
let interrupted = false;

/**
 * Stop everything this run started and remove the sandbox. Safe to call more
 * than once; every caller awaits the same teardown.
 *
 * Order matters: every child is reaped *before* the sandbox is removed, so
 * nothing can re-create a directory inside it after the removal.
 */
function cleanup() {
  if (!teardown) teardown = runTeardown();
  return teardown;
}

async function runTeardown() {
  await Promise.all([...liveChildren].map(reap));
  liveChildren.clear();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((r) => server.once('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), STOP_TIMEOUT_MS)),
    ]);
    if (!exited) {
      // A supervisor that ignores SIGTERM is a finding, not something to leave
      // running: kill it, and let the teardown check report the escalation.
      // `reap` re-checks whether it is already gone, so a process that exited in
      // the gap between the race timing out and this line cannot hang teardown
      // waiting for an `exit` that has already fired.
      await reap(server);
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
}

// Ctrl-C during a boot wait must not strand a supervisor or a temp directory.
// The handler does not exit the process itself: it starts the teardown and lets
// the normal exit path await the same promise, so there is exactly one place
// that decides the exit code and it always runs after the sandbox is gone.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    // Swallowed here, reported below: the normal exit path awaits this same
    // promise and turns a failed teardown into a FAIL line rather than an
    // unhandled rejection that eats the report.
    cleanup().catch(() => {});
  });
}

async function main() {
  await check('boot', async () => {
    server = spawn(process.execPath, [ARF_BIN, 'up'], {
      cwd: ARF_ROOT,
      env: sandboxEnv(sandbox),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stdout.on('data', (chunk) => { serverLog += chunk; });
    server.stderr.on('data', (chunk) => { serverLog += chunk; });
    server.once('error', (err) => { serverLog += `spawn error: ${err.message}\n`; });

    const logFile = join(sandbox, 'logs', 'arf-server.log');
    const port = await until(() => {
      if (server.exitCode !== null) throw new Error(`arf up exited ${server.exitCode}: ${serverLog}`);
      if (!existsSync(logFile)) return null;
      const match = readFileSync(logFile, 'utf8').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      return match ? match[1] : null;
    }, { timeoutMs: BOOT_TIMEOUT_MS, what: () => `ARF did not listen (log: ${serverLog})` });

    baseUrl = `http://127.0.0.1:${port}`;
    return `listening on ${baseUrl}`;
  });

  await check('supervisor-status', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const { code, stdout } = await arf(sandbox, ['status', '--json']);
    mustEqual(code, 0, 'arf status exit code');
    const status = JSON.parse(stdout);
    const program = status.programs.find((p) => p.id === 'arf-server');
    must(program, 'arf status does not list the arf-server program');
    mustEqual(program.state, 'running', 'arf-server program state');
    return `arf-server running (pid ${program.pid}, ${program.restarts} restarts)`;
  });

  await check('healthz', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const health = await getJson200(baseUrl, '/healthz');
    mustEqual(health.status, 'ok', '/healthz status');
    mustEqual(health.store.mode, 'standalone', '/healthz store mode');
    mustEqual(health.store.available, true, '/healthz store availability');
    // The sandbox guarantee, asserted rather than assumed: a store outside the
    // sandbox would mean this run is reading somebody's live reviews.db.
    must(
      resolve(health.store.path).startsWith(resolve(sandbox)),
      `/healthz store path ${health.store.path} is outside the sandbox ${sandbox}`,
    );
    return `200 ok, standalone store at ${health.store.path}`;
  });

  await check('screen-a-shell', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const shell = await get200(baseUrl, '/', { minBytes: 500 });
    mustContain(shell.contentType, 'text/html', 'GET / content-type');
    mustContain(shell.body, 'Review dashboard', 'Screen A shell');
    mustContain(shell.body, 'id="dashboard-root"', 'Screen A mount point');
    mustContain(shell.body, '/dashboard.mjs', 'Screen A module tag');
    return `200, ${shell.body.length} bytes, dashboard shell present`;
  });

  await check('screen-a-modules', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    // The shell without these is a blank panel, which is exactly the "renders
    // empty" failure a 200 on `/` alone would wave through.
    const served = [];
    for (const asset of ['/dashboard.mjs', '/app.mjs', '/app.css']) {
      const res = await get200(baseUrl, asset, { minBytes: 100 });
      served.push(`${asset} ${res.body.length}B`);
    }
    return served.join(', ');
  });

  await check('screen-a-data', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const page = await getJson200(baseUrl, '/v1/reviews/prs?state=open&limit=25');
    // The honest empty state: an available store that returns zero rows. An
    // unreadable store rendering as "no reviews" is the failure being excluded.
    mustEqual(page.store.available, true, 'review store availability');
    must(Array.isArray(page.pullRequests), 'pullRequests is not an array');
    must(page.mirrorStats, '/v1/reviews/prs carries no mirrorStats');
    return `200, store available, ${page.pullRequests.length} open PR(s) — honest empty state`;
  });

  await check('screen-b-panel', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const panel = await get200(baseUrl, '/pipeline/panel', { minBytes: 1000 });
    mustContain(panel.contentType, 'text/html', 'GET /pipeline/panel content-type');
    // Every section of the governance panel, and every merge path in it. A path
    // that goes missing from the panel is the failure Screen B exists to prevent,
    // so a partially-drawn panel fails here rather than reading as "fine".
    for (const marker of [
      'data-stop-state=',
      '<h2>Daemon liveness</h2>',
      '<h2>Merge paths</h2>',
      '<h2>Kill switches</h2>',
      '<h2>Governance config</h2>',
      'data-path="hammer"',
      'data-path="daemon-clean"',
      'data-path="python-backstop"',
      'data-kill-switch="enabled"',
      'data-kill-switch="autonomousMergeExecutionEnabled"',
    ]) {
      mustContain(panel.body, marker, 'Screen B panel');
    }
    return `200, ${panel.body.length} bytes, all 3 merge paths and both kill switches drawn`;
  });

  await check('screen-b-data', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    const health = await getJson200(baseUrl, '/pipeline/health');
    for (const key of ['daemons', 'mergePaths', 'stopState', 'killSwitches', 'governance', 'reviewCycle']) {
      must(health[key], `/pipeline/health is missing "${key}"`);
    }
    mustEqual(health.mergePaths.length, 3, '/pipeline/health merge path count');
    must(health.stopState.state, '/pipeline/health carries no stop state');
    return `200, stopState=${health.stopState.state}, ${health.daemons.length} daemons, ${health.mergePaths.length} merge paths`;
  });

  await check('pipeline-root-rerooted', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    // The move's load-bearing assertion. Under `apps/arf` these resolved through
    // a `tools/adversarial-review/` prefix off the agent-os root; from here they
    // must resolve directly off this repo's root. Compared as absolute paths, so
    // this holds whether the checkout is standalone or mounted at
    // `tools/adversarial-review` inside an agent-os tree.
    const health = await getJson200(baseUrl, '/pipeline/health');
    const watcher = health.daemons.find((daemon) => daemon.id === 'watcher');
    must(watcher?.source?.path, '/pipeline/health reports no watcher heartbeat source');
    mustEqual(
      resolve(watcher.source.path),
      join(PIPELINE_ROOT, 'data', 'watcher-heartbeat.json'),
      'watcher heartbeat path',
    );
    const expectedConfig = join(PIPELINE_ROOT, 'config.yaml');
    const configSource = health.governance.sources.find((s) => resolve(s.path) === expectedConfig);
    must(configSource, `governance config sources do not include ${expectedConfig}`);
    return `pipelineRoot=${PIPELINE_ROOT} (config.yaml present=${configSource.present})`;
  });

  await check('gate-uninstalled-fails-closed', async () => {
    const status = await arf(sandbox, ['gate', 'status']);
    mustEqual(status.code, 0, 'arf gate status exit code');
    mustContain(status.stdout, 'not installed', 'arf gate status on a fresh state root');
    // No gate document must refuse, not allow: the gate is fail-closed by design.
    const probe = await arf(sandbox, ['gate', 'check', '--path', 'hammer']);
    mustEqual(probe.code, GATE_EXIT.refused, 'arf gate check exit code with no gate installed');
    return `status reports "not installed"; check refuses with exit ${GATE_EXIT.refused}`;
  });

  await check('gate-init', async () => {
    const init = await arf(sandbox, ['gate', 'init', '--actor', ACTOR, '--reason', 'AMV-03 standup verification']);
    mustEqual(init.code, 0, 'arf gate init exit code');
    mustContain(init.stdout, 'gate created', 'arf gate init');
    const status = await arf(sandbox, ['gate', 'status']);
    mustEqual(status.code, 0, 'arf gate status exit code');
    mustContain(status.stdout, 'master: armed', 'arf gate status after init');
    const check0 = await arf(sandbox, ['gate', 'check', '--path', 'hammer']);
    mustEqual(check0.code, GATE_EXIT.allowed, 'arf gate check exit code when armed');
    return `gate installed at seq 1, hammer armed, check exits ${GATE_EXIT.allowed}`;
  });

  await check('gate-disarm', async () => {
    const disarm = await arf(sandbox, ['gate', 'disarm', '--path', 'hammer', '--actor', ACTOR, '--reason', 'AMV-03 standup verification']);
    mustEqual(disarm.code, 0, 'arf gate disarm exit code');
    mustContain(disarm.stdout, 'disarmed hammer', 'arf gate disarm');
    // Exit 3, not 4: an operator stop and a broken gate are different answers,
    // and a wrapper pages on only one of them.
    const probe = await arf(sandbox, ['gate', 'check', '--path', 'hammer']);
    mustEqual(probe.code, GATE_EXIT.disarmed, 'arf gate check exit code when disarmed');
    // The other paths must be untouched by a scoped disarm.
    const other = await arf(sandbox, ['gate', 'check', '--path', 'daemon-clean']);
    mustEqual(other.code, GATE_EXIT.allowed, 'arf gate check exit code for an unscoped path');
    return `hammer disarmed (exit ${GATE_EXIT.disarmed}), daemon-clean untouched (exit ${GATE_EXIT.allowed})`;
  });

  await check('gate-visible-to-server', async () => {
    must(baseUrl, 'skipped: ARF did not boot');
    // The CLI wrote the gate after the server booted. The server must read the
    // live document, not a boot-time snapshot — a cached gate is a stop-state
    // that was true once.
    const gate = await getJson200(baseUrl, '/v1/governance/gate');
    mustEqual(gate.installed, true, 'server-side gate installed');
    mustEqual(gate.effective.hammer, false, 'server-side effective hammer state');
    mustEqual(gate.effective['daemon-clean'], true, 'server-side effective daemon-clean state');
    mustEqual(gate.decisions.hammer.code, 'disarmed-path', 'server-side hammer decision code');
    return 'server reports hammer disarmed-path, daemon-clean armed — same document as the CLI';
  });

  await check('gate-rearm', async () => {
    const arm = await arf(sandbox, ['gate', 'arm', '--path', 'hammer', '--actor', ACTOR, '--reason', 'AMV-03 standup verification complete']);
    mustEqual(arm.code, 0, 'arf gate arm exit code');
    mustContain(arm.stdout, 'armed hammer', 'arf gate arm');
    const probe = await arf(sandbox, ['gate', 'check', '--path', 'hammer', '--json']);
    mustEqual(probe.code, GATE_EXIT.allowed, 'arf gate check exit code after re-arm');
    const decision = JSON.parse(probe.stdout);
    mustEqual(decision.allowed, true, 'gate check decision.allowed');
    mustEqual(decision.code, 'armed', 'gate check decision.code');
    mustEqual(decision.setBy, ACTOR, 'gate check decision.setBy');
    return `hammer re-armed at seq ${decision.gate.seq} by ${decision.setBy}`;
  });

  await check('gate-audit', async () => {
    const audit = await arf(sandbox, ['gate', 'audit', '--json']);
    mustEqual(audit.code, 0, 'arf gate audit exit code');
    const entries = JSON.parse(audit.stdout);
    const events = entries.map((entry) => entry.event);
    // Every flip this run made, in order, attributed to this run. An audit that
    // loses an entry is a governance record that cannot be trusted.
    mustEqual(events.join(','), 'init,disarm,arm', 'gate audit event sequence');
    must(entries.every((entry) => entry.actor === ACTOR), `gate audit entries are not all attributed to ${ACTOR}`);
    mustEqual(entries.at(-1).seq, 3, 'gate audit final seq');
    return `3 entries (${events.join(' → ')}), all attributed to ${ACTOR}`;
  });

  await check('e2e-smoke', async () => {
    // Ambient ARF_* is stripped for the same reason the server's env is built
    // from scratch; ARF_TEST_* is the smoke's own fixture wiring and stays.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ARF_') || key.startsWith('ARF_TEST_')),
    );
    const smoke = await run(
      process.execPath,
      ['--test', '--test-reporter=tap', E2E_SMOKE],
      { env, timeoutMs: E2E_TIMEOUT_MS },
    );
    const output = `${smoke.stdout}${smoke.stderr}`;
    const pass = output.match(/^# pass (\d+)$/m);
    const fail = output.match(/^# fail (\d+)$/m);
    mustEqual(smoke.code, 0, `node --test ${E2E_SMOKE} exit code (output: ${output.slice(-2000)})`);
    must(pass, `could not read a pass count from ${E2E_SMOKE} output`);
    must(Number(pass[1]) >= 1, `${E2E_SMOKE} ran ${pass[1]} tests, expected at least 1`);
    mustEqual(fail?.[1], '0', `${E2E_SMOKE} failure count`);
    return `pass ${pass[1]}, fail ${fail[1]}`;
  });

  // Teardown is a check, not an epilogue: "leaves nothing running" is part of
  // what this script promises.
  await check('teardown', async () => {
    const url = baseUrl;
    await cleanup();
    if (url) {
      let stillServing = false;
      try {
        await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
        stillServing = true;
      } catch {
        stillServing = false;
      }
      must(!stillServing, `${url} is still answering after teardown`);
    }
    must(!existsSync(sandbox), `sandbox ${sandbox} survived teardown`);
    must(server === null || server.exitCode !== null || server.signalCode !== null, 'the supervisor is still running');
    return `supervisor stopped, ${url ?? 'port'} refused, sandbox removed`;
  });
}

const wantsJson = process.argv.includes('--json');

try {
  await main();
} catch (err) {
  failures += 1;
  results.push({ name: 'harness', ok: false, detail: String(err?.stack ?? err) });
} finally {
  // A teardown that itself fails must still be reported, not thrown past the
  // report — and not reported twice when the `teardown` check already caught it.
  try {
    await cleanup();
  } catch (err) {
    if (!results.some((result) => result.name === 'teardown')) {
      failures += 1;
      results.push({ name: 'teardown', ok: false, detail: String(err?.message ?? err) });
    }
  }
}

const summary = {
  ok: failures === 0,
  arfRoot: ARF_ROOT,
  pipelineRoot: PIPELINE_ROOT,
  sandbox,
  checks: results,
  passed: results.length - failures,
  failed: failures,
};

if (wantsJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const width = Math.max(...results.map((r) => r.name.length), 0);
  process.stdout.write([
    'ARF standup verification (AMV-03)',
    `  arf root       ${ARF_ROOT}`,
    `  pipeline root  ${PIPELINE_ROOT}`,
    `  sandbox        ${sandbox}`,
    '',
    ...results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`),
    '',
    `${results.length} checks: ${summary.passed} passed, ${summary.failed} failed`,
    '',
  ].join('\n'));
}

// 130 for an interrupt, so a Ctrl-C is not mistaken for a failed standup.
process.exit(interrupted ? 130 : (failures === 0 ? 0 : 1));
