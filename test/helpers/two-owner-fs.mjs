// A hermetic two-owner permission adapter (GHSTATEOWNER-01).
//
// The real files live in one temporary directory owned by the test user. This
// adapter models a second operating-system owner over that directory: each
// file it creates records the creating uid, and a 0600 file owned by another
// uid refuses reads and in-place opens with EACCES, as the kernel does. The
// directory itself is group-writable to both owners, so rename and unlink
// succeed for either, matching the deployed `data/api-cache` (0775).
// No chmod, chown, sudo or second account is involved.
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

function eacces(path, syscall = 'open') {
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${path}'`), {
    code: 'EACCES', errno: -13, syscall, path,
  });
}

function createTwoOwnerFs({ directoryPath, directoryOwnerUid }) {
  const owners = new Map([[directoryPath, directoryOwnerUid]]);

  function ownerOf(path) {
    return owners.get(path);
  }

  function setOwner(path, uid) {
    owners.set(path, uid);
  }

  function forUid(uid) {
    const deny = (path, syscall) => {
      const owner = owners.get(path);
      if (owner !== undefined && owner !== uid && existsSync(path)) throw eacces(path, syscall);
    };
    const statFor = (details, path) => ({
      uid: owners.get(path) ?? uid,
      mtimeMs: details.mtimeMs,
      isFile: () => details.isFile(),
      isDirectory: () => details.isDirectory(),
    });
    return {
      getuidImpl: () => uid,
      readFileImpl: async (path, encoding) => { deny(path, 'open'); return readFile(path, encoding); },
      readFileSyncImpl: (path, encoding) => { deny(path, 'open'); return readFileSync(path, encoding); },
      openImpl: async (path, flags, mode) => {
        deny(path, 'open');
        const handle = await open(path, flags, mode);
        owners.set(path, uid);
        return handle;
      },
      writeFileImpl: async (path, data, options) => {
        deny(path, 'open');
        await writeFile(path, data, options);
        owners.set(path, uid);
      },
      renameImpl: async (from, to) => {
        await rename(from, to);
        owners.set(to, owners.get(from) ?? uid);
        owners.delete(from);
      },
      rmImpl: async (path, options) => {
        await rm(path, options);
        for (const key of [...owners.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) owners.delete(key);
        }
      },
      mkdirImpl: async (path, options) => {
        const created = await mkdir(path, options);
        if (!owners.has(path)) owners.set(path, uid);
        return created;
      },
      storeStatImpl: async path => statFor(await stat(path), path),
      storeStatSyncImpl: path => statFor(statSync(path), path),
    };
  }

  return { forUid, ownerOf, setOwner };
}

export { createTwoOwnerFs };
