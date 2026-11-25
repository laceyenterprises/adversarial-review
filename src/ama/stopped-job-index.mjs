import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

// Cache names only. Every proof must reopen and validate the current artifacts.
export function createStoppedJobIndex({ openDirectory = opendir, stat = lstat, maxEntries = 125_000,
  maxRecords = 256, maxKeys = 64 } = {}) {
  const cache = new Map();
  async function stamp(path) {
    try {
      const value = await stat(path, { bigint: true });
      if (!value.isDirectory()) throw new Error(`stopped-publication partition is not a directory: ${path}`);
      return [value.dev, value.ino, value.mtimeNs, value.ctimeNs].map(String).join(':');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function unchanged(stamps) {
    for (const [path, before] of stamps) if (await stamp(path) !== before) return false;
    return true;
  }
  return async function matchingPaths(dir, prefix) {
    const key = JSON.stringify([dir, prefix]);
    const hit = cache.get(key);
    if (hit && await unchanged(hit.stamps)) return hit;
    cache.delete(key);
    const archive = join(dir, 'stopped-archived');
    const partitions = [join(dir, 'stopped'), archive];
    const stamps = [], paths = [];
    let entries = 0, records = 0;
    for (const partition of partitions) {
      const before = await stamp(partition);
      stamps.push([partition, before]);
      if (before === null) continue;
      const directory = await openDirectory(partition);
      for await (const entry of directory) {
        if (++entries > maxEntries) throw new Error(`stopped-publication scan capped at ${maxEntries} entries: ${dir}`);
        if (partition === archive && entry.isDirectory()
          && /^\d{4}-(0[1-9]|1[0-2])$/.test(entry.name)) partitions.push(join(partition, entry.name));
        if (!entry.name.toLowerCase().startsWith(prefix) || !/^[\w.-]{1,128}\.json$/.test(entry.name)) continue;
        if (++records > maxRecords) throw new Error(`stopped-publication scan capped at ${maxRecords} matching records: ${dir}`);
        if (entry.isFile()) paths.push({ path: join(partition, entry.name), partition, jobId: entry.name.slice(0, -5) });
      }
    }
    if (!await unchanged(stamps)) throw new Error(`stopped-publication partitions changed during scan: ${dir}`);
    const result = { stamps, paths, partitions, unchanged: () => unchanged(stamps) };
    if (cache.size >= maxKeys) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  };
}

export const stoppedJobPaths = createStoppedJobIndex();
