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

function uniqueTmpPath(filePath) {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

function makeExistsError(filePath) {
  const err = new Error(`EEXIST: file already exists, open '${filePath}'`);
  err.code = 'EEXIST';
  err.path = filePath;
  return err;
}

function writeFileAtomic(filePath, content, { overwrite = true } = {}) {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true });

  const tmpPath = uniqueTmpPath(filePath);
  let tmpFd = null;

  try {
    tmpFd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(tmpFd, content, 'utf8');
    fsyncSync(tmpFd);
    closeSync(tmpFd);
    tmpFd = null;

    if (overwrite) {
      renameSync(tmpPath, filePath);
      return;
    }

    try {
      linkSync(tmpPath, filePath);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        throw makeExistsError(filePath);
      }
      throw err;
    } finally {
      rmSync(tmpPath, { force: true });
    }
  } catch (err) {
    if (tmpFd !== null) {
      try {
        closeSync(tmpFd);
      } catch {}
    }
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export { writeFileAtomic };
