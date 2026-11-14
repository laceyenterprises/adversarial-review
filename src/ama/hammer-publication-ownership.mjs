import { proveRebaseResult } from './rebase-result.mjs';
import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readMergeLeaseHolders, inspectMergeLease } from './merge-lease.mjs';

export const publicationRoot = process.env.ADVERSARIAL_REVIEW_STATE_DIR
  ? dirname(process.env.ADVERSARIAL_REVIEW_STATE_DIR) : fileURLToPath(new URL('../../', import.meta.url));
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const key = ({ repo, prNumber }) => createHash('sha256').update(`${repo.toLowerCase()}#${Number(prNumber)}`).digest('hex');
export const hammerPublicationPath = (rootDir, identity) => join(rootDir, 'data', 'hammer-publication-ownership', `${key(identity)}.json`);
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function lock(rootDir, identity, mode) {
  const path = hammerPublicationPath(rootDir, identity);
  if (mode === 'sh' && !existsSync(`${path}.lock`)) return () => {};
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(`${path}.lock`, 'a', 0o640);
  try { fsExt.flockSync(fd, `${mode}nb`); }
  catch (error) { closeSync(fd); if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null; throw error; }
  return () => closeSync(fd);
}

// The exclusive barrier spans the remote mutation and its exact result. A
// watcher can never observe a server-generated SHA before its custody record.
// Intent is durable before publication; it confers no validation authority.
export async function withHammerPublication({ env = process.env, rootDir = env.ADVERSARIAL_REVIEW_STATE_DIR ? dirname(env.ADVERSARIAL_REVIEW_STATE_DIR) : env.HAM_ROOT_DIR || publicationRoot, repo, prNumber,
  headSha = null, previousHead = null, now = new Date().toISOString() }, publish) {
  const controller = read(env.HAM_CONTROLLER_RECORD);
  if (controller?.state !== 'running' || !Number.isInteger(controller.controllerPid) || controller.controllerPid <= 1
    || controller.controllerPid !== Number(env.HAM_CONTROLLER_PID)
    || controller.token !== env.HAM_CONTROLLER_TOKEN) throw new Error('hammer-publication-owner-unconfirmed');
  const identity = { repo, prNumber };
  const release = lock(rootDir, identity, 'ex');
  if (!release) throw new Error('hammer-publication-busy');
  try {
    const prior = read(hammerPublicationPath(rootDir, identity));
    const sameRun = prior?.controllerRecord === env.HAM_CONTROLLER_RECORD && prior?.startedAt === controller.startedAt;
    const record = { schemaVersion: 1, repo, prNumber: Number(prNumber), controllerRecord: env.HAM_CONTROLLER_RECORD,
      controllerPid: controller.controllerPid, startedAt: controller.startedAt, recordedAt: now,
      heads: [...new Set([...(sameRun ? prior.heads : []), ...(sha(headSha) ? [headSha] : [])])], publishing: true };
    const save = () => writeFileAtomic(hammerPublicationPath(rootDir, identity), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    save();
    let completed = false;
    try {
      const result = await publish();
      completed = true;
      // The fallback CAS input is not a head we published. Only an API result
      // different from its captured input proves a partially completed write.
      const partialHead = previousHead && result?.fallbackHead !== previousHead ? result?.fallbackHead : null;
      record.uncertain = result?.route === 're-review' && !result?.pushedHead && !sha(partialHead);
      for (const head of [result?.head, result?.pushedHead, partialHead]) {
        if (sha(head) && !record.heads.includes(head)) record.heads.push(head);
      }
      return result;
    } finally { record.publishing = false; if (!completed) record.uncertain = true; save(); }
  } finally { release(); }
}

export function activeHammerPublication({ rootDir = publicationRoot, repo, prNumber, headSha,
  now = Date.now(), isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } },
  inspectLeaseImpl = inspectMergeLease } = {}) {
  if (!repo || !prNumber || !sha(headSha)) return null;
  const identity = { repo, prNumber };
  const release = lock(rootDir, identity, 'sh');
  // Contention is a bounded probe deferral, not a claim that an arbitrary new
  // head belongs to HAM. Retry after the publishing critical section completes.
  if (!release) return { suppressed: true, reason: 'closer-publication-in-progress', headSha };
  try {
    const record = read(hammerPublicationPath(rootDir, identity));
    if (!record?.closed && record) {
      const controller = read(record.controllerRecord);
      if (controller?.state === 'running' && controller.controllerPid === record.controllerPid
        && controller.startedAt === record.startedAt && isAlive(record.controllerPid)
        && now - Date.parse(record.recordedAt) >= 0 && now - Date.parse(record.recordedAt) < 6 * 60 * 60 * 1000) {
        if (record.uncertain || record.publishing) return { suppressed: true, reason: 'closer-publication-unconfirmed', headSha };
        if (record.heads?.includes(headSha)) return { suppressed: true, reason: 'active-closer-published-head', headSha };
      }
    }
    for (const lease of readMergeLeaseHolders({ rootDir, repo, prNumber })) {
      if (lease.holderHead !== headSha || lease.holderRole === 'daemon') continue;
      const state = inspectLeaseImpl({ rootDir, repo, base: lease.base, now: new Date(now).toISOString() });
      if (state.holder?.leaseId === lease.leaseId && !state.pastDeadline && state.holderLiveness !== 'dead') {
        return { suppressed: true, reason: 'active-closer-merge-lease', headSha };
      }
    }
    return null;
  } finally { release(); }
}

// Confirmed merge closes custody immediately, even before controller drain.
export function retireHammerPublication(rootDir, identity) {
  const record = read(hammerPublicationPath(rootDir, identity));
  if (!record) return;
  const release = lock(rootDir, identity, 'ex');
  if (!release) throw new Error('hammer-publication-busy');
  try {
    const current = read(hammerPublicationPath(rootDir, identity));
    if (current) writeFileAtomic(hammerPublicationPath(rootDir, identity),
      `${JSON.stringify({ ...current, closed: true, heads: [] })}\n`, { mode: 0o600 });
  } finally { release(); }
}

// Some accepted rebases acknowledge the old head. Keep the publication barrier
// until the existing full-tree replay proof binds the eventually visible SHA.
export async function settleHammerRebasePublication({ result, oldHead, base, readHead, fetchHead, git,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 3, proveImpl = proveRebaseResult }) {
  const payload = result?.data?.updatePullRequestBranch?.pullRequest;
  if (!sha(payload?.headRefOid)) throw new Error('hammer-publication-result-unavailable');
  if (payload.headRefOid !== oldHead) return payload.headRefOid;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = await readHead();
    if (!sha(head)) throw new Error('hammer-publication-result-unavailable');
    if (head !== oldHead) {
      await fetchHead(head);
      if (!await proveImpl({ oldHead, head, base, git })) throw new Error('rebase-result-unproven');
      payload.headRefOid = head;
      return head;
    }
    try { await git(['merge-base', '--is-ancestor', base, oldHead]); return oldHead; }
    catch { /* The captured base is not yet contained: await mutation visibility. */ }
    if (attempt + 1 < attempts) await sleep(5000 * 2 ** attempt);
  }
  throw new Error('hammer-publication-result-unavailable');
}
