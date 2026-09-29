// CCX-08 — multi-identity agy reviewer (credential-capacity-expansion SPEC
// §2b, §3 CCX-08). The pinned commands CCX-07 installs are root-owned and
// reached through sudo; here a fake install stands in for both: a fake `sudo`
// that switches HOME/USER per target user, and fake pinned agy, keychain
// helper and workspace helper scripts with the same verbs and output lines.
//
// Everything here runs as one OS user, so no uid boundary is crossed. The
// fake sudo forks the command, as real sudo does, and the fake agy stands in
// for a process the HQ owner cannot signal by putting it in its own process
// group (`set -m`), out of reach of the reviewer child's group kill.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  AGY_IDENTITY_REVIEW_ID_ENV,
  AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS,
  AGY_IDENTITY_USER_ENV,
  AGY_REVIEWER_LIBEXEC_DIR,
  AGY_REVIEWER_PINNED_AGY,
  AGY_REVIEWER_SUDO,
  PINNED_COMMAND_ENV,
  cleanupAgyReviewWorkspace,
  createAgyReviewerIdentityPool,
  extractAgyReviewWorkspace,
  finishAgyIdentityReview,
  agyReviewSurvivors,
  listUserProcesses,
  prepareAgyIdentityReview,
  referenceAgySettingsFromEnv,
  resolveAgyReviewIdentityFromEnv,
  resolveAgyReviewerIdentityPlan,
  resolveHqOwner,
  runPinnedCommand,
  runWithAgyReviewerIdentity,
} from '../src/agy-reviewer-identities.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { createAgentRuntimeReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/agent-runtime/index.mjs';
import { createHealthRouter } from '../src/adapters/agent-runtime/router/index.mjs';
import { reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';
import { resolveGeminiCredentialConcurrencyForDispatchCandidates } from '../src/reviewer-runtime-support.mjs';
import { domainPipelineGeminiSeatCount } from '../src/reviewer-spawn-settle.mjs';
import { reviewerDispatchCandidateUsesGemini, runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';
import { runAgyReviewerStartupChecks } from '../src/watcher-agy-startup-preflight.mjs';

const REVIEWER_A = 'agentos-reviewer';
const REVIEWER_B = 'agentos-reviewer2';
const HQ_OWNER = resolveHqOwner();
const VALID_REVIEW = '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Summary\nClean.\n\n## Verdict\nComment only';
// What the HQ-owner path's environment carries of the agy settings keys.
const HQ_ENV = {
  HOME: '/Users/hq-owner',
  HTTPS_PROXY: 'http://proxy.local:3128',
  NO_PROXY: 'localhost,127.0.0.1',
  AGY_KEYCHAIN_PATH: '/Users/hq-owner/Library/Keychains/login.keychain-db',
};
const HQ_SETTINGS = referenceAgySettingsFromEnv(HQ_ENV);
// A reviewer runtime that hands `subjectContext.agyIdentity` to the child.
const LEASING_ADAPTER = { describe: () => ({ id: 'cli-direct', capabilities: { agyReviewerIdentity: true } }) };

const FAKE_SUDO = `#!/bin/bash
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$1" != -n ] || [ "$2" != -H ] || [ "$3" != -u ]; then echo "fake sudo: unexpected argv $*" >&2; exit 64; fi
U="$4"; shift 4
CMD="$1"; shift
case "$CMD" in "$ROOT"/libexec/*) ;; *) echo "fake sudo: not a pinned command: $CMD" >&2; exit 1 ;; esac
# What reached sudo from the caller: only the minimal pinned-command env.
echo "$U $(basename "$CMD") vars=$(env | cut -d= -f1 | sort | tr '\\n' ',')" >> "$ROOT/sudo.log"
export HOME="$ROOT/home/$U" USER="$U" LOGNAME="$U" FAKE_ROOT="$ROOT"
# Like real sudo: the command runs in a child process that sudo waits for.
"$CMD" "$@" <&0 &
wait $!
`;

// Like CCX-07's agy-reviewer-agy: settings come only from the root-owned file.
const FAKE_PINNED_AGY = `#!/bin/bash
set -a; . "$FAKE_ROOT/settings/$USER.conf"; set +a
if [ "\${1-}" = --prompt-stdin ]; then
  shift
  prompt=""; IFS= read -r -d '' prompt || true
  args=(); prev=""
  for arg in "$@"; do
    if [ "$prev" = --print ]; then arg="$prompt"; fi
    args+=("$arg"); prev="$arg"
  done
  set -- "\${args[@]}"
fi
exec "$FAKE_ROOT/bin/agy" "$@"
`;

const FAKE_AGY = `#!/bin/bash
add=""; prev=""; model=""
for a in "$@"; do
  [ "$prev" = --add-dir ] && add="$a"
  [ "$prev" = --model ] && model="$a"
  prev="$a"
done
touch "$FAKE_ROOT/running-$USER"
if [ -e "$HOME/.agy-wait-peer" ]; then
  for _ in $(seq 1 100); do [ "$(ls "$FAKE_ROOT" | grep -c '^running-')" -ge 2 ] && break; sleep 0.1; done
  echo "peers=$(ls "$FAKE_ROOT" | grep -c '^running-')" > "$HOME/peers"
fi
printf '{"user":"%s","home":"%s","cwd":"%s","addDir":"%s","mode":"%s","model":"%s","proxy":"%s","noProxy":"%s","keychain":"%s","sawSnapshot":"%s"}\\n' \\
  "$USER" "$HOME" "$(pwd -P)" "$add" "$(if [ "$(uname)" = Darwin ]; then stat -f %Lp "$add"; else stat -c %a "$add"; fi)" "$model" "\${HTTPS_PROXY-}" "\${NO_PROXY-}" "\${AGY_KEYCHAIN_PATH-}" \\
  "$([ -f "$add/README.md" ] && echo yes || echo no)" >> "$HOME/agy-calls.log"
[ -e "$HOME/.agy-hang" ] && sleep 30
# A language server left behind that the HQ owner cannot signal: its own
# process group, holding the inherited stdout.
if [ -e "$HOME/.agy-linger" ]; then set -m; sleep 20 & echo $! > "$HOME/survivor.pid"; set +m; fi
# A hung agy whose worker survives the timeout kill.
if [ -e "$HOME/.agy-hang-survives" ]; then set -m; sleep 30 & echo $! > "$HOME/survivor.pid"; set +m; wait; fi
if [ -e "$HOME/.agy-fail" ]; then echo "agy failed" >&2; exit 1; fi
printf '%s\\n' "$REVIEW_TEXT"
`;

const FAKE_KEYCHAIN_HELPER = `#!/bin/bash
case "$1" in
  status)
    echo "keychain.exists=yes"
    if [ -e "$HOME/.item-missing" ]; then echo "keychain.item=missing"; else echo "keychain.item=readable"; fi
    echo "settings.valid=yes" ;;
  settings) grep -v '^#' "$FAKE_ROOT/settings/$USER.conf" | sort ;;
  probe)
    echo "probe" >> "$HOME/probes.log"
    if [ -e "$HOME/.probe-fails" ]; then echo "probe.ok=no"; exit 1; fi
    echo "probe.ok=yes" ;;
  *) exit 64 ;;
esac
`;

const FAKE_WORKSPACE_HELPER = `#!/bin/bash
S="$HOME/scratch"
case "$1" in
  extract)
    d="$S/$2"
    [ -e "$d" ] && exit 73
    mkdir -p "$S" && mkdir -m 700 "$d" || exit 65
    tar -xf - -C "$d" || { rm -rf "$d"; exit 65; }
    echo "workspace.dir=$d" ;;
  cleanup)
    d="$S/$2"
    if [ -e "$d" ]; then rm -rf "$d"; echo "workspace.removed=yes"; else echo "workspace.removed=no"; fi ;;
  sweep)
    n=0
    if [ -d "$S" ]; then
      for d in $(find "$S" -mindepth 1 -maxdepth 1 -type d -mmin +720); do rm -rf "$d"; n=$((n+1)); done
    fi
    echo "workspace.swept=$n" ;;
  *) exit 64 ;;
esac
`;

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Settings file lines as CCX-07 writes them: the keychain relative to HOME
// (`~/…`, which the pinned agy's shell expands to the identity's own HOME).
function settingsFileFor(reference) {
  return `${reference.join('\n')}\n`;
}

function makeFakeInstall({ users = [REVIEWER_A, REVIEWER_B] } = {}) {
  const root = realpathSync(mkdtempSync(join('/tmp', 'ccx08-')));
  for (const dir of ['bin', 'libexec', 'settings', 'home']) mkdirSync(join(root, dir));
  const sudo = join(root, 'bin', 'sudo');
  const libexecDir = join(root, 'libexec');
  writeExecutable(sudo, FAKE_SUDO);
  writeExecutable(join(root, 'bin', 'agy'), FAKE_AGY.replace('"$REVIEW_TEXT"', `'${VALID_REVIEW.replace(/'/gu, "'\\''")}'`));
  writeExecutable(join(libexecDir, AGY_REVIEWER_PINNED_AGY), FAKE_PINNED_AGY);
  writeExecutable(join(libexecDir, 'agy-reviewer-keychain-helper'), FAKE_KEYCHAIN_HELPER);
  writeExecutable(join(libexecDir, 'agy-reviewer-workspace-helper'), FAKE_WORKSPACE_HELPER);
  const home = (user) => join(root, 'home', user);
  const settingsPath = (user) => join(root, 'settings', `${user}.conf`);
  for (const user of users) {
    mkdirSync(home(user));
    writeFileSync(settingsPath(user), settingsFileFor(HQ_SETTINGS));
  }
  const runPinned = (opts) => runPinnedCommand({ ...opts, sudo, libexecDir });
  const spawnCalls = [];
  // The real spawnWithInput, pointed at the fake install instead of
  // /usr/bin/sudo and /usr/local/libexec/agent-os.
  const spawnWithInput = (command, args, opts) => {
    spawnCalls.push({ command, args: [...args], env: opts.env, cwd: opts.cwd, input: opts.input });
    const redirected = command === AGY_REVIEWER_SUDO
      ? [sudo, args.map((arg) => (arg.startsWith(`${AGY_REVIEWER_LIBEXEC_DIR}/`) ? join(libexecDir, arg.slice(AGY_REVIEWER_LIBEXEC_DIR.length + 1)) : arg))]
      : [command, args];
    return harness.spawnWithInput(redirected[0], redirected[1], { ...opts, ...(opts.testTimeout ? { timeout: opts.testTimeout } : {}) });
  };
  const agyCalls = (user) => {
    const path = join(home(user), 'agy-calls.log');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };
  const sudoLog = () => (existsSync(join(root, 'sudo.log')) ? readFileSync(join(root, 'sudo.log'), 'utf8') : '');
  return {
    root, sudo, libexecDir, home, settingsPath, runPinned, spawnWithInput, spawnCalls, agyCalls, sudoLog,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function quietLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, log: push('log'), info: push('info'), warn: push('warn'), error: push('error') };
}

function makePool(fake, {
  identities = [HQ_OWNER, REVIEWER_A, REVIEWER_B],
  env = {},
  log = quietLog(),
  runtime = 'antigravity',
  checkHqOwnerAuthImpl = async () => ({ ok: true }),
  readBootstrapRecordImpl = () => null,
  runPinnedImpl = fake?.runPinned,
  // The fake identities are not real OS users, so `ps -U` cannot see them;
  // by default nothing survives a review.
  listUserProcessesImpl = async () => ({ ok: true, processes: [] }),
  // No reviewer run records: no review from a previous watcher.
  readActiveRunRecordsImpl = () => [],
  readRunRecordImpl = () => null,
  isPgidAliveImpl = () => false,
  deliverAlertImpl = async () => ({ id: 'test' }),
  leaseWaitMs = 0,
  now,
} = {}) {
  return createAgyReviewerIdentityPool({
    env,
    log,
    hqOwner: HQ_OWNER,
    loadIdentities: () => identities,
    resolveRuntime: () => runtime,
    runPinnedImpl,
    checkHqOwnerAuthImpl,
    readBootstrapRecordImpl,
    referenceSettings: () => HQ_SETTINGS,
    listUserProcessesImpl,
    readActiveRunRecordsImpl,
    readRunRecordImpl,
    isPgidAliveImpl,
    deliverAlertImpl,
    sleepImpl: async () => {},
    leaseWaitMs,
    ...(now ? { now } : {}),
  });
}

// reviewWithGemini with the added-identity plumbing pointed at the fake.
function identityReviewOptions(fake, { snapshotDir, agyIdentity, finishCalls = [], testTimeout = 0 } = {}) {
  return {
    resolveGeminiRuntimeImpl: () => 'antigravity',
    reviewerSubprocessCwd: snapshotDir,
    agyIdentity,
    checkoutGeminiCredentialImpl: async () => { throw new Error('an added identity must not check out a broker credential'); },
    assertAgyAuthImpl: async () => { throw new Error('an added identity must not run the HQ-owner auth probe'); },
    prepareAgyIdentityReviewImpl: (run, opts) => prepareAgyIdentityReview(run, {
      ...opts,
      // The production parent is macOS's /private/tmp; CI runs on Linux.
      cwdParent: fake.root,
      extractImpl: (args) => extractAgyReviewWorkspace({ ...args, runPinnedImpl: fake.runPinned }),
    }),
    finishAgyIdentityReviewImpl: async (run, opts) => {
      const cleanup = await finishAgyIdentityReview(run, {
        ...opts,
        cleanupImpl: (args) => cleanupAgyReviewWorkspace({ ...args, runPinnedImpl: fake.runPinned }),
      });
      finishCalls.push({ ...run, cleanup });
      return cleanup;
    },
    spawnAgyReviewImpl: (opts) => harness.spawnAgyReview({
      ...opts,
      spawnWithInputImpl: (command, args, spawnOpts) => fake.spawnWithInput(command, args, { ...spawnOpts, testTimeout }),
    }),
    retryDelaysMs: [],
    log: quietLog(),
  };
}

function makeSnapshot(root) {
  const dir = join(root, 'snapshot');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# snapshot\n');
  writeFileSync(join(dir, 'src', 'index.mjs'), 'export {};\n');
  chmodSync(dir, 0o700);
  return dir;
}

// ── Identity plan ───────────────────────────────────────────────────────────

test('CCX-08: an unset identities key means the HQ owner only, with no sudo and the broker cap', async () => {
  for (const identities of [[], null, [HQ_OWNER]]) {
    const plan = resolveAgyReviewerIdentityPlan({ identities, hqOwner: HQ_OWNER, env: {} });
    assert.equal(plan.multi, false);
    assert.deepEqual(plan.identities, [{ user: HQ_OWNER, hqOwner: true }]);
  }
  let pinnedCalls = 0;
  const pool = makePool(null, { identities: [], runPinnedImpl: async () => { pinnedCalls += 1; return { code: 0, stdout: '' }; } });
  assert.equal(await pool.refreshReadiness(), null);
  let brokerFetches = 0;
  const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates([{ reviewerModel: 'gemini' }], {
    env: { CQP_BROKER_URL: 'http://broker.local' },
    readSharedSecret: async () => 'secret',
    fetchCredentialConcurrency: async () => { brokerFetches += 1; return 3; },
    identityPool: pool,
  });
  assert.equal(cap, 3, 'the broker credential count stays the cap');
  assert.equal(brokerFetches, 1);
  assert.equal(pinnedCalls, 0, 'no sudo with a single identity');
  assert.deepEqual(await pool.sweepAll(), []);
});

test('CCX-08: [<HQ owner>, agentos-reviewer] gives a cap of 2, the ready count, not the broker count', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const pool = makePool(fake, { identities: [HQ_OWNER, REVIEWER_A] });
    let brokerFetches = 0;
    const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates([{ reviewerModel: 'gemini', reviewerRuntimeAdapter: LEASING_ADAPTER }], {
      env: {},
      readSharedSecret: async () => 'secret',
      fetchCredentialConcurrency: async () => { brokerFetches += 1; return 7; },
      identityPool: pool,
    });
    assert.equal(cap, 2);
    assert.equal(brokerFetches, 0, 'the broker credential count is not consulted');
    // Only ready identities count: a missing keychain item drops the cap to 1.
    writeFileSync(join(fake.home(REVIEWER_A), '.item-missing'), '');
    assert.equal(await pool.refreshReadiness(), 1);
    // A non-Gemini candidate set skips both.
    assert.equal(await resolveGeminiCredentialConcurrencyForDispatchCandidates([{ reviewerModel: 'codex' }], { identityPool: pool }), null);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: on the agent-runtime reviewer runtime the identities are inert: broker cap, no lease, no sudo', async () => {
  const fake = makeFakeInstall();
  try {
    // The configured code-pr runtime: the health router cannot carry agyIdentity.
    const router = createHealthRouter({ localRuntime: { async run() { throw new Error('not run'); } } });
    const agentRuntime = createAgentRuntimeReviewerRuntimeAdapter({ rootDir: fake.root, agentRuntime: router, logger: quietLog() });
    assert.notEqual(agentRuntime.describe().capabilities.agyReviewerIdentity, true);
    let pinnedCalls = 0;
    const pool = makePool(fake, {
      runPinnedImpl: async (opts) => { pinnedCalls += 1; return fake.runPinned(opts); },
    });
    const brokerOptions = {
      env: {},
      readSharedSecret: async () => 'secret',
      fetchCredentialConcurrency: async () => 5,
      identityPool: pool,
    };
    const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates(
      [{ reviewerModel: 'gemini', reviewerRuntimeAdapter: agentRuntime }],
      brokerOptions,
    );
    assert.equal(cap, 5, 'the broker count stays the cap, not the 3 configured identities');
    assert.equal(pinnedCalls, 0, 'no readiness pass through sudo for a runtime that cannot lease');
    // The primary adapter is the fallback for a candidate without its own.
    assert.equal(await resolveGeminiCredentialConcurrencyForDispatchCandidates([{ reviewerModel: 'gemini' }], {
      ...brokerOptions,
      resolveCandidateAdapter: () => agentRuntime,
    }), 5);

    // Three concurrent Gemini reviews all run on the pre-CCX-08 path: none
    // waits for a lease and none fails with a synthetic reviewer-timeout.
    const log = quietLog();
    const seen = [];
    const results = await Promise.all([1, 2, 3].map(() => runWithAgyReviewerIdentity(
      { reviewerModel: 'gemini', adapter: agentRuntime, pool, log },
      async (identity) => { seen.push(identity); return { ok: true }; },
    )));
    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.deepEqual(seen, [null, null, null]);
    assert.equal(pool.snapshot().some((state) => state.leased), false);
    assert.match(log.lines.join('\n'), /runtime agent-runtime cannot run a review as an added identity/);

    // Mixed runtimes in one drain: the shared cap is bounded by both counts.
    assert.equal(await resolveGeminiCredentialConcurrencyForDispatchCandidates([
      { reviewerModel: 'gemini', reviewerRuntimeAdapter: agentRuntime },
      { reviewerModel: 'gemini', reviewerRuntimeAdapter: LEASING_ADAPTER },
    ], { ...brokerOptions, fetchCredentialConcurrency: async () => 2 }), 2);
    assert.equal(await resolveGeminiCredentialConcurrencyForDispatchCandidates([
      { reviewerModel: 'gemini', reviewerRuntimeAdapter: agentRuntime },
      { reviewerModel: 'gemini', reviewerRuntimeAdapter: LEASING_ADAPTER },
    ], brokerOptions), 3);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: an extract helper that exits without reading stdin does not hang on a snapshot larger than the pipe buffer', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    // Incompressible and well past the ~64 KB pipe buffer.
    writeFileSync(join(snapshotDir, 'blob.bin'), randomBytes(4 * 1024 * 1024));
    // The review id already exists, so the helper exits 73 before reading stdin.
    mkdirSync(join(fake.home(REVIEWER_A), 'scratch', 'agy-taken'), { recursive: true });
    const startedAt = Date.now();
    await assert.rejects(
      extractAgyReviewWorkspace({ user: REVIEWER_A, reviewId: 'agy-taken', sourceDir: snapshotDir, runPinnedImpl: fake.runPinned, timeoutMs: 60_000 }),
      (err) => err.reason === 'agy-identity-extract-failed' && /exited 73/.test(err.message),
    );
    // A helper whose spawn failed (it never reads stdin at all).
    await assert.rejects(
      extractAgyReviewWorkspace({
        user: REVIEWER_A,
        reviewId: 'agy-nospawn',
        sourceDir: snapshotDir,
        runPinnedImpl: async () => ({ code: null, stdout: '', stderr: 'spawn EACCES', timedOut: false }),
        timeoutMs: 60_000,
      }),
      /agy-identity|workspace extract as agentos-reviewer exited abnormally/,
    );
    // A helper that throws.
    await assert.rejects(
      extractAgyReviewWorkspace({
        user: REVIEWER_A,
        reviewId: 'agy-throws',
        sourceDir: snapshotDir,
        runPinnedImpl: async () => { throw new Error('helper blew up'); },
        timeoutMs: 60_000,
      }),
      /helper blew up/,
    );
    assert.ok(Date.now() - startedAt < 15_000, 'each failed extract settles promptly, not at the extract timeout');
    // The same large snapshot still extracts when the helper drains it.
    const ok = await extractAgyReviewWorkspace({ user: REVIEWER_A, reviewId: 'agy-large', sourceDir: snapshotDir, runPinnedImpl: fake.runPinned });
    assert.equal(statSync(join(ok.dir, 'blob.bin')).size, 4 * 1024 * 1024);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the dispatch-worker user is refused as an identity, fail closed', async () => {
  const env = { AGENT_OS_WORKER_RUN_AS_USER: 'dbh-worker' };
  const plan = resolveAgyReviewerIdentityPlan({
    identities: [HQ_OWNER, 'agentos-worker', 'dbh-worker', 'root', REVIEWER_A],
    hqOwner: HQ_OWNER,
    env,
  });
  assert.equal(plan.multi, true);
  assert.deepEqual(plan.identities.map((identity) => identity.user), [HQ_OWNER, REVIEWER_A]);
  assert.deepEqual(plan.refused.map((refused) => refused.user), ['agentos-worker', 'dbh-worker', 'root']);
  assert.match(plan.refused[0].reason, /dispatch-worker user/);

  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const log = quietLog();
    const pool = makePool(fake, { identities: ['agentos-worker', REVIEWER_A], env, log });
    assert.equal(await pool.refreshReadiness(), 1, 'a refused identity never counts toward the cap');
    assert.match(log.lines.join('\n'), /identity=agentos-worker refusing identity agentos-worker: it is the dispatch-worker user/);
    assert.doesNotMatch(fake.sudoLog(), /agentos-worker/, 'no pinned command ever runs as the worker user');
    const first = await pool.acquire({ reviewId: 'r1' });
    assert.equal(first.user, REVIEWER_A);
    assert.equal(await pool.acquire({ reviewId: 'r2' }), null, 'the worker user is never leased');
  } finally {
    fake.cleanup();
  }

  // The reviewer child refuses it too, whatever the env says.
  assert.throws(
    () => resolveAgyReviewIdentityFromEnv({ [AGY_IDENTITY_USER_ENV]: 'agentos-worker', [AGY_IDENTITY_REVIEW_ID_ENV]: 'agy-1' }, { hqOwner: HQ_OWNER }),
    /dispatch-worker user/,
  );
  assert.throws(
    () => resolveAgyReviewIdentityFromEnv({ [AGY_IDENTITY_USER_ENV]: 'dbh-worker', [AGY_IDENTITY_REVIEW_ID_ENV]: 'agy-1', ...env }, { hqOwner: HQ_OWNER }),
    /dispatch-worker user/,
  );
  assert.equal(resolveAgyReviewIdentityFromEnv({}, { hqOwner: HQ_OWNER }), null);
  assert.equal(resolveAgyReviewIdentityFromEnv({ [AGY_IDENTITY_USER_ENV]: HQ_OWNER }, { hqOwner: HQ_OWNER }), null);
});

// ── Readiness: isolation, drift, re-admission ───────────────────────────────

test('CCX-08: a failed review isolates only its identity, and a passing readiness check re-admits it', async () => {
  const fake = makeFakeInstall();
  try {
    const log = quietLog();
    const pool = makePool(fake, { log });
    assert.equal(await pool.refreshReadiness(), 3);
    const failing = { ok: false, failureClass: 'reviewer-exit', error: 'agy exited 1' };
    const adapter = { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) };
    const seen = [];
    // HQ owner is leased first in config order; hold it so the next review lands on A.
    const hold = await pool.acquire({ reviewId: 'hold' });
    assert.equal(hold.user, HQ_OWNER);
    const result = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool, log }, async (identity) => {
      seen.push(identity);
      return failing;
    });
    assert.equal(result, failing, 'the review result passes through untouched');
    assert.equal(seen[0].user, REVIEWER_A);
    await pool.release(hold);
    const byUser = Object.fromEntries(pool.snapshot().map((state) => [state.user, state]));
    assert.equal(byUser[REVIEWER_A].ready, false);
    assert.match(byUser[REVIEWER_A].reasons[0], /failed \(reviewer-exit\)/);
    assert.equal(byUser[REVIEWER_B].ready, true, 'the other identity is untouched');
    assert.equal(byUser[HQ_OWNER].ready, true);
    assert.equal(pool.readyCount(), 2);
    assert.match(log.lines.join('\n'), new RegExp(`identity=${REVIEWER_A} isolated`));

    // Its probe keeps failing: it stays out.
    writeFileSync(join(fake.home(REVIEWER_A), '.probe-fails'), '');
    assert.equal(await pool.refreshReadiness(), 2);
    await pool.settleProbes();
    assert.equal(pool.readyCount(), 2);

    // The next successful readiness check re-admits it, with no operator step.
    rmSync(join(fake.home(REVIEWER_A), '.probe-fails'));
    await pool.refreshReadiness();
    await pool.settleProbes();
    assert.equal(pool.readyCount(), 3);
    assert.match(log.lines.join('\n'), new RegExp(`identity=${REVIEWER_A} re-admitted`));

    // A cancelled review, or a provider-wide failure, says nothing about the identity.
    for (const failureClass of ['cancelled', 'cascade', 'provider-overloaded', 'quota-exhausted']) {
      await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool, log }, async () => ({ ok: false, failureClass }));
      assert.equal(pool.readyCount(), 3, failureClass);
    }
    // A thrown reviewer isolates the identity it ran on (here the HQ owner) and still releases the lease.
    await assert.rejects(runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool, log }, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(pool.snapshot().find((state) => state.user === HQ_OWNER).ready, false);
    assert.equal(pool.snapshot().every((state) => !state.leased), true);
    await pool.refreshReadiness();
    await pool.settleProbes();
    assert.equal(pool.readyCount(), 3, 'the HQ owner is re-admitted by its own auth probe');
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: a keychain-bootstrap isolation record isolates the identity until a probe re-admits it', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    let record = null;
    const pool = makePool(fake, { identities: [HQ_OWNER, REVIEWER_A], readBootstrapRecordImpl: () => record });
    assert.equal(await pool.refreshReadiness(), 2);
    record = { schema: 1, source: 'agy-keychain-bootstrap', user: REVIEWER_A, ready: false, reasons: ['agy models failed'], transition: 'isolated', checkedAt: '2026-09-29T10:00:00Z' };
    writeFileSync(join(fake.home(REVIEWER_A), '.probe-fails'), '');
    assert.equal(await pool.refreshReadiness(), 1);
    await pool.settleProbes();
    assert.match(pool.snapshot().find((state) => state.user === REVIEWER_A).reasons[0], /readiness probe|probe/);
    rmSync(join(fake.home(REVIEWER_A), '.probe-fails'));
    await pool.refreshReadiness();
    await pool.settleProbes();
    assert.equal(pool.readyCount(), 2, 'the same record does not isolate it again once a probe passed');
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: settings drift from the HQ-owner path isolates the identity on the next pass', async () => {
  const fake = makeFakeInstall();
  try {
    const log = quietLog();
    const pool = makePool(fake, { log });
    assert.equal(await pool.refreshReadiness(), 3);
    writeFileSync(fake.settingsPath(REVIEWER_B), settingsFileFor(HQ_SETTINGS).replace('proxy.local:3128', 'other-proxy:8080'));
    assert.equal(await pool.refreshReadiness(), 2);
    const state = pool.snapshot().find((entry) => entry.user === REVIEWER_B);
    assert.equal(state.ready, false);
    assert.match(state.reasons.join('\n'), /settings drift: HTTPS_PROXY differs from the HQ-owner path/);
    assert.equal(pool.snapshot().find((entry) => entry.user === REVIEWER_A).ready, true);
    const lease = await pool.acquire({ reviewId: 'drift-1' });
    const lease2 = await pool.acquire({ reviewId: 'drift-2' });
    assert.deepEqual([lease.user, lease2.user], [HQ_OWNER, REVIEWER_A]);
    assert.equal(await pool.acquire({ reviewId: 'drift-3' }), null, 'a drifted identity is never leased');

    // A key the HQ-owner path lacks is drift too.
    writeFileSync(fake.settingsPath(REVIEWER_B), `${settingsFileFor(HQ_SETTINGS)}ALL_PROXY=socks5://x:1\n`);
    await pool.refreshReadiness();
    assert.match(pool.snapshot().find((entry) => entry.user === REVIEWER_B).reasons.join('\n'), /ALL_PROXY is set for the identity but not on the HQ-owner path/);

    // Fixed settings re-admit it on the next pass.
    writeFileSync(fake.settingsPath(REVIEWER_B), settingsFileFor(HQ_SETTINGS));
    await pool.release(lease);
    await pool.release(lease2);
    assert.equal(await pool.refreshReadiness(), 3);
    assert.match(log.lines.join('\n'), new RegExp(`identity=${REVIEWER_B} re-admitted`));
  } finally {
    fake.cleanup();
  }
});

// ── Reviewer child: sudo, scratch copy, cleanup ─────────────────────────────

test('CCX-08: two concurrent Gemini reviews run as two distinct OS users, each with its own HOME', async () => {
  const fake = makeFakeInstall();
  try {
    const snapshotDir = makeSnapshot(fake.root);
    const pool = makePool(fake, { identities: [REVIEWER_A, REVIEWER_B] });
    assert.equal(await pool.refreshReadiness(), 2);
    for (const user of [REVIEWER_A, REVIEWER_B]) writeFileSync(join(fake.home(user), '.agy-wait-peer'), '');
    const adapter = {
      describe: () => ({ capabilities: { agyReviewerIdentity: true } }),
      spawnReviewer: async (identity) => {
        const review = await reviewWithGemini('+diff\n', '', identityReviewOptions(fake, { snapshotDir, agyIdentity: identity }));
        return { ok: true, review };
      },
    };
    const results = await Promise.all([1, 2].map(() => runWithAgyReviewerIdentity(
      { reviewerModel: 'gemini', adapter, pool, log: quietLog() },
      (identity) => adapter.spawnReviewer(identity),
    )));
    assert.equal(results.every((result) => result.ok && result.review.reviewText === VALID_REVIEW), true);
    const [callA] = fake.agyCalls(REVIEWER_A);
    const [callB] = fake.agyCalls(REVIEWER_B);
    assert.equal(callA.user, REVIEWER_A);
    assert.equal(callB.user, REVIEWER_B);
    assert.equal(callA.home, fake.home(REVIEWER_A));
    assert.equal(callB.home, fake.home(REVIEWER_B));
    assert.notEqual(callA.addDir, callB.addDir);
    for (const user of [REVIEWER_A, REVIEWER_B]) {
      assert.equal(readFileSync(join(fake.home(user), 'peers'), 'utf8').trim(), 'peers=2', 'both agy processes ran at once');
    }
    const sudoCalls = fake.spawnCalls.filter((call) => call.command === AGY_REVIEWER_SUDO);
    assert.deepEqual(sudoCalls.map((call) => call.args.slice(0, 5)).sort((a, b) => a[3].localeCompare(b[3])), [
      ['-n', '-H', '-u', REVIEWER_A, `${AGY_REVIEWER_LIBEXEC_DIR}/${AGY_REVIEWER_PINNED_AGY}`],
      ['-n', '-H', '-u', REVIEWER_B, `${AGY_REVIEWER_LIBEXEC_DIR}/${AGY_REVIEWER_PINNED_AGY}`],
    ]);
    for (const call of sudoCalls) {
      assert.ok(call.args.includes('--prompt-stdin'));
      assert.ok(call.args.includes('__AGY_PROMPT_STDIN__'));
      assert.ok(!call.args.some((arg) => arg.includes('+diff')));
      assert.ok(call.input.includes('+diff'));
    }
    assert.equal(pool.snapshot().every((state) => !state.leased && state.ready), true);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: an added identity gets the HQ-owner path\'s effective settings, only via pinned args and the root-owned file', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    const secretEnv = { HTTPS_PROXY: 'http://leaky-caller:1', AGY_EXTRA: 'must-not-cross', GEMINI_API_KEY: 'k' };
    // HQ-owner path: agy directly, no sudo.
    const hqSpawns = [];
    const saved = { ...process.env };
    Object.assign(process.env, secretEnv);
    try {
      await reviewWithGemini('+diff\n', '', {
        resolveGeminiRuntimeImpl: () => 'antigravity',
        reviewerSubprocessCwd: snapshotDir,
        agyIdentity: null,
        checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'co', credentialId: 'cred', oauthCreds: {} }),
        materializeGeminiCheckoutSessionImpl: ({ env }) => ({ env, cleanup() {} }),
        releaseGeminiCredentialCheckoutImpl: async () => {},
        assertAgyAuthImpl: async () => {},
        spawnAgyReviewImpl: (opts) => harness.spawnAgyReview({
          ...opts,
          spawnWithInputImpl: async (command, args, spawnOpts) => {
            hqSpawns.push({ command, args, env: spawnOpts.env });
            return { stdout: VALID_REVIEW, stderr: '' };
          },
        }),
        retryDelaysMs: [],
        log: quietLog(),
      });
      await reviewWithGemini('+diff\n', '', identityReviewOptions(fake, { snapshotDir, agyIdentity: { user: REVIEWER_A, reviewId: 'agy-settings-1' } }));
    } finally {
      for (const key of Object.keys(secretEnv)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    assert.equal(hqSpawns.length, 1);
    assert.equal(hqSpawns[0].command, harness.AGY_CLI, 'the HQ-owner path runs agy directly');
    const sudoCall = fake.spawnCalls.find((call) => call.command === AGY_REVIEWER_SUDO);
    assert.ok(sudoCall, 'the added identity goes through sudo');
    // Pinned args: sudo flags, the pinned command, then exactly the agy args
    // the HQ-owner path builds, with only the workspace dir swapped.
    const agyArgs = sudoCall.args.slice(5);
    const hqArgs = hqSpawns[0].args;
    const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
    assert.equal(flagValue(agyArgs, '--model'), flagValue(hqArgs, '--model'));
    assert.equal(flagValue(agyArgs, '--print-timeout'), flagValue(hqArgs, '--print-timeout'));
    assert.equal(flagValue(agyArgs, '--print'), '__AGY_PROMPT_STDIN__');
    assert.equal(sudoCall.input, flagValue(hqArgs, '--print'));
    const restoredArgs = agyArgs.slice(1);
    restoredArgs[restoredArgs.indexOf('--print') + 1] = sudoCall.input;
    assert.deepEqual(restoredArgs.filter((arg, i) => restoredArgs[i - 1] !== '--add-dir'), hqArgs.filter((arg, i) => hqArgs[i - 1] !== '--add-dir'));
    // Nothing else crosses: sudo sees only the minimal pinned-command env.
    assert.deepEqual(sudoCall.env, { ...PINNED_COMMAND_ENV });
    for (const line of fake.sudoLog().trim().split('\n')) {
      const vars = line.replace(/^.* vars=/u, '').split(',').filter(Boolean).filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(name));
      assert.deepEqual(vars.sort(), ['LANG', 'PATH'], `sudo received only the pinned env: ${line}`);
    }
    // Effective settings inside agy come from the root-owned file and equal the HQ-owner path's.
    const [call] = fake.agyCalls(REVIEWER_A);
    assert.equal(call.proxy, HQ_ENV.HTTPS_PROXY, 'not the caller\'s leaky HTTPS_PROXY');
    assert.equal(call.noProxy, HQ_ENV.NO_PROXY);
    assert.equal(call.keychain, join(fake.home(REVIEWER_A), 'Library/Keychains/login.keychain-db'));
    const effective = referenceAgySettingsFromEnv({
      HOME: call.home, HTTPS_PROXY: call.proxy, NO_PROXY: call.noProxy, AGY_KEYCHAIN_PATH: call.keychain,
    });
    assert.deepEqual(effective, HQ_SETTINGS);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the scratch copy is reviewer-owned 0700 and cleanup removes it after success, failure and timeout', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    const scratchRoot = join(fake.home(REVIEWER_A), 'scratch');
    const runs = [
      { name: 'success', reviewId: 'agy-ok', marker: null },
      { name: 'failure', reviewId: 'agy-fail', marker: '.agy-fail' },
      { name: 'timeout', reviewId: 'agy-hang', marker: '.agy-hang', testTimeout: 1_000 },
    ];
    for (const run of runs) {
      if (run.marker) writeFileSync(join(fake.home(REVIEWER_A), run.marker), '');
      const finishCalls = [];
      const options = identityReviewOptions(fake, {
        snapshotDir,
        agyIdentity: { user: REVIEWER_A, reviewId: run.reviewId },
        finishCalls,
        testTimeout: run.testTimeout || 0,
      });
      const outcome = await reviewWithGemini('+diff\n', '', options).then(() => 'ok', (err) => err);
      if (run.name === 'success') assert.equal(outcome, 'ok');
      else assert.match(String(outcome?.message), /Gemini exec failed/, `${run.name} surfaces as a review failure`);
      const call = fake.agyCalls(REVIEWER_A).at(-1);
      assert.equal(call.addDir, join(scratchRoot, run.reviewId), `${run.name}: agy read the identity's own scratch copy`);
      assert.equal(call.mode, '700', `${run.name}: the scratch copy is 0700`);
      assert.equal(call.sawSnapshot, 'yes', `${run.name}: the snapshot was streamed in`);
      assert.notEqual(call.cwd, snapshotDir, 'agy never runs in the HQ owner\'s snapshot');
      assert.equal(finishCalls.length, 1, `${run.name}: cleanup ran once in the child`);
      assert.deepEqual(finishCalls[0].cleanup, { ok: true, removed: true });
      assert.equal(existsSync(join(scratchRoot, run.reviewId)), false, `${run.name}: the scratch copy is gone`);
      assert.equal(existsSync(finishCalls[0].cwd), false, `${run.name}: the neutral cwd is gone`);
      if (run.marker) rmSync(join(fake.home(REVIEWER_A), run.marker));
    }
    // A failed extract (the review id already exists) still runs cleanup.
    mkdirSync(join(scratchRoot, 'agy-taken'), { recursive: true });
    const finishCalls = [];
    await assert.rejects(
      reviewWithGemini('+diff\n', '', identityReviewOptions(fake, { snapshotDir, agyIdentity: { user: REVIEWER_A, reviewId: 'agy-taken' }, finishCalls })),
      /workspace extract as agentos-reviewer exited 73/,
    );
    assert.equal(finishCalls.length, 1);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the watcher lease release cleans a scratch copy a killed reviewer child left behind', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    const pool = makePool(fake, { identities: [REVIEWER_A] });
    await pool.refreshReadiness();
    const adapter = { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) };
    let leakedDir = null;
    const result = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool, log: quietLog() }, async (identity) => {
      // The child extracted and was SIGKILLed before its own finally ran.
      leakedDir = (await extractAgyReviewWorkspace({ ...identity, sourceDir: snapshotDir, runPinnedImpl: fake.runPinned })).dir;
      assert.equal(statSync(leakedDir).mode & 0o777, 0o700);
      return { ok: false, failureClass: 'reviewer-timeout' };
    });
    assert.equal(result.failureClass, 'reviewer-timeout');
    assert.equal(existsSync(leakedDir), false);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the startup sweep removes a leaked scratch dir and keeps a live one', async () => {
  const fake = makeFakeInstall();
  try {
    const leaked = join(fake.home(REVIEWER_A), 'scratch', 'agy-leaked');
    const live = join(fake.home(REVIEWER_A), 'scratch', 'agy-live');
    mkdirSync(leaked, { recursive: true });
    mkdirSync(live, { recursive: true });
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    utimesSync(leaked, old, old);
    const log = quietLog();
    const pool = makePool(fake, { log });
    let authChecks = 0;
    const result = await runAgyReviewerStartupChecks({
      env: {},
      log,
      identityPool: pool,
      warnIfUnavailableImpl: async () => { authChecks += 1; return { checked: true, ok: true }; },
    });
    assert.equal(authChecks, 1, 'the HQ-owner auth preflight still runs');
    assert.deepEqual(result.sweep.map(({ user, ok, swept }) => ({ user, ok, swept })), [
      { user: REVIEWER_A, ok: true, swept: 1 },
      { user: REVIEWER_B, ok: true, swept: 0 },
    ]);
    assert.equal(existsSync(leaked), false);
    assert.equal(existsSync(live), true);
    assert.doesNotMatch(fake.sudoLog(), new RegExp(`^${HQ_OWNER} `, 'mu'), 'the HQ owner never sweeps through sudo');

    // With a single identity the sweep is a no-op and a throwing pool never blocks startup.
    const single = await runAgyReviewerStartupChecks({ env: {}, log, identityPool: makePool(fake, { identities: [] }), warnIfUnavailableImpl: async () => ({}) });
    assert.deepEqual(single.sweep, []);
    const broken = await runAgyReviewerStartupChecks({ env: {}, log, identityPool: { sweepAll: async () => { throw new Error('nope'); } }, warnIfUnavailableImpl: async () => ({}) });
    assert.deepEqual(broken.sweep, []);
  } finally {
    fake.cleanup();
  }
});

// ── Processes the HQ owner cannot signal ────────────────────────────────────

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function killSurvivor(fake, user) {
  const path = join(fake.home(user), 'survivor.pid');
  if (!existsSync(path)) return;
  try { process.kill(Number(readFileSync(path, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
}

// The per-user agents launchd keeps running for a user that has used
// CoreFoundation/Security.framework, and a LaunchAgent job with a child. Each
// leads its own process group. None of them is a review's.
const SYSTEM_AGENTS = [
  { pid: 9101, pgid: 9101, comm: '/usr/sbin/cfprefsd' },
  { pid: 9102, pgid: 9102, comm: '/usr/sbin/distnoted' },
  { pid: 9103, pgid: 9103, comm: '/usr/libexec/trustd' },
  { pid: 9104, pgid: 9104, comm: '/usr/libexec/secd' },
  { pid: 9105, pgid: 9105, comm: '/bin/sh' },
  { pid: 9106, pgid: 9105, comm: 'sleep' },
];

// Stands in for `ps -U <user>`: the user's system agents, plus the fake's
// survivor (a language server in its own group) while it still runs.
function survivorLister(fake) {
  return async ({ user }) => {
    const path = join(fake.home(user), 'survivor.pid');
    const pid = existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : 0;
    const survivor = pid && processAlive(pid) ? [{ pid, pgid: pid, comm: 'language_server_' }] : [];
    return { ok: true, processes: [...SYSTEM_AGENTS, ...survivor] };
  };
}

test('CCX-08: a language server left behind as the identity does not hold the review open', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    writeFileSync(join(fake.home(REVIEWER_A), '.agy-linger'), '');
    const started = Date.now();
    const review = await reviewWithGemini('+diff\n', '', identityReviewOptions(fake, {
      snapshotDir,
      agyIdentity: { user: REVIEWER_A, reviewId: 'agy-linger' },
    }));
    const elapsed = Date.now() - started;
    assert.match(review.reviewText, /Comment only/);
    const survivor = Number(readFileSync(join(fake.home(REVIEWER_A), 'survivor.pid'), 'utf8').trim());
    assert.equal(processAlive(survivor), true, 'the leftover was out of the group kill\'s reach');
    assert.ok(elapsed < 10_000, `the capture closed on sudo's exit, not the leftover's (took ${elapsed}ms)`);
  } finally {
    killSurvivor(fake, REVIEWER_A);
    fake.cleanup();
  }
});

test('CCX-08: a timed-out review whose agy survives the kill settles, and the identity is not leased until the survivor exits', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const snapshotDir = makeSnapshot(fake.root);
    const log = quietLog();
    const pool = makePool(fake, { identities: [REVIEWER_A], log, listUserProcessesImpl: survivorLister(fake) });
    writeFileSync(join(fake.home(REVIEWER_A), '.agy-hang-survives'), '');
    let reviewError = null;
    const started = Date.now();
    const result = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: LEASING_ADAPTER, pool, log }, async (identity) => {
      try {
        await reviewWithGemini('+diff\n', '', identityReviewOptions(fake, { snapshotDir, agyIdentity: identity, testTimeout: 1_000 }));
        return { ok: true };
      } catch (err) {
        reviewError = err;
        return { ok: false, failureClass: 'reviewer-timeout' };
      }
    });
    assert.equal(result.failureClass, 'reviewer-timeout');
    assert.match(String(reviewError?.message), /Gemini exec failed/);
    assert.ok(Date.now() - started < 15_000, 'the review settled without waiting for the survivor');
    const survivor = Number(readFileSync(join(fake.home(REVIEWER_A), 'survivor.pid'), 'utf8').trim());
    assert.equal(processAlive(survivor), true);

    const state = pool.snapshot().find((entry) => entry.user === REVIEWER_A);
    assert.equal(state.ready, false);
    assert.equal(state.draining, true);
    assert.match(state.reasons.join('\n'), new RegExp(`still running as ${REVIEWER_A}`));
    // The next review cannot lease it and says why, without claiming a timeout.
    const starved = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: LEASING_ADAPTER, pool, log }, async () => {
      throw new Error('must not run while the identity drains');
    });
    assert.equal(starved.failureClass, AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS);
    assert.equal(starved.transient, true);
    assert.match(starved.error, /still running as agentos-reviewer/);
    assert.equal(await pool.refreshReadiness(), 0, 'still draining while the survivor runs');

    // Once it exits, the identity is checked and probed back in.
    killSurvivor(fake, REVIEWER_A);
    for (let attempt = 0; attempt < 50 && processAlive(survivor); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    rmSync(join(fake.home(REVIEWER_A), '.agy-hang-survives'));
    await pool.refreshReadiness();
    await pool.settleProbes();
    assert.equal(pool.readyCount(), 1);
    assert.equal(pool.snapshot().find((entry) => entry.user === REVIEWER_A).draining, false);
  } finally {
    killSurvivor(fake, REVIEWER_A);
    fake.cleanup();
  }
});

test('CCX-08: an unknown process check keeps the identity out (fail closed)', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const pool = makePool(fake, {
      identities: [REVIEWER_A],
      listUserProcessesImpl: async () => ({ ok: false, processes: [], error: 'ps timed out' }),
    });
    assert.equal(await pool.acquire({ reviewId: 'agy-unknown' }), null);
    const state = pool.snapshot()[0];
    assert.equal(state.ready, false);
    assert.match(state.reasons[0], /cannot tell whether review processes still run as agentos-reviewer: ps timed out/);
    // The real lister reports a bad name as unknown rather than as "none".
    assert.equal((await listUserProcesses({ user: 'bad user' })).ok, false);
    assert.deepEqual(
      await listUserProcesses({ user: REVIEWER_A, runImpl: async () => ({ code: 1, stdout: '', stderr: '' }) }),
      { ok: true, processes: [] },
    );
    assert.equal((await listUserProcesses({ user: REVIEWER_A, runImpl: async () => ({ code: 1, stdout: '', stderr: "ps: No ruser named 'x'" }) })).ok, false);
    let psArgs = null;
    assert.deepEqual(
      await listUserProcesses({
        user: REVIEWER_A,
        runImpl: async (command, args) => {
          psArgs = args;
          return { code: 0, stdout: '  101   101 /usr/sbin/cfprefsd\n  202   190 /Applications/Anti Gravity.app/language_server_macos_arm\n', stderr: '' };
        },
      }),
      { ok: true, processes: [
        { pid: 101, pgid: 101, comm: '/usr/sbin/cfprefsd' },
        { pid: 202, pgid: 190, comm: '/Applications/Anti Gravity.app/language_server_macos_arm' },
      ] },
    );
    assert.deepEqual(psArgs, ['-U', REVIEWER_A, '-o', 'pid=,pgid=,comm=']);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: only processes a review started count as survivors, never the user\'s system agents', () => {
  assert.deepEqual(agyReviewSurvivors(SYSTEM_AGENTS), [], 'launchd-started agents and LaunchAgent jobs lead their own groups');
  const review = [
    // agy and the pinned wrapper, in the group sudo leads (sudo runs as root/HQ owner, so it is not listed).
    { pid: 300, pgid: 299, comm: '/usr/local/libexec/agent-os/agy-reviewer-agy' },
    { pid: 301, pgid: 299, comm: 'agy' },
    // A child of agy that is not named like it, in the same group.
    { pid: 302, pgid: 299, comm: 'git' },
    // agy's language server in a group of its own, by name (p_comm truncates it to 16 characters).
    { pid: 400, pgid: 400, comm: 'language_server_' },
    // Something the language server started, in its group.
    { pid: 401, pgid: 400, comm: 'node' },
  ];
  assert.deepEqual(agyReviewSurvivors([...SYSTEM_AGENTS, ...review]).map((proc) => proc.pid), [300, 301, 302, 400, 401]);
  // A process left in a group whose leader (sudo) is gone still counts.
  assert.deepEqual(agyReviewSurvivors([...SYSTEM_AGENTS, { pid: 510, pgid: 500, comm: 'sleep' }]).map((proc) => proc.pid), [510]);
});

test('CCX-08: an identity with long-lived system agents is re-admitted after its review', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    let listed = 0;
    const pool = makePool(fake, {
      identities: [REVIEWER_A],
      listUserProcessesImpl: async () => { listed += 1; return { ok: true, processes: SYSTEM_AGENTS }; },
    });
    assert.equal(await pool.refreshReadiness(), 1, 'the first pass checks for survivors and admits it');
    const seen = [];
    await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: LEASING_ADAPTER, pool, log: quietLog() }, async (identity) => {
      seen.push(identity.user);
      return { ok: true };
    });
    assert.deepEqual(seen, [REVIEWER_A]);
    assert.equal(listed, 2, 'checked on the first pass and again on release');
    const state = pool.snapshot()[0];
    assert.equal(state.draining, false);
    assert.equal(state.ready, true);
    const again = await pool.acquire({ reviewId: 'agy-again' });
    assert.equal(again.user, REVIEWER_A, 'leasable again right away');
    await pool.release(again);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the survivor check waits out the pool\'s own helper calls instead of counting them', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    let gate = null;
    let listed = 0;
    const pool = makePool(fake, {
      identities: [REVIEWER_A],
      runPinnedImpl: async (opts) => {
        if (opts.args?.[0] === 'status' && gate) await gate.promise;
        return fake.runPinned(opts);
      },
      listUserProcessesImpl: async () => { listed += 1; return { ok: true, processes: [] }; },
    });
    await pool.refreshReadiness();
    const lease = await pool.acquire({ reviewId: 'agy-overlap' });
    let open;
    gate = { promise: new Promise((resolve) => { open = resolve; }) };
    const pass = pool.refreshReadiness();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listedBefore = listed;
    await pool.release(lease);
    assert.equal(listed, listedBefore, 'no process listing while a readiness helper runs as the user');
    const state = pool.snapshot()[0];
    assert.equal(state.draining, true);
    assert.match(state.reasons.join('\n'), /survivor check deferred/);
    gate = null;
    open();
    await pass;
    assert.equal(await pool.refreshReadiness(), 1, 'the next pass checks and re-admits it');
  } finally {
    fake.cleanup();
  }
});

// ── Leases across a watcher restart ─────────────────────────────────────────

test('CCX-08: a fresh pool does not lease an identity whose review from a previous watcher still runs', async () => {
  const fake = makeFakeInstall();
  try {
    const log = quietLog();
    // The previous watcher leased A for this review; its cli-direct reviewer
    // child survived the bounce and is still running.
    const leakedDir = join(fake.home(REVIEWER_A), 'scratch', 'agy-before-bounce');
    mkdirSync(leakedDir, { recursive: true });
    const record = {
      sessionUuid: 'session-before-bounce',
      state: 'heartbeating',
      pgid: 4242,
      subjectContext: {
        agyIdentity: { user: REVIEWER_A, reviewId: 'agy-before-bounce' },
        agyIdentityLease: { user: REVIEWER_A, reviewId: 'agy-before-bounce' },
      },
    };
    let active = [record];
    let alive = true;
    let settled = null;
    const pool = makePool(fake, {
      identities: [REVIEWER_A, REVIEWER_B],
      log,
      readActiveRunRecordsImpl: () => active,
      readRunRecordImpl: (sessionUuid) => (sessionUuid === record.sessionUuid ? settled : null),
      isPgidAliveImpl: (pgid) => pgid === 4242 && alive,
    });
    const first = await pool.acquire({ reviewId: 'agy-after-bounce' });
    assert.equal(first.user, REVIEWER_B, 'A is held by the review from before the bounce');
    assert.equal(await pool.acquire({ reviewId: 'agy-third' }), null, 'and is not handed to the next review either');
    const heldA = pool.snapshot().find((entry) => entry.user === REVIEWER_A);
    assert.equal(heldA.ready, false);
    assert.deepEqual(heldA.adoptedReviews, ['agy-before-bounce']);
    assert.match(heldA.reasons[0], /agy-before-bounce from a previous watcher still runs as agentos-reviewer/);
    assert.equal(pool.readyCount(), 1, 'the Gemini cap does not count it');
    // Its own run record does not hold B against itself.
    active = [record, { sessionUuid: 'session-b', state: 'heartbeating', pgid: 77, subjectContext: { agyIdentityLease: { user: REVIEWER_B, reviewId: 'agy-after-bounce' } } }];
    await pool.refreshReadiness();
    assert.equal(pool.snapshot().find((entry) => entry.user === REVIEWER_B).ready, true);
    await pool.release(first);

    // The old review failed and its reviewer child exited: the scratch copy
    // it left is removed, and the identity is probed back in.
    alive = false;
    settled = { ...record, state: 'failed' };
    await pool.refreshReadiness();
    await pool.settleProbes();
    await pool.refreshReadiness();
    await pool.settleProbes();
    assert.equal(existsSync(leakedDir), false, 'the adopted review\'s scratch copy is cleaned up');
    assert.match(readFileSync(join(fake.home(REVIEWER_A), 'probes.log'), 'utf8'), /probe/, 'a failed adopted review is re-probed');
    const readmitted = pool.snapshot().find((entry) => entry.user === REVIEWER_A);
    assert.equal(readmitted.ready, true);
    assert.deepEqual(readmitted.adoptedReviews, []);
    assert.match(log.lines.join('\n'), /agy-before-bounce from a previous watcher ended/);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: a fresh pool does not lease an identity an agy still runs as, even without a run record', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const pool = makePool(fake, {
      identities: [REVIEWER_A],
      listUserProcessesImpl: async () => ({ ok: true, processes: [...SYSTEM_AGENTS, { pid: 700, pgid: 699, comm: 'agy' }] }),
    });
    assert.equal(await pool.acquire({ reviewId: 'agy-fresh' }), null);
    const state = pool.snapshot()[0];
    assert.equal(state.draining, true);
    assert.match(state.reasons[0], /1 review process\(es\) still running as agentos-reviewer \(700 agy\)/);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: unreadable run records keep unleased identities out (fail closed)', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const pool = makePool(fake, {
      identities: [HQ_OWNER, REVIEWER_A],
      readActiveRunRecordsImpl: () => { throw new Error('EIO'); },
    });
    assert.equal(await pool.refreshReadiness(), 0);
    assert.match(pool.snapshot()[0].reasons[0], /cannot read the reviewer run records/);
  } finally {
    fake.cleanup();
  }
});

// ── Alerts ──────────────────────────────────────────────────────────────────

test('CCX-08: a long drain and a Gemini lane with no ready identity page the operator, rate-limited', async () => {
  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    let clock = 1_000_000;
    const alerts = [];
    const log = quietLog();
    const pool = makePool(fake, {
      identities: [REVIEWER_A],
      log,
      now: () => clock,
      listUserProcessesImpl: async () => ({ ok: true, processes: [{ pid: 700, pgid: 700, comm: 'language_server_' }] }),
      deliverAlertImpl: async (text, { event }) => { alerts.push({ text, event }); return { id: 'a' }; },
    });
    assert.equal(await pool.refreshReadiness(), 0);
    pool.noteGeminiDemand({ readyIdentities: 0, candidates: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(alerts, [], 'nothing pages before the bound');

    clock += 15 * 60_000;
    await pool.refreshReadiness();
    pool.noteGeminiDemand({ readyIdentities: 0, candidates: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(alerts.map((entry) => entry.event), ['reviewer.agy_identity_draining', 'reviewer.agy_identities_none_ready']);
    assert.match(alerts[0].text, /agentos-reviewer has not been leasable for 15 min/);
    assert.match(alerts[1].text, /no ready agy identity for 15 min with 2 Gemini review\(s\) waiting/);
    assert.match(log.lines.join('\n'), /ALERT: /);

    // Not again within the interval, and a lane with no waiting work never pages.
    clock += 60_000;
    await pool.refreshReadiness();
    pool.noteGeminiDemand({ readyIdentities: 0, candidates: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(alerts.length, 2);
    pool.noteGeminiDemand({ readyIdentities: 0, candidates: 0 });
    clock += 30 * 60_000;
    pool.noteGeminiDemand({ readyIdentities: 0, candidates: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(alerts.filter((entry) => entry.event === 'reviewer.agy_identities_none_ready').length, 1, 'the zero-ready clock restarts');
  } finally {
    fake.cleanup();
  }
});

// ── Leasing without the drain's readiness pass ──────────────────────────────

test('CCX-08: a lease runs its own readiness pass, so a dispatch path without a drain still leases', async () => {
  const fake = makeFakeInstall();
  try {
    let clock = 1_000_000;
    let statusCalls = 0;
    const pool = makePool(fake, {
      identities: [REVIEWER_A, REVIEWER_B],
      now: () => clock,
      runPinnedImpl: async (opts) => {
        if (opts.args?.[0] === 'status') statusCalls += 1;
        return fake.runPinned(opts);
      },
    });
    // No refreshReadiness() first: the pool-disabled watcher path and a
    // pipeline stage both reach the lease this way.
    const seen = [];
    const result = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: LEASING_ADAPTER, pool, log: quietLog() }, async (identity) => {
      seen.push(identity);
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(seen[0].user, REVIEWER_A);
    assert.equal(statusCalls, 2, 'one readiness pass, both identities');
    // A fresh pass is reused; a stale one is redone.
    const held = await pool.acquire({ reviewId: 'agy-held' });
    assert.equal(statusCalls, 2);
    clock += 61_000;
    const second = await pool.acquire({ reviewId: 'agy-second' });
    assert.equal(statusCalls, 4);
    assert.deepEqual([held.user, second.user], [REVIEWER_A, REVIEWER_B]);
    // Both leased: the next review fails as unavailable, not as a timeout.
    const starved = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: LEASING_ADAPTER, pool, log: quietLog() }, async () => ({ ok: true }));
    assert.equal(starved.failureClass, AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS);
    assert.notEqual(starved.failureClass, 'reviewer-timeout');
    await pool.release(held);
    await pool.release(second);
  } finally {
    fake.cleanup();
  }
});

test('CCX-08: the HQ owner is leasable before any readiness pass', async () => {
  const pool = makePool(null, {
    identities: [HQ_OWNER, REVIEWER_A],
    runPinnedImpl: async () => ({ code: 1, stdout: '', stderr: 'no sudo in this test' }),
  });
  const lease = await pool.acquire({ reviewId: 'agy-owner' });
  assert.equal(lease.user, HQ_OWNER);
  assert.equal(lease.hqOwner, true);
  await pool.release(lease);
});

test('CCX-08: a pipeline stage that runs Gemini counts against the Gemini cap', async () => {
  const roleRegistry = {
    routing: { neverReviewOwnBuilderClass: true },
    roles: {
      'quality-reviewer': { id: 'quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
      'gemini-stage-reviewer': { id: 'gemini-stage-reviewer', promptSet: 'code-pr', workerClass: 'gemini', taskKind: 'review', completionShape: 'decision-only' },
    },
  };
  const pipelineConfig = (panel) => ({
    id: 'code-pr',
    riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 3 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
    pipeline: { enabled: true, stages: [{ id: 'quality', panel: ['quality-reviewer'], aggregation: { kind: 'unanimous-clean' } }, { id: 'second', panel, aggregation: { kind: 'unanimous-clean' } }] },
  });
  assert.equal(domainPipelineGeminiSeatCount(pipelineConfig(['gemini-stage-reviewer']), { roleRegistry, identityPool: { plan: () => ({ multi: false }) } }), 0);
  assert.equal(domainPipelineGeminiSeatCount(pipelineConfig(['gemini-stage-reviewer']), { roleRegistry, identityPool: { plan: () => ({ multi: true }) } }), 1);
  assert.equal(domainPipelineGeminiSeatCount(pipelineConfig(['quality-reviewer']), { roleRegistry, identityPool: { plan: () => ({ multi: true }) } }), 0);
  assert.equal(domainPipelineGeminiSeatCount({ id: 'code-pr', pipeline: { enabled: false, stages: [] } }), 0);

  const stageCandidate = { reviewerModel: 'claude', pipelineGeminiSeats: 1, reviewerRuntimeAdapter: LEASING_ADAPTER };
  assert.equal(reviewerDispatchCandidateUsesGemini(stageCandidate), true);
  assert.equal(reviewerDispatchCandidateUsesGemini({ reviewerModel: 'claude' }), false);

  const fake = makeFakeInstall({ users: [REVIEWER_A] });
  try {
    const pool = makePool(fake, { identities: [REVIEWER_A] });
    const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates([stageCandidate], {
      env: {},
      fetchCredentialConcurrency: async () => { throw new Error('the broker is not consulted'); },
      identityPool: pool,
    });
    assert.equal(cap, 1, 'the ready identities cap a pipeline candidate too');
  } finally {
    fake.cleanup();
  }

  // Two pipeline candidates under a Gemini cap of 1 run one at a time.
  let active = 0;
  let maxActive = 0;
  const run = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  };
  const candidates = [1, 2].map((prNumber) => ({
    repoPath: 'o/r', prNumber, reviewerModel: 'claude', pipelineGeminiSeats: 1, run, pendingSince: '2026-09-29T00:00:00.000Z', enqueuedAtMs: prNumber,
  }));
  const summary = await runBoundedReviewerDispatchQueue(candidates, {
    maxConcurrent: 2,
    geminiCredentialConcurrency: 1,
    logger: { error() {}, log() {}, warn() {} },
  });
  assert.equal(summary.dispatched, 2);
  assert.equal(maxActive, 1);
});

// ── Single-identity parity ──────────────────────────────────────────────────

test('CCX-08: with a single identity the spawn path is byte-identical to before', async () => {
  // The lease wrapper calls straight through, never touching the pool.
  const pool = makePool(null, { identities: [HQ_OWNER], runPinnedImpl: async () => { throw new Error('no sudo'); } });
  pool.acquire = async () => { throw new Error('no lease with one identity'); };
  const sentinel = { ok: true };
  const args = [];
  assert.equal(await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', pool }, async (identity) => { args.push(identity); return sentinel; }), sentinel);
  assert.equal(await runWithAgyReviewerIdentity({ reviewerModel: 'codex', pool: makePool(null) }, async (identity) => { args.push(identity); return sentinel; }), sentinel);
  assert.deepEqual(args, [null, null]);

  // spawnAgyReview without an identity: agy directly, the caller's env and cwd, unchanged argv.
  const calls = [];
  const env = { HOME: '/Users/hq-owner', PATH: '/usr/bin' };
  await harness.spawnAgyReview({
    prompt: 'review this',
    model: 'Gemini 3.1 Pro (High)',
    env,
    cwd: '/tmp/snapshot',
    timeout: 60_000,
    printTimeoutMs: 30_000,
    spawnWithInputImpl: async (command, argv, opts) => { calls.push({ command, argv, opts }); return { stdout: '', stderr: '' }; },
  });
  assert.equal(calls[0].command, harness.AGY_CLI);
  assert.deepEqual(calls[0].argv, harness.buildAgyReviewArgs({ model: 'Gemini 3.1 Pro (High)', prompt: 'review this', printTimeoutMs: 30_000, workspaceDir: '/tmp/snapshot' }));
  assert.equal(calls[0].opts.env, env);
  assert.equal(calls[0].opts.cwd, '/tmp/snapshot');
  assert.equal(calls[0].opts.reapGroupOnExit, true);
});

test('CCX-08: the cli-direct adapter passes a leased identity to the child env only, and nothing when there is none', async () => {
  const rootDir = mkdtempSync(join('/tmp', 'ccx08-cli-'));
  const envs = [];
  const saved = process.env[AGY_IDENTITY_USER_ENV];
  process.env[AGY_IDENTITY_USER_ENV] = 'inherited-must-not-select';
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: async () => ({ ok: true }),
      spawnCapturedImpl: async (command, argv, opts) => {
        envs.push(opts.env);
        const err = new Error('stop here');
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-09-29T10:00:00.000Z',
    });
    assert.equal(adapter.describe().capabilities.agyReviewerIdentity, true);
    const base = { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 1 };
    for (const [sessionUuid, subjectContext] of [
      ['ccx08-none', base],
      ['ccx08-lease', { ...base, agyIdentity: { user: REVIEWER_A, reviewId: 'agy-lease-1' } }],
    ]) {
      await adapter.spawnReviewer({ model: 'gemini', prompt: '', subjectContext, timeoutMs: 100, sessionUuid, forbiddenFallbacks: ['api-key'] });
    }
    assert.equal(envs.length, 2);
    assert.equal(AGY_IDENTITY_USER_ENV in envs[0], false, 'no identity, no env key (an inherited one is dropped)');
    assert.equal(AGY_IDENTITY_REVIEW_ID_ENV in envs[0], false);
    assert.equal(envs[1][AGY_IDENTITY_USER_ENV], REVIEWER_A);
    assert.equal(envs[1][AGY_IDENTITY_REVIEW_ID_ENV], 'agy-lease-1');
  } finally {
    if (saved === undefined) delete process.env[AGY_IDENTITY_USER_ENV];
    else process.env[AGY_IDENTITY_USER_ENV] = saved;
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('added identity capture reads only bounded tails of sparse gigabyte files', async () => {
  const result = await harness.spawnAgyReview({
    prompt: 'private diff', model: 'Gemini 3.1 Pro (High)', maxBuffer: 4,
    identity: { user: REVIEWER_A, cwd: '/tmp', workspaceDir: '/tmp' },
    spawnWithInputImpl: async (_command, _args, options) => {
      for (const [path, tail] of [[options.stdoutPath, 'TAIL'], [options.stderrPath, 'FAIL']]) {
        const fd = openSync(path, 'w');
        try {
          ftruncateSync(fd, 1024 * 1024 * 1024);
          writeSync(fd, Buffer.from(tail), 0, 4, 1024 * 1024 * 1024 - 4);
        } finally { closeSync(fd); }
      }
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(result.stdout, 'TAIL');
  assert.equal(result.stderr, 'FAIL');
});
