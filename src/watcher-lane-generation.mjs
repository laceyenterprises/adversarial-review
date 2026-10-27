import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// Content identity, captured by the loaded process. No Git, PID, timestamps or
// config knobs: restarting the same bytes must preserve unchanged backoff.
export function watcherBuildIdentity(rootDir) {
  const hash = createHash('sha256');
  const add = (relative, ancestors = new Set()) => {
    const path = join(rootDir, relative);
    const realPath = realpathSync(path);
    if (ancestors.has(realPath)) throw new Error(`build identity symlink cycle: ${relative}`);
    const parents = new Set([...ancestors, realPath]);
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      const info = entry.isSymbolicLink() ? statSync(join(rootDir, child)) : entry;
      if (info.isDirectory()) add(child, parents);
      else if (info.isFile()) hash.update(child).update('\0').update(readFileSync(join(rootDir, child))).update('\0');
    }
  };
  add('src');
  for (const dir of ['bin', 'domains', 'prompts']) {
    // Only absent optional roots are skipped. A broken link or unreadable child
    // must not silently produce an incomplete identity.
    try { lstatSync(join(rootDir, dir)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    add(dir);
  }
  for (const file of ['package.json', 'package-lock.json']) {
    hash.update(file).update('\0').update(readFileSync(join(rootDir, file))).update('\0');
  }
  return hash.digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function watcherConfigGeneration(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
