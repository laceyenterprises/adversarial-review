import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Content identity, captured by the loaded process. No Git, PID, timestamps or
// config knobs: restarting the same bytes must preserve unchanged backoff.
export function watcherBuildIdentity(rootDir) {
  const hash = createHash('sha256');
  const add = relative => {
    const path = join(rootDir, relative);
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) add(child);
      else if (entry.isFile()) hash.update(child).update('\0').update(readFileSync(join(rootDir, child))).update('\0');
    }
  };
  for (const dir of ['src', 'bin', 'domains', 'prompts']) add(dir);
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

const SOURCE_ROOT = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
export const WATCHER_BUILD_IDENTITY = watcherBuildIdentity(SOURCE_ROOT);
