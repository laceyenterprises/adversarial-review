import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function assertCanonicalOwner(rootDir, targetPath, {
  targetDir = dirname(targetPath),
  currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
  exists = existsSync,
  stat = statSync,
  cannotVerifyMessage = 'cannot verify durable state caller ownership',
  crossUserMessage = 'refusing cross-user durable state write',
  existingFileMessage = 'refusing write to non-canonical-owned durable state file',
} = {}) {
  const callerUid = currentUid();
  if (!Number.isInteger(callerUid)) {
    throw new Error(cannotVerifyMessage);
  }

  const anchor = exists(targetDir)
    ? targetDir
    : (exists(join(rootDir, 'data')) ? join(rootDir, 'data') : rootDir);
  const ownerUid = stat(anchor).uid;
  if (callerUid !== ownerUid) {
    throw new Error(
      `${crossUserMessage}: caller uid ${callerUid}, canonical owner uid ${ownerUid}`,
    );
  }

  if (exists(targetPath)) {
    const fileUid = stat(targetPath).uid;
    if (fileUid !== ownerUid) {
      throw new Error(
        `${existingFileMessage}: file uid ${fileUid}, canonical owner uid ${ownerUid}`,
      );
    }
  }
}

function assertCanonicalAppendOwner(rootDir, targetDir, filePath, options = {}) {
  assertCanonicalOwner(rootDir, filePath, {
    ...options,
    targetDir,
    cannotVerifyMessage: options.cannotVerifyMessage ?? 'cannot verify append-only store caller ownership',
    crossUserMessage: options.crossUserMessage ?? 'refusing cross-user append-only store write',
    existingFileMessage: options.existingFileMessage ?? 'refusing append to non-canonical-owned store file',
  });
}

export { assertCanonicalAppendOwner, assertCanonicalOwner };
