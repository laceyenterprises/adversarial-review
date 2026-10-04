/** Append-only OPSEV1-03 evidence. Receipt failure never changes merge authority. */
import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fchownSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

// Positive decision evidence only. Unknown outcomes, read failures and stale
// heads remain in the closure audit, never in the executed-refusal store.
export function isExecutedMergeRefusal(reason) {
  return [
    'permanent-merge-rejection', 'builder-token-merge-refused',
    'predicate-not-eligible', 'gate-not-eligible',
    'github-gate-red', 'github-gate-not-green', 'primary-change-reverted',
  ].includes(reason);
}

function trusted(path, uid, directory = false, sharedParent = false) {
  const info = lstatSync(path);
  if (info.uid !== uid || (info.mode & (sharedParent ? 0o002 : 0o022)) || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error(`Untrusted merge-action path: ${path}`);
  }
}

export function writeMergeActionReceipt({ hqRoot, repo, prNumber, headSha, producerClass = 'ama-daemon',
  merged, reason = null, executedAt = new Date().toISOString(), action = 'gh pr merge' }) {
  if (!hqRoot) throw new Error('Merge-action receipt requires HQ root');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1
    || !/^[a-f0-9]{40}$/.test(headSha) || typeof merged !== 'boolean' || (!merged && !isExecutedMergeRefusal(reason))
    || !['ama-daemon', 'closer-hammer'].includes(producerClass)
    || !['gh pr merge', 'api merge'].includes(action) || !Number.isFinite(Date.parse(executedAt))) {
    throw new Error('Invalid merge-action receipt');
  }
  const identity = userInfo();
  const owner = JSON.parse(readFileSync(join(hqRoot, '.hq', 'config.json'), 'utf8')).ownerUser;
  if (owner !== identity.username || lstatSync(hqRoot).uid !== identity.uid) {
    throw new Error('Merge-action writer must run as HQ ownerUser');
  }
  const directory = join(hqRoot, 'dispatch', 'audit', 'automation-merge-actions');
  for (const path of [join(hqRoot, 'dispatch'), join(hqRoot, 'dispatch', 'audit'), directory]) {
    try { mkdirSync(path, { mode: 0o750 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    trusted(path, identity.uid, true, path !== directory);
  }
  const record = { actor: producerClass === 'ama-daemon' ? 'AMA' : 'hammer', action, merged,
    reason, repo, prNumber, headSha, executedAt, producerClass, receiptProtocol: 'OPSEV1-03' };
  const temporary = join(directory, `.merge-action-${randomUUID()}`);
  const target = join(directory, `${repo.replace('/', '-')}-pr-${prNumber}-${headSha}-${randomUUID()}.json`);
  const fd = openSync(temporary, 'wx', 0o640);
  try {
    try {
      fchmodSync(fd, 0o640);
      fchownSync(fd, identity.uid, lstatSync(hqRoot).gid);
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, target);
    trusted(target, identity.uid);
    const dirFd = openSync(directory, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    unlinkSync(temporary);
  }
  return target;
}

const publicationFailures = new Map();

export function recordMergeActionBestEffort(args, logger = console) {
  try {
    const result = writeMergeActionReceipt(args);
    publicationFailures.delete(args.hqRoot);
    return result;
  } catch (error) {
    const failures = (publicationFailures.get(args.hqRoot) || 0) + 1;
    publicationFailures.set(args.hqRoot, failures);
    if (failures === 2) logger?.error?.(`[merge-action] ALERT: repeated receipt publication failure at ${args.hqRoot}: ${error.message}`);
    logger?.warn?.(`[merge-action] receipt unavailable for ${args.repo}#${args.prNumber}: ${error.message}`);
    return null;
  }
}
