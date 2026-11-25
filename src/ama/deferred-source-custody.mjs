import { execFile } from 'node:child_process';
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import fsExt from 'fs-ext';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../atomic-write.mjs';
import { PROCESS_INSPECTION_UNAVAILABLE, readDeferredValidationChecks, readUnknownValidationReceipt } from './local-validation-unknown.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const execGit = promisify(execFile);
const RETENTION_BACKOFF_MS = 5 * 60_000;
export const DEFERRED_SOURCE_HOLD = 'canonical-validation-operator-decision';

function directory(hqRoot, { repo, prNumber, headSha }) {
  if (!hqRoot || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo || '')
    || repo.split('/').some(part => part === '.' || part === '..')
    || !/^[1-9]\d*$/.test(String(prNumber)) || !sha(headSha)) return null;
  return join(hqRoot, 'dispatch', 'audit', 'deferred-source-custody',
    repo.toLowerCase(), `pr-${prNumber}`, headSha.toLowerCase());
}

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function acquireHoldLock(path, waitMs = 0) {
  const fd = openSync(`${path}.lock`, 'a', 0o600);
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { fsExt.flockSync(fd, 'exnb'); break; }
      catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code) || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function withHoldLock(path, action, waitMs = 0) {
  const fd = acquireHoldLock(path, waitMs);
  try { return action(); }
  finally { closeSync(fd); }
}

function currentHold(hold) {
  const record = read(hold.path);
  if (record.launchRequestId !== hold.launchRequestId || record.sourceHead !== hold.sourceHead
    || record.attempt !== hold.attempt) throw new Error('deferred source identity changed');
  return record;
}

export function readDeferredSourceHold(hqRoot, identity, { includeContinued = false } = {}) {
  const dir = directory(hqRoot, identity);
  if (!dir) return null;
  const path = join(dir, 'hold.json');
  try {
    if (!lstatSync(path).isFile()) throw new Error('invalid hold file');
    const record = read(path);
    if (record.schemaVersion !== 1 || record.targetHead !== identity.headSha.toLowerCase()
      || record.repo !== identity.repo.toLowerCase() || record.prNumber !== Number(identity.prNumber)
      || !sha(record.sourceHead) || !/^attempt-[a-zA-Z0-9]+$/.test(record.attempt || '')) throw new Error('invalid hold');
    if (record.continuedAt && !includeContinued) return null;
    return { ...record, path, evidenceDir: join(dir, record.attempt) };
  } catch (error) {
    return error.code === 'ENOENT' ? null : { path, unreadable: true };
  }
}

// A launch can publish or rebase before deferring. Its dispatch head is not
// necessarily the target used by the validator. Read all target markers for
// this PR, including legacy holds without a run-local controller pointer.
export function readDeferredSourceHoldsForLaunch(hqRoot, identity) {
  const candidate = directory(hqRoot, { ...identity, headSha: '0'.repeat(40) });
  if (!candidate || !identity.launchRequestId) return [];
  const prDir = dirname(candidate);
  try {
    return readdirSync(prDir).filter(sha).map(headSha =>
      readDeferredSourceHold(hqRoot, { ...identity, headSha }, { includeContinued: true }))
      .filter(hold => hold?.unreadable || hold?.launchRequestId === identity.launchRequestId);
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [{ path: prDir, unreadable: true }];
  }
}

export function continueDeferredSourceCustody(hold, { publishedHead, waitMs = 1000 } = {}) {
  return withHoldLock(hold.path, () => {
    const record = currentHold(hold);
    if (publishedHead !== hold.sourceHead && !deferredSourceRetained({ ...hold, ...record })) return false;
    writeFileAtomic(hold.path, JSON.stringify({ ...record, continuedAt: new Date().toISOString(), ...(publishedHead && { publishedHead }) }), { mode: 0o600 });
    return true;
  }, waitMs);
}

export function deferredSourceIdentity(env) {
  return { repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER,
    headSha: (env.HAM_CLOSE_VALIDATION_REMOTE_HEAD || env.HAM_TARGET_REMEDIATION_SHA)?.toLowerCase() };
}

export function findDeferredSourceHold(env) {
  const identity = deferredSourceIdentity(env);
  for (const headSha of new Set([identity.headSha, env.HAM_TARGET_REMEDIATION_SHA])) {
    const hold = readDeferredSourceHold(env.HAM_HQ_ROOT, { ...identity, headSha }, { includeContinued: true });
    if (hold && (!hold.continuedAt || deferredProcessInspectionUnavailable(hold))) return hold;
  }
  return null;
}

export function startDeferredSourceCustody({ env, launchRequestId, sourceHead, clean, files, runner }) {
  const identity = deferredSourceIdentity(env);
  const dir = directory(env.HAM_HQ_ROOT, identity);
  if (!dir || !sha(sourceHead) || !/^lrq_[a-zA-Z0-9-]+$/.test(launchRequestId || '')) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const evidenceDir = mkdtempSync(join(dir, 'attempt-'));
  const path = join(dir, 'hold.json');
  const controller = env.HAM_CONTROLLER_RECORD ? basename(env.HAM_CONTROLLER_RECORD) : null;
  const validationBase = env.HAM_CLOSE_VALIDATION_BASE || env.HAM_BASE_HEAD;
  const record = { schemaVersion: 1, repo: identity.repo.toLowerCase(), prNumber: Number(identity.prNumber),
    targetHead: identity.headSha, dispatchHead: env.HAM_TARGET_REMEDIATION_SHA?.toLowerCase(),
    sourceHead: sourceHead.toLowerCase(),
    launchRequestId, runId: env.HQ_WORKER_RUN_ID, attempt: basename(evidenceDir), controller,
    validationBase, clean, files, runner, workspace: process.cwd(), at: new Date().toISOString() };
  try {
    withHoldLock(path, () => {
      const previous = readDeferredSourceHold(env.HAM_HQ_ROOT, identity, { includeContinued: true });
      if (previous?.continuedAt && !deferredProcessInspectionUnavailable(previous) && deferredSourceRetained(previous)) {
        writeFileAtomic(join(previous.evidenceDir, 'continued-hold.json'), JSON.stringify(read(path)), { mode: 0o600 });
        writeFileAtomic(path, JSON.stringify(record), { mode: 0o600 });
      } else writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, overwrite: false });
    });
  }
  catch (error) { rmSync(evidenceDir, { recursive: true, force: true }); throw error; }
  return evidenceDir;
}

export function deferredSourceRetained(hold) {
  return !hold.unreadable && (Boolean(hold.continuedAt && hold.publishedHead === hold.sourceHead)
    || ['bundled', 'matches-target'].includes(deferredSourceStatus(hold)));
}

export async function retainDeferredCommit(hold, env, { workerRoot, now = Date.now() } = {}) {
  const fd = acquireHoldLock(hold.path);
  try {
    const record = currentHold(hold);
    if (record.continuedAt || deferredSourceStatus({ ...hold, ...record }) === 'bundled') return;
    if (workerRoot) {
      if (record.clean === false) return;
      const parent = realpathSync(dirname(workerRoot));
      const root = realpathSync(workerRoot);
      const workspace = realpathSync(record.workspace);
      const dotGit = lstatSync(join(workspace, '.git'));
      if (root !== join(parent, basename(workerRoot)) || dirname(workspace) !== root
        || !(dotGit.isDirectory() || dotGit.isFile())) return;
      const lastAttempt = Date.parse(record.lastRetentionAttemptAt);
      if (Number.isFinite(lastAttempt) && now - lastAttempt < RETENTION_BACKOFF_MS) return;
      writeFileAtomic(hold.path, JSON.stringify({ ...record, lastRetentionAttemptAt: new Date(now).toISOString() }), { mode: 0o600 });
      // Use only the resolved worker checkout and a local Git environment.
      await retainCommit({ ...hold, ...record, workspace }, { PATH: env.PATH, GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1' });
    } else {
      await retainCommit({ ...hold, ...record }, env);
    }
  } finally { closeSync(fd); }
}

async function retainCommit({ evidenceDir, sourceHead, targetHead, launchRequestId, validationBase, workspace }, env) {
  const deadline = Date.now() + 5000;
  const git = async (...args) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('deferred source retention deadline reached');
    const { stdout } = await execGit('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args],
      { cwd: workspace, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
    return stdout.trim();
  };
  if (!/^lrq_[a-zA-Z0-9-]+$/.test(launchRequestId || '')) return;
  const ref = `refs/hammer/deferred/${launchRequestId}/${sourceHead}`;
  let source = { status: 'matches-target' };
  if (sourceHead !== targetHead) {
    let temporary;
    try {
      await git('update-ref', ref, sourceHead);
      source = { status: 'local-ref-only', ref };
      // Missing prerequisite objects must not prevent a self-contained bundle.
      const prerequisites = [];
      for (const head of new Set([targetHead, ...(sha(validationBase) ? [validationBase] : [])])) {
        try { await git('cat-file', '-e', `${head}^{commit}`); prerequisites.push(head); }
        catch { /* Try a self-contained bundle if the object is unavailable. */ }
      }
      temporary = mkdtempSync(join(evidenceDir, 'retention-'));
      const bundle = join(temporary, 'source.bundle');
      await git('bundle', 'create', bundle, ref, ...prerequisites.map(head => `^${head}`));
      const advertised = await git('bundle', 'list-heads', bundle, ref);
      if (advertised !== `${sourceHead} ${ref}`) throw new Error('bundle head mismatch');
      const bundleFd = openSync(bundle, 'r');
      try { fsyncSync(bundleFd); } finally { closeSync(bundleFd); }
      renameSync(bundle, join(evidenceDir, 'source.bundle'));
      source = { status: 'bundled', ref, prerequisites, bundle: basename(bundle) };
    } catch {
      if (!source.ref) source = { status: 'workspace-only' };
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
  writeFileAtomic(join(evidenceDir, 'source.json'), JSON.stringify(source), { mode: 0o600 });
  if (source.status === 'bundled') {
    try { await git('update-ref', '-d', ref, sourceHead); }
    catch { /* The bundle is durable. Leave any remaining ref for custody maintenance. */ }
  }
}

export function retainDeferredValidation(dir, deferral, validation, receiptPath) {
  if (!dir) return;
  const checks = validation.checks.map(check => ({ ...check, ...(check.diagnostics && {
    diagnostics: check.diagnostics.map(({ path, ...diagnostic }) => {
      if (!path || !receiptPath || dirname(path) !== dirname(receiptPath)
        || !basename(path).startsWith(`${basename(receiptPath)}.check-`)) return { ...diagnostic, unavailable: true };
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid diagnostic');
        copyFileSync(path, join(dir, basename(path)));
        return { ...diagnostic, path: basename(path) };
      } catch { return { ...diagnostic, unavailable: true }; }
    }),
  }) }));
  writeFileAtomic(join(dir, 'validation.json'), JSON.stringify({ ...validation, checks }), { mode: 0o600 });
  writeFileAtomic(join(dir, 'deferred.json'), JSON.stringify(deferral), { mode: 0o600 });
}

export async function retainDeferredControllerCleanup(env, recordPath, record) {
  // The validator receives the verify-head snapshot in its own environment.
  // Find its hold through either the dispatch head or the live head it passed
  // back to the owning controller via the run-local pointer.
  const controller = basename(recordPath);
  const identity = deferredSourceIdentity(env);
  let hold;
  try {
    const { headSha } = read(join(env.HAM_RUN_DIR, `deferred-controller-${controller}`));
    hold = readDeferredSourceHold(env.HAM_HQ_ROOT, { ...identity, headSha });
  } catch { /* A missing pointer may leave a launch-bound marker. */ }
  if (hold?.launchRequestId !== record.launchRequestId || hold.controller !== controller) {
    if (record.reason !== 'validation-stopped') return;
    hold = readDeferredSourceHoldsForLaunch(env.HAM_HQ_ROOT, { ...identity, launchRequestId: record.launchRequestId })
      .find(candidate => candidate.controller === controller && !candidate.continuedAt);
  }
  if (!hold) return;
  try {
    writeFileAtomic(join(hold.evidenceDir, 'controller-cleanup.json'), JSON.stringify(record), { mode: 0o600 });
    await retainDeferredCommit(hold, env);
  } catch { /* A missing final receipt leaves cleanup unconfirmed. */ }
  if (!record.drained) return;
  try {
    const deferred = readUnknownValidationReceipt(env.HAM_RUN_DIR, hold.sourceHead);
    const validation = deferred && readDeferredValidationChecks(env.HAM_RUN_DIR, hold.sourceHead, deferred);
    if (validation) retainDeferredValidation(hold.evidenceDir, deferred, validation,
      resolve(env.HAM_RUN_DIR, deferred.localValidationReceipt));
  } catch { /* Keep the original snapshot if the final receipt is unreadable. */ }
}

export function deferredSourceStatus(hold) {
  if (hold.clean === false) return 'workspace-only';
  try {
    const source = read(join(hold.evidenceDir, 'source.json'));
    if (source.status === 'bundled') {
      if (source.bundle !== 'source.bundle' || !lstatSync(join(hold.evidenceDir, source.bundle)).isFile()) return 'unconfirmed';
      return source.status;
    }
    if (['matches-target', 'local-ref-only', 'workspace-only'].includes(source.status)) return source.status;
    return 'unconfirmed';
  }
  catch (error) {
    return error.code === 'ENOENT' && error.path === join(hold.evidenceDir, 'source.json')
      && hold.sourceHead === hold.targetHead ? 'matches-target' : 'unconfirmed';
  }
}

export function deferredCleanupFinished(hold) {
  let cleanup;
  if (hold.evidenceDir) {
    try { cleanup = read(join(hold.evidenceDir, 'controller-cleanup.json')); } catch {
      try { cleanup = read(join(hold.evidenceDir, 'bounded-cleanup.json')); } catch { /* Unconfirmed cleanup. */ }
    }
  }
  return Boolean(cleanup && cleanup.launchRequestId === hold.launchRequestId && (hold.controller
    ? cleanup.state === 'quiescent' && cleanup.drained === true
      && (cleanup.leaseCleanup?.released === true
        || ['already-released', 'no-acquisition-receipt'].includes(cleanup.leaseCleanup?.reason))
    : cleanup.head === hold.sourceHead && cleanup.cleanup === 'finished'));
}

export function deferredProcessInspectionUnavailable(hold) {
  if (!hold?.evidenceDir) return false;
  try {
    const deferredPath = join(hold.evidenceDir, 'deferred.json');
    if (!lstatSync(deferredPath).isFile()) return false;
    const deferred = read(deferredPath);
    if (deferred.head !== hold.sourceHead || deferred.validation !== 'unknown') return false;
    if (deferred.reason === PROCESS_INSPECTION_UNAVAILABLE) return true;
    // Older mirrors used the display name and surfaced the guard's exit 75
    // as an environment fault. Recover the typed result from the same attempt.
    if (deferred.reason !== 'canonical-mirror-environment-unavailable' || deferred.status !== 76) return false;
    const path = join(hold.evidenceDir, 'validation.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const evidence = read(path);
    return evidence.head === hold.sourceHead && Array.isArray(evidence.checks)
      && evidence.checks.some(check => ['Telegram responder guard', 'telegram-responder-guard'].includes(check?.name)
        && check.status === 'failed' && check.result === 'inconclusive'
        && Array.isArray(check.diagnostics) && check.diagnostics.some(diagnostic => diagnostic?.exitStatus === 75)
        && typeof check.localReason === 'string'
        && check.localReason.split('; ').some(reason =>
          /^telegram guard lane (python|node): ps unusable in this sandbox: no verdict$/.test(reason)));
  } catch { return false; }
}

export function deferredSourceNeedsDecision(hold, inspectionUnavailable = deferredProcessInspectionUnavailable(hold)) {
  // continuedAt can describe retained source that was already published. It
  // says nothing about whether the next validator can perform the local guard.
  return Boolean(inspectionUnavailable || (hold && !hold.continuedAt && (hold.unreadable
    || deferredSourceStatus(hold) !== 'matches-target' || !deferredCleanupFinished(hold))));
}

export function deferredSourceNotice(hold, inspectionUnavailable = deferredProcessInspectionUnavailable(hold)) {
  const finished = deferredCleanupFinished(hold);
  return `Operator decision required for ${hold.sourceHead || 'unknown source'} (launch ${hold.launchRequestId || 'unknown'}, `
    + `source ${deferredSourceStatus(hold)}, cleanup ${finished ? 'recorded finished' : 'unconfirmed'}). `
    + (hold.evidenceDir || hold.path ? `Evidence: ${hold.evidenceDir || hold.path}. ` : 'The launch left no readable custody package. ')
    + 'Confirm cleanup and recover this exact source for the outstanding local guards and normal publication gates, '
    + 'or explicitly discard the retained attempt after inspecting it. The watcher will hold this head.'
    + (inspectionUnavailable ? ' The Telegram responder guard could not inspect processes. Recovery requires the existing canonical validator in an approved environment that can run the guard.' : '');
}
