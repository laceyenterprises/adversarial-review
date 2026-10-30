import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// This projection is published before the migration fence is removed.
// Cache by file identity as well as timestamps/size: publication is atomic and
// even an equal-sized replacement must invalidate long-lived workers.
const cache = new Map();
function readNames(rootDir) {
  const path = join(resolve(rootDir), 'data', 'repository-names.json');
  try {
    const stat = statSync(path, { bigint: true });
    const key = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    if (cache.get(path)?.key === key) return cache.get(path).names;
    const names = JSON.parse(readFileSync(path, 'utf8'));
    cache.set(path, { key, names });
    return names;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cache.delete(path);
    return [];
  }
}

function resolveNames(rootDir, repo) {
  const names = rootDir ? readNames(rootDir) : [];
  // A current name belongs to its current ID, even when another ID used that
  // name historically. Never send a newly created repository to the old owner.
  const current = names.filter(row => row.current.toLowerCase() === repo.toLowerCase());
  const matches = current.length ? current : names.filter(row => row.name.toLowerCase() === repo.toLowerCase());
  const ids = new Set(matches.map(row => row.repository_id));
  if (ids.size > 1) throw new Error(`Ambiguous reused repository name: ${repo}`);
  if (!matches.length) return { aliases: [repo], current: repo };
  const id = matches[0].repository_id;
  return { aliases: [...new Set([repo, ...names.filter(row => row.repository_id === id).map(row => row.name)])],
    current: matches[0].current };
}

export function repositoryNames(rootDir, repo) {
  return resolveNames(rootDir, repo).aliases;
}
export function resolveRepositoryName(rootDir, repo) {
  return resolveNames(rootDir, repo).current;
}

export function canonicalRepositoryArguments(rootDir, args) {
  if (!args || !args.repo) return args;
  return { ...args, repo: resolveRepositoryName(rootDir, args.repo) };
}
