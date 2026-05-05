import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function fsyncDir(dirPath) {
  let dirFd;
  try {
    dirFd = openSync(dirPath, 'r');
    fsyncSync(dirFd);
  } catch {
    // Best-effort directory fsync. Some filesystems and platforms refuse it.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {}
    }
  }
}

function writeTempFileAtomic(targetPath, content, {
  mode = 0o640,
} = {}) {
  const dirPath = dirname(targetPath);
  mkdirSync(dirPath, { recursive: true });
  const tempPath = join(dirPath, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFd;
  try {
    tempFd = openSync(tempPath, 'wx', mode);
    writeFileSync(tempFd, content, 'utf8');
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    return tempPath;
  } catch (err) {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch {}
    }
    rmSync(tempPath, { force: true });
    throw err;
  }
}

function writeFileAtomic(targetPath, content, options = {}) {
  const tempPath = writeTempFileAtomic(targetPath, content, options);
  try {
    renameSync(tempPath, targetPath);
    fsyncDir(dirname(targetPath));
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

function writeFileAtomicExclusive(targetPath, content, options = {}) {
  const tempPath = writeTempFileAtomic(targetPath, content, options);
  try {
    linkSync(tempPath, targetPath);
    fsyncDir(dirname(targetPath));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export {
  writeFileAtomic,
  writeFileAtomicExclusive,
};
