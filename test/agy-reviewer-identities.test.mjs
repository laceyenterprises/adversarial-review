// CCX-08 — multi-identity agy reviewer (credential-capacity-expansion SPEC
// §2b, §3 CCX-08). The pinned commands CCX-07 installs are root-owned and
// reached through sudo; here a fake install stands in for both: a fake `sudo`
// that switches HOME/USER per target user, and fake pinned agy, keychain
// helper and workspace helper scripts with the same verbs and output lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  AGY_IDENTITY_REVIEW_ID_ENV,
  AGY_IDENTITY_USER_ENV,
  AGY_REVIEWER_LIBEXEC_DIR,
  AGY_REVIEWER_PINNED_AGY,
  AGY_REVIEWER_SUDO,
  PINNED_COMMAND_ENV,
  cleanupAgyReviewWorkspace,
  createAgyReviewerIdentityPool,
  extractAgyReviewWorkspace,
  finishAgyIdentityReview,
  prepareAgyIdentityReview,
  referenceAgySettingsFromEnv,
  resolveAgyReviewIdentityFromEnv,
  resolveAgyReviewerIdentityPlan,
  resolveHqOwner,
  runPinnedCommand,
  runWithAgyReviewerIdentity,
} from '../src/agy-reviewer-identities.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';
import { resolveGeminiCredentialConcurrencyForDispatchCandidates } from '../src/reviewer-runtime-support.mjs';
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

const FAKE_SUDO = `#!/bin/bash
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$1" != -n ] || [ "$2" != -H ] || [ "$3" != -u ]; then echo "fake sudo: unexpected argv $*" >&2; exit 64; fi
U="$4"; shift 4
CMD="$1"; shift
case "$CMD" in "$ROOT"/libexec/*) ;; *) echo "fake sudo: not a pinned command: $CMD" >&2; exit 1 ;; esac
# What reached sudo from the caller: only the minimal pinned-command env.
echo "$U $(basename "$CMD") vars=$(env | cut -d= -f1 | sort | tr '\\n' ',')" >> "$ROOT/sudo.log"
export HOME="$ROOT/home/$U" USER="$U" LOGNAME="$U" FAKE_ROOT="$ROOT"
exec "$CMD" "$@"
`;

// Like CCX-07's agy-reviewer-agy: settings come only from the root-owned file.
const FAKE_PINNED_AGY = `#!/bin/bash
set -a; . "$FAKE_ROOT/settings/$USER.conf"; set +a
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
  "$USER" "$HOME" "$(pwd -P)" "$add" "$(stat -f %Lp "$add")" "$model" "\${HTTPS_PROXY-}" "\${NO_PROXY-}" "\${AGY_KEYCHAIN_PATH-}" \\
  "$([ -f "$add/README.md" ] && echo yes || echo no)" >> "$HOME/agy-calls.log"
[ -e "$HOME/.agy-hang" ] && sleep 30
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
    spawnCalls.push({ command, args: [...args], env: opts.env, cwd: opts.cwd });
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
    sleepImpl: async () => {},
    leaseWaitMs: 0,
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
    const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates([{ reviewerModel: 'gemini' }], {
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

    // A cancelled review says nothing about the identity.
    await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool, log }, async () => ({ ok: false, failureClass: 'cancelled' }));
    assert.equal(pool.readyCount(), 3);
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
    assert.equal(flagValue(agyArgs, '--print'), flagValue(hqArgs, '--print'));
    assert.deepEqual(agyArgs.filter((arg, i) => agyArgs[i - 1] !== '--add-dir'), hqArgs.filter((arg, i) => hqArgs[i - 1] !== '--add-dir'));
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
