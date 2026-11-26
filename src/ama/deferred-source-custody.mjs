import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import fsExt from 'fs-ext';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../atomic-write.mjs';
import { amaCloserPromptDir, readAmaCloserDispatchRecord } from './dispatch-record-read.mjs';
import { closerInconclusiveRetryPolicy } from './closer-inconclusive-retry.mjs';
import { CI_AUTHORITATIVE_UNKNOWN_REASONS, PROCESS_INSPECTION_UNAVAILABLE, processInspectionRefused,
  readDeferredValidationChecks, readUnknownValidationReceipt, unknownDefersToCi } from './local-validation-unknown.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const execGit = promisify(execFile);
const RETENTION_BACKOFF_MS = 5 * 60_000;
const legacyInspectionCache = new Map();
export const DEFERRED_SOURCE_HOLD = 'canonical-validation-operator-decision';
export const deferredSourceParkContinuation = Object.freeze({
  kind: 'park', owner: 'operator',
  operatorAction: `${DEFERRED_SOURCE_HOLD}: review retained source and validation cleanup evidence`,
});

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
    const evidenceDir = join(dir, record.attempt);
    // Publication commits in source.json atomically. Read it as continuation
    // even if the process that recorded publication died before returning.
    if (record.sourceHead !== record.targetHead && !record.continuedAt) {
      try {
        const source = read(join(evidenceDir, 'source.json'));
        if (source.status === 'matches-target' && sha(source.publishedHead) && Number.isFinite(Date.parse(source.publishedAt))
          && [record.sourceHead, source.redrive?.candidate].includes(source.publishedHead)) {
          Object.assign(record, { continuedAt: source.publishedAt, publishedHead: source.publishedHead, redrivePublished: true });
        }
      } catch { /* Missing or unreadable publication evidence leaves the hold active. */ }
    }
    if (record.continuedAt && !includeContinued) return null;
    return { ...record, path, evidenceDir };
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

export function continueDeferredSourceCustody(hold, { publishedHead, watcherEvidence, waitMs = 1000 } = {}) {
  return withHoldLock(hold.path, () => {
    const record = currentHold(hold);
    const current = { ...hold, ...record };
    if (watcherEvidence) {
      if (record.continuedAt) return !deferredSourceNeedsDecision(current);
      upgradeLegacyControllerCleanup(current, watcherEvidence);
      publishedHead = deferredSourcePublishedCiAuthoritative(current, watcherEvidence) ? current.sourceHead : undefined;
      if (!publishedHead && deferredSourceNeedsDecision(current)) return false;
    }
    if (publishedHead !== hold.sourceHead && !deferredSourceRetained(current)) return false;
    writeFileAtomic(hold.path, JSON.stringify({ ...record, continuedAt: new Date().toISOString(), ...(publishedHead && { publishedHead }) }), { mode: 0o600 });
    return true;
  }, waitMs);
}

export function deferredSourceIdentity(env) {
  return { repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER,
    headSha: (env.HAM_CLOSE_VALIDATION_REMOTE_HEAD || env.HAM_TARGET_REMEDIATION_SHA)?.toLowerCase() };
}

export function findDeferredSourceHold(env, identity = deferredSourceIdentity(env), matches = () => true) {
  const heads = [identity.headSha, env.HAM_CLOSE_VALIDATION_REMOTE_HEAD, env.HAM_TARGET_REMEDIATION_SHA];
  for (const headSha of new Set(heads.map(head => head?.toLowerCase()))) {
    const hold = readDeferredSourceHold(identity.hqRoot || env.HAM_HQ_ROOT,
      { ...identity, headSha }, { includeContinued: true });
    if (hold && (!hold.continuedAt || deferredProcessInspectionUnavailable(hold)) && matches(hold)) return hold;
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
    const status = deferredSourceStatus({ ...hold, ...record });
    if (record.continuedAt || status === 'bundled' || (status === 'matches-target' && record.sourceHead !== record.targetHead)) return;
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
  let validationFinalized = false;
  try {
    if (record.drained === true) {
      const deferred = readUnknownValidationReceipt(env.HAM_RUN_DIR, hold.sourceHead);
      const validation = deferred && (!deferred.controllerRecord || deferred.controllerRecord === controller)
        && readDeferredValidationChecks(env.HAM_RUN_DIR, hold.sourceHead, deferred);
      if (validation) {
        retainDeferredValidation(hold.evidenceDir, deferred, validation, resolve(env.HAM_RUN_DIR, deferred.localValidationReceipt));
        validationFinalized = record.state === 'quiescent' && deferred.controllerRecord === controller;
      }
    }
  } catch { /* Keep the original snapshot if the final receipt is unreadable. */ }
  // Publish the cleanup proof after the check snapshot so a watcher cannot
  // pair confirmed drain with evidence collected while descendants were live.
  writeFileAtomic(join(hold.evidenceDir, 'controller-cleanup.json'),
    JSON.stringify({ ...record, controller, validationFinalized }), { mode: 0o600 });
  await retainDeferredCommit(hold, env);
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

// Only a clean, durably bundled attempt with confirmed cleanup can transfer
// custody to another launch. The worker verifies the actual Git bundle again.
export function deferredSourceRedrive(hold) {
  if (hold?.clean !== true || hold.continuedAt || hold.sourceHead === hold.targetHead
    || deferredSourceStatus(hold) !== 'bundled' || !deferredCleanupFinished(hold)
    || !/^lrq_[a-zA-Z0-9-]+$/.test(hold.launchRequestId || '')) return null;
  try {
    const source = read(join(hold.evidenceDir, 'source.json'));
    const ref = `refs/hammer/deferred/${hold.launchRequestId}/${hold.sourceHead}`;
    return source.status === 'bundled' && source.ref === ref ? { hold, source } : null;
  } catch { return null; }
}

export function deferredSourceRetryAvailable(pending, policy = closerInconclusiveRetryPolicy()) {
  const count = pending?.source.redrive?.count ?? 0;
  return Boolean(pending && !pending.source.redrive?.refusal && Number.isSafeInteger(count)
    && count >= 0 && count < policy.surfaceAfterAttempts);
}

export function deferredSourceRedriveEnabled(cfg) {
  return cfg.autonomousMergeExecutionEnabled !== false
    && !cfg.mergeDisabledForRepository && cfg.hammerLifetimeDispatchCeiling !== 0;
}

export function readDeferredSourceRedrive(hqRoot, identity, { includePublished = false } = {}) {
  const exact = deferredSourceRedrive(readDeferredSourceHold(hqRoot, identity));
  if (exact || !includePublished) return exact;
  const matches = readHistoricalDeferredSources(hqRoot, identity).filter(({ hold, source }) =>
    [hold.sourceHead, source.redrive?.candidate].includes(identity.headSha));
  // Ambiguous publication evidence requires operator selection.
  return matches.length === 1 ? matches[0] : null;
}

function readHistoricalDeferredSources(hqRoot, identity) {
  const dir = directory(hqRoot, identity);
  if (!dir) return [];
  try {
    return readdirSync(dirname(dir)).sort().filter(headSha => sha(headSha) && headSha !== identity.headSha).flatMap(headSha => {
      const pending = deferredSourceRedrive(readDeferredSourceHold(hqRoot, { ...identity, headSha }));
      return pending ? [pending] : [];
    });
  } catch { return []; }
}

export function deferredSourceRedriveObservation(pending, head, policy) {
  if (!pending) return null;
  const { hold, source } = pending;
  const published = [hold.sourceHead, source.redrive?.candidate].includes(head);
  const unsettled = source.redrive?.unsettled === true && !source.redrive?.refusal;
  if (!published && (hold.targetHead !== head || (!unsettled && !deferredSourceRetryAvailable(pending, policy)))) return null;
  return { head, id: `${hold.targetHead}/${hold.attempt}`, attempt: (source.redrive?.count ?? 0) + 1,
    nextAttemptAt: published ? null : source.redrive?.nextAttemptAt ?? null };
}

function updateRedrive(pending, update) {
  const { hold } = pending;
  return withHoldLock(hold.path, () => {
    const current = deferredSourceRedrive({ ...hold, ...currentHold(hold) });
    if (!current) return false;
    const source = update(current.source);
    if (!source) return false;
    writeFileAtomic(join(hold.evidenceDir, 'source.json'), JSON.stringify(source), { mode: 0o600 });
    return source;
  }, 1000);
}

export function reserveDeferredSourceRedrive(pending, { now, policy, headSha, reservationId }) {
  const reserved = updateRedrive(pending, source => {
    const count = source.redrive?.count ?? 0;
    if (headSha !== pending.hold.targetHead || !Number.isFinite(now)
      || !deferredSourceRetryAvailable({ ...pending, source }, policy)) return null;
    if (source.redrive?.unsettled || count !== (pending.source.redrive?.count ?? 0)
      || Date.parse(source.redrive?.nextAttemptAt) > now) return null;
    const delay = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** count);
    return { ...source, redrive: { ...source.redrive, count: count + 1, headSha,
      reservationId: reservationId ?? randomUUID(), ...(reservationId ? { unsettled: true } : {}),
      nextAttemptAt: new Date(now + delay).toISOString() } };
  });
  return reserved ? reserved.redrive : null;
}

// Reconcile only the matching reservation. Keep its clock and validated
// candidate so repeated infrastructure failures are paced and a late-visible
// publication can still settle on the observed candidate.
export function settleDeferredSourceRedrive(pending, reservationId, { charge }) {
  return updateRedrive(pending, source => {
    if (!reservationId || source.redrive?.reservationId !== reservationId || !source.redrive.unsettled) return null;
    const redrive = { ...source.redrive };
    delete redrive.unsettled;
    if (!charge && !redrive.refusal) redrive.count--;
    return { ...source, redrive };
  });
}

export function refundDeferredSourceRedrive(pending, reservation) {
  return Boolean(updateRedrive(pending, source => {
    if (source.redrive?.reservationId !== reservation.reservationId
      || source.redrive?.candidate !== pending.source.redrive?.candidate || source.redrive?.refusal) return null;
    return { ...source, redrive: pending.source.redrive };
  }));
}

export function recordDeferredSourceRefusal(pending, refusal) {
  return Boolean(updateRedrive(pending, source => {
    if (source.redrive?.count !== pending.source.redrive?.count
      || source.redrive?.reservationId !== pending.source.redrive?.reservationId) return null;
    const redrive = { ...source.redrive, refusal };
    delete redrive.unsettled;
    return { ...source, redrive };
  }));
}

export function recordDeferredSourceCandidate(pending, candidate) {
  if (!sha(candidate)) return false;
  return Boolean(updateRedrive(pending, source => source.redrive?.count === pending.source.redrive?.count
    && source.redrive?.reservationId === pending.source.redrive?.reservationId
    && !source.redrive?.refusal ? { ...source, redrive: { ...source.redrive, candidate } } : null));
}

export function completeDeferredSourceRedrive(pending, publishedHead) {
  return Boolean(updateRedrive(pending, source => {
    if (publishedHead !== source.redrive?.candidate && publishedHead !== pending.hold.sourceHead) return null;
    if (source.redrive?.unsettled) delete source.redrive.unsettled;
    return { ...source, status: 'matches-target', publishedHead, publishedAt: new Date().toISOString() };
  }));
}

function deferredCleanupReceipt(hold) {
  let cleanup;
  if (hold.evidenceDir) {
    try { cleanup = read(join(hold.evidenceDir, 'controller-cleanup.json')); } catch {
      try { cleanup = read(join(hold.evidenceDir, 'bounded-cleanup.json')); } catch { /* Unconfirmed cleanup. */ }
    }
  }
  return cleanup;
}

export function deferredCleanupFinished(hold, cleanup = deferredCleanupReceipt(hold)) {
  return Boolean(cleanup && cleanup.launchRequestId === hold.launchRequestId && (hold.controller
    ? cleanup.state === 'quiescent' && cleanup.drained === true
      && (cleanup.leaseCleanup?.released === true
        || ['already-released', 'no-acquisition-receipt'].includes(cleanup.leaseCleanup?.reason))
    : cleanup.head === hold.sourceHead && cleanup.cleanup === 'finished'));
}

function legacyRunDir(hold, { rootDir, repo }) {
  const dispatch = readAmaCloserDispatchRecord(rootDir,
    { repo, prNumber: hold.prNumber, headSha: hold.dispatchHead ?? hold.targetHead });
  if (dispatch?.launchRequestId === hold.launchRequestId && dispatch.scratchDir && dispatch.promptDir) {
    return { runDir: dispatch.scratchDir, promptDir: dispatch.promptDir };
  }
  // A later dispatch may have replaced the record. The old cleanup writer
  // could already have archived the absolute receipt reference.
  const { localValidationReceipt } = read(join(hold.evidenceDir, 'deferred.json'));
  if (typeof localValidationReceipt === 'string' && isAbsolute(localValidationReceipt)) {
    return { runDir: dirname(localValidationReceipt), promptDir: amaCloserPromptDir(rootDir) };
  }
  return {};
}

// Called with the hold lock. The old cleanup receipt precedes the copy, so
// even an apparently complete archive cannot establish post-drain evidence.
function upgradeLegacyControllerCleanup(hold, { rootDir, repo, liveHead, requiredContexts }) {
  if (!rootDir || hold.clean !== true || hold.sourceHead !== liveHead?.toLowerCase()
    || !requiredContexts?.length || !/^controller-[a-f0-9-]{36}\.json$/.test(hold.controller)) return;
  const cleanup = deferredCleanupReceipt(hold);
  if (cleanup?.validationFinalized !== undefined || !deferredCleanupFinished(hold, cleanup)
    || `controller-${cleanup.token}.json` !== hold.controller) return;

  let deferred, validation, receiptPath;
  try {
    const run = legacyRunDir(hold, { rootDir, repo });
    if (!run.runDir || !basename(run.runDir).startsWith('hammer-scratch-')
      || !lstatSync(run.runDir).isDirectory()) return;
    const runDir = resolve(run.runDir);
    const canonicalRunDir = realpathSync(runDir);
    if (dirname(canonicalRunDir) !== realpathSync(run.promptDir)) return;
    const controllerPath = join(runDir, hold.controller);
    if (!lstatSync(controllerPath).isFile()) return;
    const controller = read(controllerPath);
    if (controller.token !== cleanup.token || !controller.finishedAt
      || controller.finishedAt !== cleanup.finishedAt || !deferredCleanupFinished(hold, controller)) return;

    if (!lstatSync(join(runDir, `validation-deferred-${hold.sourceHead}.json`)).isFile()) return;
    deferred = readUnknownValidationReceipt(runDir, hold.sourceHead);
    if (deferred?.validation !== 'unknown' || deferred.controllerRecord !== hold.controller
      || deferred.localFailureObserved !== false || typeof deferred.localValidationReceipt !== 'string') return;
    receiptPath = resolve(runDir, deferred.localValidationReceipt);
    if (!receiptPath.startsWith(`${runDir}${sep}`)
      || realpathSync(receiptPath) !== join(canonicalRunDir, receiptPath.slice(runDir.length + 1))
      || !lstatSync(receiptPath).isFile()) return;
    validation = readDeferredValidationChecks(runDir, hold.sourceHead, deferred);
    // Pre-upgrade ordinary validators recorded cleanliness on the hold only.
    const cleanCheckout = deferred.cleanCheckout === undefined ? hold.clean : deferred.cleanCheckout;
    if (!validation || !unknownDefersToCi({ reason: deferred.reason, requiredContexts,
      checks: validation.checks, cleanCheckout }).ciAuthoritative) return;
  } catch { return; } // Original evidence may be unavailable this pass.

  retainDeferredValidation(hold.evidenceDir, { ...deferred, cleanCheckout: true }, validation, receiptPath);
  writeFileAtomic(join(hold.evidenceDir, 'controller-cleanup.json'),
    JSON.stringify({ ...cleanup, controller: hold.controller, validationFinalized: true }), { mode: 0o600 });
}

export function deferredProcessInspectionUnavailable(hold) {
  if (!hold?.evidenceDir || hold.redrivePublished) return false;
  try {
    const deferredPath = join(hold.evidenceDir, 'deferred.json');
    if (!lstatSync(deferredPath).isFile()) return false;
    const deferred = read(deferredPath);
    if (deferred.head !== hold.sourceHead || deferred.validation !== 'unknown') return false;
    if (deferred.reason === PROCESS_INSPECTION_UNAVAILABLE) return true;
    if (CI_AUTHORITATIVE_UNKNOWN_REASONS.includes(deferred.reason)) {
      const evidence = read(join(hold.evidenceDir, 'validation.json'));
      return evidence.head === hold.sourceHead && Array.isArray(evidence.checks) && processInspectionRefused(evidence.checks);
    }
    // Older mirrors used the display name and surfaced the guard's exit 75
    // as an environment fault. Recover the typed result from the same attempt.
    if (deferred.reason !== 'canonical-mirror-environment-unavailable' || deferred.status !== 76) return false;
    const path = join(hold.evidenceDir, 'validation.json');
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    // Re-stat on every observation, but avoid parsing an unchanged legacy
    // receipt on every watcher pass. Identity and change time also fence an
    // atomic replacement or a rewrite that restores the original mtime.
    const fingerprint = [hold.sourceHead, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = legacyInspectionCache.get(path);
    if (cached?.fingerprint === fingerprint) return cached.unavailable;
    const evidence = read(path);
    const unavailable = evidence.head === hold.sourceHead && Array.isArray(evidence.checks)
      && evidence.checks.some(check => ['Telegram responder guard', 'telegram-responder-guard'].includes(check?.name)
        && check.status === 'failed' && check.result === 'inconclusive'
        && Array.isArray(check.diagnostics) && check.diagnostics.some(diagnostic => diagnostic?.exitStatus === 75)
        && typeof check.localReason === 'string'
        && check.localReason.split('; ').some(reason =>
          /^telegram guard lane (python|node): ps unusable in this sandbox: no verdict$/.test(reason)));
    // Bound process-lifetime memory independently of the number of old holds.
    if (legacyInspectionCache.size >= 256) legacyInspectionCache.delete(legacyInspectionCache.keys().next().value);
    legacyInspectionCache.set(path, { fingerprint, unavailable });
    return unavailable;
  } catch { return false; }
}

export function deferredSourceNeedsDecision(hold, inspectionUnavailable = deferredProcessInspectionUnavailable(hold)) {
  // continuedAt can describe retained source that was already published. It
  // says nothing about whether the next validator can perform the local guard.
  return Boolean(inspectionUnavailable || (hold && !hold.continuedAt && (hold.unreadable
    || deferredSourceStatus(hold) !== 'matches-target' || !deferredCleanupFinished(hold)
    || deferredTimeoutEvidence(hold) === false)));
}

// Undefined leaves legacy non-timeout recovery to the ordinary custody rule.
// False means a timeout was observed but its finalized evidence cannot release it.
function deferredTimeoutEvidence(hold) {
  let deferred;
  try { deferred = read(join(hold.evidenceDir, 'deferred.json')); }
  catch (error) { return error.code === 'ENOENT' && !hold.controller ? undefined : false; }
  if (deferred?.head !== hold.sourceHead || deferred.validation !== 'unknown'
    || typeof deferred.reason !== 'string') return false;
  if (!CI_AUTHORITATIVE_UNKNOWN_REASONS.includes(deferred.reason)) return undefined;
  try {
    const cleanup = deferredCleanupReceipt(hold);
    if (!deferredCleanupFinished(hold, cleanup) || (hold.controller && (cleanup.validationFinalized !== true
      || cleanup.controller !== hold.controller || deferred.controllerRecord !== hold.controller))) return false;
    const validation = read(join(hold.evidenceDir, 'validation.json'));
    if (validation.head !== hold.sourceHead
      || !Array.isArray(validation.checks) || validation.checks.some(check => !check || typeof check !== 'object')
      || deferred.localFailureObserved !== false || validation.checks.some(check => check.result === 'fail')
      || processInspectionRefused(validation.checks)) return false;
    return { deferred, checks: validation.checks };
  } catch { return false; }
}

// HAMCIAUTH-01: custody whose validated source IS the published PR head and
// whose retained UNKNOWN qualifies for CI authority (deferrable reason, no local
// failure in the retained receipt or checks, a clean committed head, declared
// contexts) needs no operator. Exact-head CI and the unchanged merge gates
// decide. Unpublished or dirty source, a denied process inspection and
// unreadable evidence still park.
export function deferredSourcePublishedCiAuthoritative(hold, { liveHead, requiredContexts } = {}) {
  if (!hold || hold.unreadable || !hold.evidenceDir || hold.clean !== true || !sha(liveHead)
    || hold.sourceHead !== liveHead.toLowerCase() || deferredProcessInspectionUnavailable(hold)) return false;
  const evidence = deferredTimeoutEvidence(hold);
  return Boolean(evidence && unknownDefersToCi({ reason: evidence.deferred.reason, requiredContexts,
    checks: evidence.checks, cleanCheckout: evidence.deferred.cleanCheckout === true }).ciAuthoritative);
}

export function deferredSourceNeedsOperator(hold, { liveHead, requiredContexts, retryPolicy } = {}) {
  return !(hold?.targetHead === liveHead && deferredSourceRetryAvailable(deferredSourceRedrive(hold), retryPolicy))
    && deferredSourceNeedsDecision(hold)
    && !(!hold?.continuedAt && deferredSourcePublishedCiAuthoritative(hold, { liveHead, requiredContexts }));
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
