import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function assertCanonicalAppendOwner(rootDir, targetDir, filePath, {
  currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
  exists = existsSync,
  stat = statSync,
} = {}) {
  const callerUid = currentUid();
  if (!Number.isInteger(callerUid)) {
    throw new Error('cannot verify append-only store caller ownership');
  }

  const anchor = exists(targetDir)
    ? targetDir
    : (exists(join(rootDir, 'data')) ? join(rootDir, 'data') : rootDir);
  const ownerUid = stat(anchor).uid;
  if (callerUid !== ownerUid) {
    throw new Error(
      `refusing cross-user append-only store write: caller uid ${callerUid}, canonical owner uid ${ownerUid}`,
    );
  }

  if (exists(filePath)) {
    const fileUid = stat(filePath).uid;
    if (fileUid !== ownerUid) {
      throw new Error(
        `refusing append to non-canonical-owned store file: file uid ${fileUid}, canonical owner uid ${ownerUid}`,
      );
    }
  }
}

export { assertCanonicalAppendOwner };
