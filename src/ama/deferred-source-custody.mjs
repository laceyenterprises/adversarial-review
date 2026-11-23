import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

const sha = value => /^[a-f0-9]{40}$/.test(value || '');
export const DEFERRED_SOURCE_HOLD = 'canonical-validation-operator-decision';

function directory(hqRoot, { repo, prNumber, headSha }) {
  if (!hqRoot || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo || '')
    || repo.split('/').some(part => part === '.' || part === '..')
    || !/^[1-9]\d*$/.test(String(prNumber)) || !sha(headSha)) return null;
  return join(hqRoot, 'dispatch', 'audit', 'deferred-source-custody',
    repo.toLowerCase(), `pr-${prNumber}`, headSha);
}

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readDeferredSourceHold(hqRoot, identity) {
  const dir = directory(hqRoot, identity);
  if (!dir) return null;
  const path = join(dir, 'hold.json');
  try {
    if (!lstatSync(path).isFile()) throw new Error('invalid hold file');
    const record = read(path);
    if (record.schemaVersion !== 1 || record.targetHead !== identity.headSha
      || record.repo !== identity.repo.toLowerCase() || record.prNumber !== Number(identity.prNumber)
      || !sha(record.sourceHead) || !/^attempt-[a-zA-Z0-9]+$/.test(record.attempt || '')) throw new Error('invalid hold');
    return { ...record, path, evidenceDir: join(dir, record.attempt) };
  } catch (error) {
    return error.code === 'ENOENT' ? null : { path, unreadable: true };
  }
}

export function deferredSourceIdentity(env) {
  return { repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER,
    headSha: env.HAM_CLOSE_VALIDATION_REMOTE_HEAD || env.HAM_TARGET_REMEDIATION_SHA };
}

export function findDeferredSourceHold(env) {
  const identity = deferredSourceIdentity(env);
  return readDeferredSourceHold(env.HAM_HQ_ROOT, identity)
    || readDeferredSourceHold(env.HAM_HQ_ROOT, { ...identity, headSha: env.HAM_TARGET_REMEDIATION_SHA });
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
    targetHead: identity.headSha, dispatchHead: env.HAM_TARGET_REMEDIATION_SHA, sourceHead,
    launchRequestId, runId: env.HQ_WORKER_RUN_ID, attempt: basename(evidenceDir), controller,
    validationBase, clean, files, runner, workspace: process.cwd(), at: new Date().toISOString() };
  try { writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, overwrite: false }); }
  catch (error) { rmSync(evidenceDir, { recursive: true, force: true }); throw error; }
  return evidenceDir;
}

export function retainDeferredCommit(hold, env) {
  const { evidenceDir, sourceHead, targetHead, launchRequestId, validationBase } = hold;
  // The hold fences successors and workspace reclamation while the cleanup
  // owner drains the validation group. Pack only after the stop is underway.
  const git = (...args) => execFileSync('git', args, { cwd: hold.workspace, env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  const ref = `refs/hammer/deferred/${launchRequestId}/${sourceHead}`;
  let source = { status: 'matches-target' };
  if (sourceHead !== targetHead) {
    try {
      git('update-ref', ref, sourceHead);
      source = { status: 'local-ref-only', ref };
      const prerequisites = [...new Set([targetHead, ...(sha(validationBase) ? [validationBase] : [])])];
      const bundle = join(evidenceDir, 'source.bundle');
      git('bundle', 'create', bundle, ref, ...prerequisites.map(head => `^${head}`));
      const advertised = git('bundle', 'list-heads', bundle, ref);
      if (advertised !== `${sourceHead} ${ref}`) throw new Error('bundle head mismatch');
      source = { status: 'bundled', ref, prerequisites, bundle: basename(bundle) };
    } catch {
      if (!source.ref) source = { status: 'workspace-only' };
    }
  }
  writeFileAtomic(join(evidenceDir, 'source.json'), JSON.stringify(source), { mode: 0o600 });
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

export function retainDeferredControllerCleanup(env, recordPath, record) {
  // The validator receives the verify-head snapshot in its own environment.
  // Find its hold through either the dispatch head or the live head it passed
  // back to the owning controller via the run-local pointer.
  try {
    const { headSha } = read(join(env.HAM_RUN_DIR, `deferred-controller-${basename(recordPath)}`));
    const hold = readDeferredSourceHold(env.HAM_HQ_ROOT, { ...deferredSourceIdentity(env), headSha });
    if (hold?.launchRequestId !== record.launchRequestId || hold.controller !== basename(recordPath)) return;
    writeFileAtomic(join(hold.evidenceDir, 'controller-cleanup.json'), JSON.stringify(record), { mode: 0o600 });
    retainDeferredCommit(hold, env);
  } catch { /* A missing final receipt leaves cleanup unconfirmed. */ }
}

export function deferredSourceStatus(hold) {
  try {
    const source = read(join(hold.evidenceDir, 'source.json'));
    if (source.status === 'bundled') {
      if (source.bundle !== 'source.bundle' || !lstatSync(join(hold.evidenceDir, source.bundle)).isFile()) return 'unconfirmed';
      return source.status;
    }
    if (['matches-target', 'local-ref-only', 'workspace-only'].includes(source.status)) return source.status;
    return 'unconfirmed';
  }
  catch { return 'unconfirmed'; }
}

export function deferredSourceNotice(hold) {
  let cleanup;
  if (hold.evidenceDir) {
    try { cleanup = read(join(hold.evidenceDir, 'controller-cleanup.json')); } catch {
      try { cleanup = read(join(hold.evidenceDir, 'bounded-cleanup.json')); } catch { /* Unconfirmed cleanup. */ }
    }
  }
  const finished = cleanup && cleanup.launchRequestId === hold.launchRequestId && (hold.controller
    ? cleanup.state === 'quiescent' && cleanup.drained === true
      && (cleanup.leaseCleanup?.released === true
        || ['already-released', 'no-acquisition-receipt'].includes(cleanup.leaseCleanup?.reason))
    : cleanup.head === hold.sourceHead && cleanup.cleanup === 'finished');
  return `Operator decision required for ${hold.sourceHead || 'unknown source'} (launch ${hold.launchRequestId || 'unknown'}, `
    + `source ${deferredSourceStatus(hold)}, cleanup ${finished ? 'recorded finished' : 'unconfirmed'}). `
    + (hold.evidenceDir || hold.path ? `Evidence: ${hold.evidenceDir || hold.path}. ` : 'The launch left no readable custody package. ')
    + 'Confirm cleanup and recover this exact source for the outstanding local guards and normal publication gates, '
    + 'or explicitly discard the retained attempt after inspecting it. The watcher will hold this head.';
}
