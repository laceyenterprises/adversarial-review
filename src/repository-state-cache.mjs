import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const caches = new Set();
const generations = new Map();

// Register disposable observations only. In-flight owners retain their own
// shared state lock; worker/session/lease IDs are stable and never invalidated.
export function repositoryObservationCache(cache) {
  caches.add(cache);
  return cache;
}

export function refreshRepositoryObservationCaches(rootDir) {
  let names;
  try { names = JSON.parse(readFileSync(join(rootDir, 'data', 'repository-names.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const current = JSON.stringify([...new Set(names.map(row => `${row.repository_id}:${row.current}`))].sort());
  const previous = generations.get(rootDir);
  // A cache's cleanup can itself enter a state owner. Publish the generation
  // first so nested refreshes cannot recursively invalidate that same cache.
  generations.set(rootDir, current);
  if (previous !== undefined && previous !== current) {
    for (const cache of caches) cache.clear();
  }
}
