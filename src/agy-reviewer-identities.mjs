// CCX-08 — multi-identity agy reviewer (credential-capacity-expansion SPEC
// §2b, §3 CCX-08).
//
// `reviewer.gemini.identities` is an ordered list of OS users. Unset (or a
// list naming only the HQ owner) is one identity: the HQ owner the watcher
// runs as, running agy directly without sudo, exactly as before this module
// existed. Every other entry is an "added" identity: a dedicated reviewer OS
// user the HQ owner reaches only through `sudo -n -H -u <user>` and the three
// root-owned pinned commands CCX-07 installs (agy, keychain helper, workspace
// helper). Nothing here reads or writes that user's HOME or keychain directly.
//
// This module holds the watcher-side identity pool (cap = ready identities,
// one lease per Gemini review, readiness with settings-drift isolation and
// automatic re-admission, startup sweep) and the reviewer-child helpers that
// stream the review snapshot into the reviewer's scratch copy, run agy there
// and clean it up.
//
// The HQ owner cannot signal a process that runs as an added identity, so it
// cannot reap agy or agy's language server there the way it does on the
// HQ-owner path. Two things keep that safe: the reviewer child captures agy's
// output through files, not pipes, so a leftover descendant cannot hold the
// capture open; and a lease is released only after the identity has no
// process left running, so a surviving agy never shares a HOME with the next
// review.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { checkAgyReviewerAuth } from './agy-reviewer-auth.mjs';
import { resolveGeminiReviewerIdentities, resolveGeminiRuntime } from './role-config.mjs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';

// Fixed install path of the pinned commands (CCX-07 setup-reviewer-os-user.sh).
// The sudoers entry names exactly these three by absolute path.
const AGY_REVIEWER_LIBEXEC_DIR = '/usr/local/libexec/agent-os';
const AGY_REVIEWER_SUDO = '/usr/bin/sudo';
const AGY_REVIEWER_TAR = '/usr/bin/tar';
const AGY_REVIEWER_PS = '/bin/ps';
const AGY_REVIEWER_PINNED_AGY = 'agy-reviewer-agy';
const AGY_REVIEWER_KEYCHAIN_HELPER = 'agy-reviewer-keychain-helper';
const AGY_REVIEWER_WORKSPACE_HELPER = 'agy-reviewer-workspace-helper';

// Mirrors agy-reviewer-common.sh (CCX-07); the pinned commands enforce the
// same patterns, these only fail earlier and louder.
const AGY_REVIEWER_USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const AGY_REVIEWER_REVIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const AGY_REVIEWER_SETTINGS_KEYS = Object.freeze([
  'AGY_KEYCHAIN_PATH',
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);
const AGY_REVIEWER_KEYCHAIN_RELATIVE_PATH = 'Library/Keychains/login.keychain-db';
const DEFAULT_DISPATCH_WORKER_USER = 'agentos-worker';
const DISPATCH_WORKER_USER_ENV = ['AGENT_OS_WORKER_RUN_AS_USER', 'HQ_WORKER_RUN_AS_USER'];

// The reviewer child learns its leased identity from these (set by the
// reviewer-runtime adapter in the child env only, never in the watcher's).
const AGY_IDENTITY_USER_ENV = 'ADVERSARIAL_REVIEW_AGY_IDENTITY_USER';
const AGY_IDENTITY_REVIEW_ID_ENV = 'ADVERSARIAL_REVIEW_AGY_REVIEW_ID';

// sudo's env_reset strips the caller's environment anyway (no SETENV); pass a
// minimal one so nothing even reaches sudo itself.
const PINNED_COMMAND_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' });

const HELPER_TIMEOUT_MS = 30_000;
// `agy models` under launchd takes ~30s; the keychain helper bounds it at 60s.
const PROBE_TIMEOUT_MS = 90_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const LEASE_WAIT_MS = 5 * 60_000;
const LEASE_POLL_MS = 2_000;
// acquire() runs its own readiness pass when the last one is older than this,
// so a lease never depends on which dispatch path ran before it.
const READINESS_MAX_AGE_MS = 60_000;
// A review that could not lease an identity. Transient, and deliberately not
// `reviewer-timeout`: no reviewer ran, so nothing timed out.
const AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS = 'agy-identity-unavailable';
const STATE_SUBDIR = ['state', 'agy-reviewer-identities'];
// sudo keeps the caller's cwd, and an added identity cannot enter the HQ
// owner's 0700 snapshot or per-user TMPDIR. agy runs as that user from an
// empty world-traversable dir here and reaches its scratch copy via --add-dir.
const AGY_IDENTITY_CWD_PARENT = '/private/tmp';

class AgyReviewerIdentityError extends Error {
  constructor(message, { reason = 'agy-identity-failed', detail = '' } = {}) {
    super(message);
    this.name = 'AgyReviewerIdentityError';
    this.reason = reason;
    this.detail = detail;
  }
}

function resolveHqOwner() {
  return userInfo().username;
}

// The dispatch-worker user(s): `agentos-worker` always, plus whatever the
// DBH-07 run-as knob names. No reviewer identity may ever be one of them.
function resolveDispatchWorkerUsers(env = process.env) {
  const users = new Set([DEFAULT_DISPATCH_WORKER_USER]);
  for (const name of DISPATCH_WORKER_USER_ENV) {
    const value = String(env?.[name] || '').trim();
    if (value) users.add(value);
  }
  return users;
}

function identityRefusal(user, { workerUsers }) {
  if (!AGY_REVIEWER_USER_RE.test(user)) return `refusing identity ${JSON.stringify(user)}: not a local user name`;
  if (user === 'root') return 'refusing identity root';
  if (workerUsers.has(user)) {
    return `refusing identity ${user}: it is the dispatch-worker user, and no reviewer credential may live under it`;
  }
  return null;
}

// The identity plan for one configured list. `multi` is false exactly when
// behaviour must stay as it was before CCX-08: the cli runtime, the key unset,
// or a list naming only the HQ owner.
function resolveAgyReviewerIdentityPlan({
  identities = [],
  runtime = 'antigravity',
  hqOwner = resolveHqOwner(),
  env = process.env,
} = {}) {
  const single = { multi: false, hqOwner, identities: [{ user: hqOwner, hqOwner: true }], refused: [] };
  if (runtime !== 'antigravity') return single;
  const ordered = [...new Set((identities || []).map((user) => String(user)))];
  if (!ordered.some((user) => user !== hqOwner)) return single;
  const workerUsers = resolveDispatchWorkerUsers(env);
  const plan = { multi: true, hqOwner, identities: [], refused: [] };
  for (const user of ordered) {
    const refusal = identityRefusal(user, { workerUsers });
    if (refusal) plan.refused.push({ user, reason: refusal });
    else plan.identities.push({ user, hqOwner: user === hqOwner });
  }
  return plan;
}

// ── Settings (mirrors cwp_dispatch.agy_reviewer_identity, CCX-07) ────────────

function canonicalAgySettings(settings, home) {
  const root = String(home || '').replace(/\/+$/, '');
  const lines = [];
  for (const key of AGY_REVIEWER_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    let value = String(settings[key]);
    if (key === 'AGY_KEYCHAIN_PATH' && root && value.startsWith(`${root}/`)) {
      value = `~/${value.slice(root.length + 1)}`;
    }
    lines.push(`${key}=${value}`);
  }
  if (!Object.prototype.hasOwnProperty.call(settings, 'AGY_KEYCHAIN_PATH')) {
    lines.push(`AGY_KEYCHAIN_PATH=~/${AGY_REVIEWER_KEYCHAIN_RELATIVE_PATH}`);
  }
  return lines.sort();
}

// The HQ-owner path's effective agy settings: it runs agy directly, so what
// its environment carries of the settings keys is what agy sees there.
function referenceAgySettingsFromEnv(env = process.env) {
  const present = {};
  for (const key of AGY_REVIEWER_SETTINGS_KEYS) {
    if (env?.[key] !== undefined) present[key] = env[key];
  }
  return canonicalAgySettings(present, env?.HOME || homedir());
}

function agySettingsDrift(reference, effective) {
  const toMap = (lines) => new Map(lines
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const ref = toMap(reference);
  const eff = toMap(effective);
  const drift = [];
  for (const key of [...new Set([...ref.keys(), ...eff.keys()])].sort()) {
    if (!eff.has(key)) drift.push(`${key} is set on the HQ-owner path but not for the identity`);
    else if (!ref.has(key)) drift.push(`${key} is set for the identity but not on the HQ-owner path`);
    else if (ref.get(key) !== eff.get(key)) drift.push(`${key} differs from the HQ-owner path`);
  }
  return drift;
}

function parseHelperKeyValues(stdout) {
  const out = {};
  for (const line of String(stdout || '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function settingsLines(stdout) {
  return String(stdout || '').split('\n').filter((line) => line && !line.startsWith('#'));
}

// ── Pinned commands through sudo ────────────────────────────────────────────

function buildPinnedCommand({ user, command, args = [], libexecDir = AGY_REVIEWER_LIBEXEC_DIR, sudo = AGY_REVIEWER_SUDO }) {
  if (!AGY_REVIEWER_USER_RE.test(String(user || ''))) {
    throw new AgyReviewerIdentityError(`refusing identity ${JSON.stringify(user)}: not a local user name`, { reason: 'agy-identity-refused' });
  }
  return { command: sudo, args: ['-n', '-H', '-u', user, join(libexecDir, command), ...args] };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Run one process to completion with a wall-clock bound. `stdin` is a string,
// a Buffer, a readable stream, or null (closed). Never rejects: the caller
// decides what a failure means.
function runBoundedProcess(command, args, { stdin = null, timeoutMs = HELPER_TIMEOUT_MS, env = PINNED_COMMAND_ENV, cwd, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(err?.message || err), timedOut: false, error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on('error', (err) => finish({ code: null, signal: null, error: err }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin?.on('error', () => {});
    if (stdin && typeof stdin.pipe === 'function') {
      stdin.on('error', () => child.stdin?.destroy());
      stdin.pipe(child.stdin);
    } else {
      child.stdin?.end(stdin ?? undefined);
    }
  });
}

async function runPinnedCommand({ user, command, args = [], stdin = null, timeoutMs = HELPER_TIMEOUT_MS, libexecDir, sudo, spawnImpl }) {
  const pinned = buildPinnedCommand({ user, command, args, libexecDir, sudo });
  return runBoundedProcess(pinned.command, pinned.args, { stdin, timeoutMs, spawnImpl });
}

function describeFailure(label, result) {
  if (result.timedOut) return `${label} timed out`;
  const detail = String(result.stderr || result.error?.message || '').trim().split('\n').pop() || '';
  return `${label} exited ${result.code ?? result.signal ?? 'abnormally'}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

// Processes whose real user is `user`. `ps` needs no privilege for this, and
// sudo gives the command it runs that real user, so this sees agy and anything
// agy left behind. ps exits 1 with no output when nothing matches. Never
// rejects; `ok: false` means the answer is unknown.
async function listUserProcesses({ user, runImpl = runBoundedProcess, ps = AGY_REVIEWER_PS } = {}) {
  if (!AGY_REVIEWER_USER_RE.test(String(user || ''))) {
    return { ok: false, pids: [], error: `not a local user name: ${JSON.stringify(user)}` };
  }
  const result = await runImpl(ps, ['-U', user, '-o', 'pid='], { timeoutMs: HELPER_TIMEOUT_MS });
  const stderr = String(result.stderr || '').trim();
  if (result.timedOut || result.error || !(result.code === 0 || (result.code === 1 && !stderr))) {
    return { ok: false, pids: [], error: describeFailure('ps', result) };
  }
  const pids = String(result.stdout || '').split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return { ok: true, pids };
}

// ── Workspace (reviewer child and watcher) ──────────────────────────────────

function assertReviewId(reviewId) {
  if (!AGY_REVIEWER_REVIEW_ID_RE.test(String(reviewId || ''))) {
    throw new AgyReviewerIdentityError(`refusing review id ${JSON.stringify(reviewId)}`, { reason: 'agy-identity-review-id' });
  }
}

// Resolve `promise`, or `onTimeout()` once `ms` elapses first.
function settleWithin(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Stream `sourceDir` as an uncompressed tar into the workspace helper's
// `extract`, running as `user`. It unpacks into a fresh 0700 directory under
// that user's scratch root; no HQ-owned path gains any access for it.
//
// `tar -c` is bounded separately from the helper. A helper that exits (or never
// spawns) before draining stdin leaves tar blocked on a full pipe forever, so
// once the helper settles without a workspace tar is killed rather than
// awaited, and a successful helper leaves tar only `tarGraceMs` to exit.
async function extractAgyReviewWorkspace({
  user,
  reviewId,
  sourceDir,
  runPinnedImpl = runPinnedCommand,
  spawnImpl = spawn,
  tar = AGY_REVIEWER_TAR,
  timeoutMs = EXTRACT_TIMEOUT_MS,
  tarGraceMs = HELPER_TIMEOUT_MS,
} = {}) {
  assertReviewId(reviewId);
  const archive = spawnImpl(tar, ['-cf', '-', '-C', sourceDir, '.'], { env: PINNED_COMMAND_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let tarStderr = '';
  archive.stderr?.on('data', (chunk) => { if (tarStderr.length < 64 * 1024) tarStderr += chunk; });
  archive.stdout?.on('error', () => {});
  const tarExit = new Promise((resolve) => {
    archive.on('error', (err) => resolve({ code: null, error: err }));
    archive.on('close', (code, signal) => resolve({ code, signal }));
  });
  const stopArchive = () => {
    try { archive.stdout?.destroy(); } catch { /* already closed */ }
    try { archive.kill('SIGKILL'); } catch { /* already gone */ }
  };
  const tarTimer = setTimeout(stopArchive, timeoutMs);
  tarTimer.unref?.();
  let result = null;
  let dir = '';
  let tarResult;
  try {
    try {
      result = await runPinnedImpl({ user, command: AGY_REVIEWER_WORKSPACE_HELPER, args: ['extract', reviewId], stdin: archive.stdout, timeoutMs });
      dir = result?.code === 0 ? parseHelperKeyValues(result.stdout)['workspace.dir'] || '' : '';
    } finally {
      // The helper is done reading stdin however it ended (including a throw).
      if (!dir) stopArchive();
    }
    if (!dir) {
      throw new AgyReviewerIdentityError(describeFailure(`workspace extract as ${user}`, result), { reason: 'agy-identity-extract-failed' });
    }
    tarResult = await settleWithin(tarExit, tarGraceMs, () => {
      stopArchive();
      return { code: null, error: new Error(`tar did not exit within ${tarGraceMs}ms of the extract finishing`) };
    });
  } finally {
    clearTimeout(tarTimer);
  }
  if (tarResult.code !== 0) {
    throw new AgyReviewerIdentityError(
      `archiving the review snapshot for ${user} failed: ${String(tarStderr || tarResult.error?.message || tarResult.signal || tarResult.code).trim().slice(0, 200)}`,
      { reason: 'agy-identity-extract-failed' },
    );
  }
  return { user, reviewId, dir };
}

async function cleanupAgyReviewWorkspace({ user, reviewId, runPinnedImpl = runPinnedCommand, log = console } = {}) {
  try {
    assertReviewId(reviewId);
    const result = await runPinnedImpl({ user, command: AGY_REVIEWER_WORKSPACE_HELPER, args: ['cleanup', reviewId] });
    if (result.code !== 0) {
      log.warn?.(`[agy-identities] identity=${user} review=${reviewId} ${describeFailure('workspace cleanup', result)}`);
      return { ok: false, removed: false };
    }
    return { ok: true, removed: parseHelperKeyValues(result.stdout)['workspace.removed'] === 'yes' };
  } catch (err) {
    log.warn?.(`[agy-identities] identity=${user} review=${reviewId} workspace cleanup threw: ${err?.message || err}`);
    return { ok: false, removed: false };
  }
}

async function sweepAgyReviewWorkspaces({ user, runPinnedImpl = runPinnedCommand, log = console } = {}) {
  const result = await runPinnedImpl({ user, command: AGY_REVIEWER_WORKSPACE_HELPER, args: ['sweep'] });
  if (result.code !== 0) {
    log.warn?.(`[agy-identities] identity=${user} ${describeFailure('workspace sweep', result)}`);
    return { user, ok: false, swept: 0 };
  }
  const swept = Number.parseInt(parseHelperKeyValues(result.stdout)['workspace.swept'] || '0', 10) || 0;
  if (swept > 0) log.log?.(`[agy-identities] identity=${user} startup sweep removed ${swept} leaked scratch dir(s)`);
  return { user, ok: true, swept };
}

// The reviewer child's leased identity, from the env the adapter set. Null
// means the HQ-owner path. A malformed or refused identity throws (fail
// closed): it must never silently fall back to the HQ owner's keychain.
function resolveAgyReviewIdentityFromEnv(env = process.env, { hqOwner = resolveHqOwner() } = {}) {
  const user = String(env?.[AGY_IDENTITY_USER_ENV] || '').trim();
  if (!user || user === hqOwner) return null;
  const refusal = identityRefusal(user, { workerUsers: resolveDispatchWorkerUsers(env) });
  if (refusal) throw new AgyReviewerIdentityError(refusal, { reason: 'agy-identity-refused' });
  const reviewId = String(env?.[AGY_IDENTITY_REVIEW_ID_ENV] || '').trim();
  assertReviewId(reviewId);
  return { user, reviewId };
}

// Reviewer child: stage one added-identity review. `run` is `{ user, reviewId }`
// and is filled in place (`cwd`, `workspaceDir`) so the caller's `finally` can
// always hand it to finishAgyIdentityReview, whatever step threw.
async function prepareAgyIdentityReview(run, { sourceDir, cwdParent = AGY_IDENTITY_CWD_PARENT, extractImpl = extractAgyReviewWorkspace } = {}) {
  run.cwd = mkdtempSync(join(cwdParent, 'agy-review-cwd-'));
  chmodSync(run.cwd, 0o755);
  const workspace = await extractImpl({ user: run.user, reviewId: run.reviewId, sourceDir });
  run.workspaceDir = workspace.dir;
  return run;
}

// Runs on every exit path of the review (success, failure, timeout). The
// workspace helper's cleanup is idempotent, so the watcher's lease release
// running it again (for a child that was SIGKILLed) is harmless.
async function finishAgyIdentityReview(run, { cleanupImpl = cleanupAgyReviewWorkspace, log = console } = {}) {
  if (!run) return null;
  const cleanup = await cleanupImpl({ user: run.user, reviewId: run.reviewId, log });
  if (run.cwd) {
    try { rmSync(run.cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return cleanup;
}

// ── Watcher-side identity pool ──────────────────────────────────────────────

function readBootstrapRecord(user, { env = process.env } = {}) {
  const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  try {
    return JSON.parse(readFileSync(join(hqRoot, ...STATE_SUBDIR, `${user}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function defaultCheckHqOwnerAuth({ env }) {
  const { env: scrubbed } = scrubOAuthFallbackEnv({ ...env, HOME: env.HOME || homedir() });
  return checkAgyReviewerAuth({ env: scrubbed, cacheSuccess: false });
}

function createAgyReviewerIdentityPool({
  env = process.env,
  log = console,
  now = Date.now,
  hqOwner = resolveHqOwner(),
  loadIdentities = () => resolveGeminiReviewerIdentities({ env }),
  resolveRuntime = () => resolveGeminiRuntime({ env }),
  runPinnedImpl = runPinnedCommand,
  checkHqOwnerAuthImpl = defaultCheckHqOwnerAuth,
  readBootstrapRecordImpl = (user) => readBootstrapRecord(user, { env }),
  referenceSettings = () => referenceAgySettingsFromEnv(env),
  listUserProcessesImpl = listUserProcesses,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  leaseWaitMs = LEASE_WAIT_MS,
  leasePollMs = LEASE_POLL_MS,
  readinessMaxAgeMs = READINESS_MAX_AGE_MS,
} = {}) {
  const states = new Map();
  const probes = new Map();
  let lastReadinessAt = null;
  let readinessInFlight = null;

  function currentPlan() {
    let runtime;
    let identities;
    try {
      runtime = resolveRuntime();
      identities = runtime === 'antigravity' ? loadIdentities() : [];
    } catch (err) {
      // An unreadable config leaves the pre-CCX-08 path in charge rather than
      // guessing at identities.
      log.warn?.(`[agy-identities] reviewer.gemini.identities unreadable; using the HQ owner only: ${err?.message || err}`);
      return resolveAgyReviewerIdentityPlan({ identities: [], runtime: 'cli', hqOwner, env });
    }
    return resolveAgyReviewerIdentityPlan({ identities, runtime, hqOwner, env });
  }

  function stateFor(identity) {
    let state = states.get(identity.user);
    if (!state) {
      // Fail closed: an added identity is not leased before its first
      // readiness pass. The HQ owner starts ready, as it always has.
      state = {
        user: identity.user,
        hqOwner: identity.hqOwner,
        ready: identity.hqOwner,
        reasons: identity.hqOwner ? [] : ['no readiness pass yet'],
        needsProbe: false,
        draining: false,
        lease: null,
        bootstrapCheckedAt: null,
      };
      states.set(identity.user, state);
    }
    return state;
  }

  function transition(state, ready, reasons = []) {
    const was = state.ready;
    state.ready = ready;
    state.reasons = reasons;
    if (was && !ready) {
      log.warn?.(`[agy-identities] identity=${state.user} isolated: ${reasons.join('; ') || 'readiness failed'}`);
    } else if (!was && ready) {
      log.log?.(`[agy-identities] identity=${state.user} ${state.everReady ? 're-admitted' : 'ready'}`);
    }
    if (ready) state.everReady = true;
  }

  function isolate(state, reasons, { needsProbe = true } = {}) {
    state.needsProbe = state.needsProbe || needsProbe;
    transition(state, false, reasons);
  }

  // A full `agy models` probe re-admits an identity whose failure the cheap
  // check cannot see (a failed review, a failed bootstrap probe). It runs in
  // the background so a watcher pass never waits the ~30s it takes.
  function startProbe(state) {
    if (probes.has(state.user)) return;
    const run = (async () => {
      let ok = false;
      let reason = 'readiness probe failed';
      try {
        if (state.hqOwner) {
          const result = await checkHqOwnerAuthImpl({ env });
          ok = Boolean(result?.ok);
          if (!ok) reason = `agy auth probe failed (${result?.reason || 'unknown'})`;
        } else {
          const result = await runPinnedImpl({ user: state.user, command: AGY_REVIEWER_KEYCHAIN_HELPER, args: ['probe'], timeoutMs: PROBE_TIMEOUT_MS });
          ok = result.code === 0 && parseHelperKeyValues(result.stdout)['probe.ok'] === 'yes';
          if (!ok) reason = describeFailure('agy models probe', result);
        }
      } catch (err) {
        reason = `readiness probe threw: ${err?.message || err}`;
      }
      if (ok) {
        state.needsProbe = false;
        if (!state.checkFailed && !state.draining) transition(state, true, []);
      } else {
        transition(state, false, [reason]);
      }
    })().finally(() => probes.delete(state.user));
    probes.set(state.user, run);
  }

  async function checkAddedIdentity(state) {
    const reasons = [];
    const [status, settings] = await Promise.all([
      runPinnedImpl({ user: state.user, command: AGY_REVIEWER_KEYCHAIN_HELPER, args: ['status'] }),
      runPinnedImpl({ user: state.user, command: AGY_REVIEWER_KEYCHAIN_HELPER, args: ['settings'] }),
    ]);
    if (status.code !== 0) {
      reasons.push(describeFailure('keychain status', status));
    } else {
      const fields = parseHelperKeyValues(status.stdout);
      if (fields['keychain.exists'] !== 'yes') reasons.push('login keychain missing');
      if (fields['keychain.item'] !== 'readable') reasons.push(`agy keychain item ${fields['keychain.item'] || 'unknown'}`);
      if (fields['settings.valid'] !== 'yes') reasons.push('settings file invalid');
    }
    if (settings.code !== 0) {
      reasons.push(describeFailure('settings', settings));
    } else {
      const drift = agySettingsDrift(referenceSettings(), settingsLines(settings.stdout));
      if (drift.length) reasons.push(`settings drift: ${drift.join('; ')}`);
    }
    return reasons;
  }

  function applyBootstrapRecord(state) {
    const record = readBootstrapRecordImpl(state.user);
    if (!record || record.ready !== false || !record.checkedAt || record.checkedAt === state.bootstrapCheckedAt) return;
    state.bootstrapCheckedAt = record.checkedAt;
    const reasons = Array.isArray(record.reasons) ? record.reasons.map(String) : [];
    isolate(state, [`keychain bootstrap isolated it${reasons.length ? `: ${reasons.join('; ')}` : ''}`]);
  }

  // Survivors of a finished review as an added identity: agy killed on a
  // timeout it could not be reached for, or its language server. The HQ owner
  // cannot signal them, so the identity stays unleased until they are gone.
  // An unknown answer counts as busy (fail closed).
  async function checkDrained(state) {
    let result;
    try {
      result = await listUserProcessesImpl({ user: state.user });
    } catch (err) {
      result = { ok: false, pids: [], error: err?.message || String(err) };
    }
    if (result?.ok && result.pids.length === 0) {
      state.draining = false;
      return { drained: true, reason: null };
    }
    const reason = result?.ok
      ? `${result.pids.length} process(es) still running as ${state.user} (pid ${result.pids.slice(0, 5).join(', ')}); not leased until they exit`
      : `cannot tell whether processes still run as ${state.user}: ${result?.error || 'unknown'}`;
    state.draining = true;
    return { drained: false, reason };
  }

  // One readiness pass. Returns the ready-identity count in multi-identity
  // mode, or null when the pre-CCX-08 path applies. Concurrent callers share
  // the pass in flight.
  function refreshReadiness() {
    if (!readinessInFlight) {
      readinessInFlight = runReadinessPass().finally(() => { readinessInFlight = null; });
    }
    return readinessInFlight;
  }

  async function runReadinessPass() {
    const plan = currentPlan();
    if (!plan.multi) return null;
    for (const refused of plan.refused) {
      const state = stateFor({ user: refused.user, hqOwner: false });
      if (state.ready || state.reasons[0] !== refused.reason) {
        state.ready = false;
        state.reasons = [refused.reason];
        log.error?.(`[agy-identities] identity=${refused.user} ${refused.reason}`);
      }
    }
    await Promise.all(plan.identities.map(async (identity) => {
      const state = stateFor(identity);
      if (!identity.hqOwner) {
        // A probe running as this user would read as a survivor; wait for it.
        if (state.draining && !state.lease && !probes.has(identity.user)) {
          const { drained, reason } = await checkDrained(state);
          if (!drained) {
            transition(state, false, [reason]);
            return;
          }
        }
        if (state.draining) return;
        applyBootstrapRecord(state);
        let reasons;
        try {
          reasons = await checkAddedIdentity(state);
        } catch (err) {
          reasons = [`readiness check threw: ${err?.message || err}`];
        }
        state.checkFailed = reasons.length > 0;
        if (state.checkFailed) {
          transition(state, false, reasons);
          return;
        }
      }
      if (state.needsProbe) {
        startProbe(state);
        return;
      }
      transition(state, true, []);
    }));
    lastReadinessAt = now();
    return readyCount(plan);
  }

  function readinessStale(plan) {
    if (lastReadinessAt === null || now() - lastReadinessAt >= readinessMaxAgeMs) return true;
    return plan.identities.some((identity) => !identity.hqOwner && !states.has(identity.user));
  }

  function readyCount(plan = currentPlan()) {
    if (!plan.multi) return null;
    return plan.identities.filter((identity) => states.get(identity.user)?.ready).length;
  }

  function tryAcquire(plan, { reviewId }) {
    for (const identity of plan.identities) {
      const state = stateFor(identity);
      if (!state.ready || state.lease) continue;
      const lease = { user: identity.user, hqOwner: identity.hqOwner, reviewId };
      state.lease = lease;
      return lease;
    }
    return null;
  }

  // Lease one ready identity, in configured order. The dispatch cap equals
  // the ready count and counts in-flight reviews, so a free identity normally
  // exists; the bounded wait only covers an identity isolated between the
  // cap decision and this spawn. acquire() does not rely on the drain's
  // readiness pass: a dispatch path that never ran one (the pool disabled, a
  // pipeline stage) gets one here.
  async function acquire({ reviewId = `agy-${randomUUID()}` } = {}) {
    assertReviewId(reviewId);
    const deadline = now() + leaseWaitMs;
    for (;;) {
      const plan = currentPlan();
      if (!plan.multi) return { user: hqOwner, hqOwner: true, reviewId, legacy: true };
      if (readinessStale(plan)) {
        try {
          await refreshReadiness();
        } catch (err) {
          log.warn?.(`[agy-identities] readiness pass before lease failed: ${err?.message || err}`);
        }
      }
      const lease = tryAcquire(plan, { reviewId });
      if (lease) return lease;
      if (now() >= deadline) return null;
      await sleepImpl(leasePollMs);
    }
  }

  // Release on every exit path. An added identity's scratch copy is removed
  // (idempotent: the reviewer child also cleans up on its own exit paths),
  // an identity with a surviving process drains before its next lease, and a
  // failed review isolates only this identity.
  async function release(lease, { failed = false, reason = '' } = {}) {
    if (!lease || lease.legacy) return;
    const state = states.get(lease.user);
    let survivors = null;
    try {
      if (!lease.hqOwner) {
        await cleanupAgyReviewWorkspace({ user: lease.user, reviewId: lease.reviewId, runPinnedImpl, log });
        if (state) survivors = (await checkDrained(state)).reason;
      }
    } finally {
      if (state && state.lease === lease) state.lease = null;
      if (state) {
        const reasons = [];
        if (failed) reasons.push(`review ${lease.reviewId} failed${reason ? ` (${reason})` : ''}`);
        if (survivors) reasons.push(survivors);
        if (failed) isolate(state, reasons);
        else if (survivors) transition(state, false, reasons);
      }
    }
  }

  async function sweepAll() {
    const plan = currentPlan();
    if (!plan.multi) return [];
    return Promise.all(plan.identities
      .filter((identity) => !identity.hqOwner)
      .map((identity) => sweepAgyReviewWorkspaces({ user: identity.user, runPinnedImpl, log })
        .catch((err) => ({ user: identity.user, ok: false, swept: 0, error: err?.message || String(err) }))));
  }

  return {
    plan: currentPlan,
    refreshReadiness,
    readyCount: () => readyCount(),
    acquire,
    release,
    sweepAll,
    settleProbes: () => Promise.all([...probes.values()]),
    snapshot: () => [...states.values()].map(({ user, hqOwner: owner, ready, reasons, needsProbe, draining, lease }) => ({
      user, hqOwner: owner, ready, reasons: [...reasons], needsProbe, draining, leased: Boolean(lease),
    })),
  };
}

// Failure classes that say nothing about the identity that ran the review.
const NON_ISOLATING_FAILURE_CLASSES = new Set(['cancelled', 'stale-review-head', 'daemon-bounce']);

// Only a reviewer runtime that hands `subjectContext.agyIdentity` to the
// reviewer child (cli-direct) can run a review as an added identity. The
// agent-runtime adapter rebuilds subjectContext from a fixed field list and its
// router may pick the HQ os-dispatch lane, so it does not advertise this; with
// such a runtime the configured identities are inert and the pre-CCX-08
// HQ-owner path (broker cap, no lease) stays in charge.
function adapterCarriesAgyReviewerIdentity(adapter) {
  try {
    return adapter?.describe?.()?.capabilities?.agyReviewerIdentity === true;
  } catch {
    return false;
  }
}

const inertRuntimeWarned = new Set();
function warnIdentitiesInert(adapter, log) {
  let id = 'unknown';
  try { id = String(adapter?.describe?.()?.id || 'unknown'); } catch { /* keep unknown */ }
  if (inertRuntimeWarned.has(id)) return;
  inertRuntimeWarned.add(id);
  log.warn?.(`[agy-identities] reviewer.gemini.identities is set but reviewer runtime ${id} cannot run a review as an added identity; Gemini reviews on it stay on the HQ owner under the broker cap`);
}

// Wrap one reviewer spawn in an identity lease. Non-Gemini reviews, the
// single-identity case and runtimes that cannot carry an identity call
// `spawnFn(null)` untouched (the pre-CCX-08 path). Otherwise `spawnFn`
// receives `{ user, reviewId }` for an added identity, or null for the HQ
// owner, and the lease is released (scratch cleanup, failure isolation)
// whether the review succeeds, fails, times out or throws.
async function runWithAgyReviewerIdentity({
  reviewerModel,
  adapter = null,
  pool = getAgyReviewerIdentityPool(),
  log = console,
} = {}, spawnFn) {
  if (String(reviewerModel || '').toLowerCase() !== 'gemini' || !pool.plan().multi) {
    return spawnFn(null);
  }
  if (!adapterCarriesAgyReviewerIdentity(adapter)) {
    warnIdentitiesInert(adapter, log);
    return spawnFn(null);
  }
  const lease = await pool.acquire({ reviewId: `agy-${randomUUID()}` });
  if (!lease) {
    const unready = pool.snapshot()
      .filter((state) => !state.ready)
      .map((state) => `${state.user}: ${state.reasons.join('; ') || 'not ready'}`);
    const error = `no ready agy reviewer identity became free to lease${unready.length ? ` (${unready.join(' | ')})` : ''}`;
    log.warn?.(`[agy-identities] ${error}`);
    return { ok: false, failureClass: AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS, transient: true, error, stderrTail: error };
  }
  if (lease.legacy) return spawnFn(null);
  let failed = true;
  let reason = 'reviewer threw';
  try {
    const result = await spawnFn(lease.hqOwner ? null : { user: lease.user, reviewId: lease.reviewId });
    failed = !result?.ok && !NON_ISOLATING_FAILURE_CLASSES.has(result?.failureClass);
    reason = result?.failureClass || '';
    return result;
  } finally {
    await pool.release(lease, { failed, reason });
  }
}

let sharedPool = null;
function getAgyReviewerIdentityPool() {
  if (!sharedPool) sharedPool = createAgyReviewerIdentityPool();
  return sharedPool;
}
function setAgyReviewerIdentityPoolForTests(pool) {
  sharedPool = pool;
}

export {
  AGY_IDENTITY_REVIEW_ID_ENV,
  AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS,
  AGY_IDENTITY_USER_ENV,
  AGY_REVIEWER_KEYCHAIN_HELPER,
  AGY_REVIEWER_LIBEXEC_DIR,
  AGY_REVIEWER_PINNED_AGY,
  AGY_REVIEWER_SETTINGS_KEYS,
  AGY_REVIEWER_SUDO,
  AGY_REVIEWER_WORKSPACE_HELPER,
  AgyReviewerIdentityError,
  PINNED_COMMAND_ENV,
  adapterCarriesAgyReviewerIdentity,
  agySettingsDrift,
  buildPinnedCommand,
  canonicalAgySettings,
  cleanupAgyReviewWorkspace,
  createAgyReviewerIdentityPool,
  extractAgyReviewWorkspace,
  finishAgyIdentityReview,
  getAgyReviewerIdentityPool,
  listUserProcesses,
  parseHelperKeyValues,
  prepareAgyIdentityReview,
  readBootstrapRecord,
  referenceAgySettingsFromEnv,
  resolveAgyReviewIdentityFromEnv,
  resolveAgyReviewerIdentityPlan,
  resolveDispatchWorkerUsers,
  resolveHqOwner,
  runBoundedProcess,
  runWithAgyReviewerIdentity,
  runPinnedCommand,
  setAgyReviewerIdentityPoolForTests,
  sweepAgyReviewWorkspaces,
};
