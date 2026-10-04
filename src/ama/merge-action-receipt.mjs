/** Append-only OPSEV1-03 evidence. Receipt failure never changes merge authority. */
import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fchownSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

function trusted(path, uid, directory = false) {
  const info = lstatSync(path);
  if (info.uid !== uid || (info.mode & 0o022) || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error(`Untrusted merge-action path: ${path}`);
  }
}

export function writeMergeActionReceipt({ hqRoot, repo, prNumber, headSha, producerClass = 'ama-daemon',
  merged, reason = null, executedAt = new Date().toISOString(), action = 'gh pr merge' }) {
  if (!hqRoot) throw new Error('Merge-action receipt requires HQ root');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1
    || !/^[a-f0-9]{40}$/.test(headSha) || typeof merged !== 'boolean' || (!merged && !reason)
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
    trusted(path, identity.uid, true);
  }
  const record = { actor: producerClass === 'ama-daemon' ? 'AMA' : 'hammer', action, merged,
    reason, repo, prNumber, headSha, executedAt, producerClass, receiptProtocol: 'OPSEV1-03' };
  const temporary = join(directory, `.merge-action-${randomUUID()}`);
  const target = join(directory, `${repo.replace('/', '-')}-pr-${prNumber}-${headSha}-${randomUUID()}.json`);
  const fd = openSync(temporary, 'wx', 0o640);
  try {
    fchmodSync(fd, 0o640);
    fchownSync(fd, identity.uid, lstatSync(hqRoot).gid);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    linkSync(temporary, target);
    trusted(target, identity.uid);
    const dirFd = openSync(directory, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    unlinkSync(temporary);
  }
  return target;
}

export function recordMergeActionBestEffort(args, logger = console) {
  try { return writeMergeActionReceipt(args); } catch (error) {
    logger?.warn?.(`[merge-action] receipt unavailable for ${args.repo}#${args.prNumber}: ${error.message}`);
    return null;
  }
}
