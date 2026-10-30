import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This projection is published before the migration fence is removed. Do not
// cache it: long-lived workers can retain arguments from before a rename.
export function repositoryNames(rootDir, repo) {
  if (!rootDir) return [repo];
  let names;
  try { names = JSON.parse(readFileSync(join(rootDir, 'data', 'repository-names.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return [repo]; throw error; }
  // A current name belongs to its current ID, even when another ID used that
  // name historically. Never send a newly created repository to the old owner.
  const current = names.filter(row => row.current.toLowerCase() === repo.toLowerCase());
  const matches = current.length ? current : names.filter(row => row.name.toLowerCase() === repo.toLowerCase());
  const ids = new Set(matches.map(row => row.repository_id));
  if (ids.size > 1) throw new Error(`Ambiguous reused repository name: ${repo}`);
  if (!matches.length) return [repo];
  const id = matches[0].repository_id;
  return [...new Set([repo, ...names.filter(row => row.repository_id === id).map(row => row.name)])];
}

export function resolveRepositoryName(rootDir, repo) {
  repositoryNames(rootDir, repo);
  if (!rootDir) return repo;
  let names;
  try { names = JSON.parse(readFileSync(join(rootDir, 'data', 'repository-names.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return repo; throw error; }
  return names.find(row => row.current.toLowerCase() === repo.toLowerCase())?.current
    || names.find(row => row.name.toLowerCase() === repo.toLowerCase())?.current || repo;
}

export function canonicalRepositoryArguments(rootDir, args) {
  if (!args || !args.repo) return args;
  return { ...args, repo: resolveRepositoryName(rootDir, args.repo) };
}
