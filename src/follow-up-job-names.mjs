import { repositoryNames } from './repository-names.mjs';

export function sanitizeRepo(repo) {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

// Keep the trailing separator: PR 87 must never select PR 8776's records.
// Filenames narrow I/O only; readers still validate the parsed job identity.
export function followUpJobFilePrefix(repo, prNumber) {
  return `${sanitizeRepo(repo)}-pr-${Number(prNumber)}-`;
}

export function followUpJobFileFilter(filter = {}) {
  const prefixes = filter.repo && filter.prNumber != null
    ? repositoryNames(filter.rootDir, filter.repo).map(repo => followUpJobFilePrefix(repo, filter.prNumber))
    : null;
  return (name) => name.endsWith('.json') && (prefixes === null || prefixes.some(prefix => filter.caseInsensitiveRepo
    ? name.toLowerCase().startsWith(prefix.toLowerCase()) : name.startsWith(prefix)));
}
