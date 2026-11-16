// Config-only repository fence for autonomous merge decisions and writes.
export const MERGE_DISABLED_FOR_REPOSITORY = 'merge-disabled-for-repository';

export function normalizeDisabledRepositories(list) {
  if (!Array.isArray(list)) throw new TypeError('disabled_repositories requires a list');
  const seen = new Set();
  return list.map(item => {
    if (typeof item !== 'string' || item.trim() !== item || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item)) {
      throw new TypeError('disabled_repositories items must be owner/name strings');
    }
    const repo = item.toLowerCase();
    if (seen.has(repo)) throw new TypeError(`duplicate disabled_repositories entry: ${repo}`);
    seen.add(repo);
    return repo;
  });
}

export function isMergeDisabledForRepository(cfgOrList, repo) {
  const list = normalizeDisabledRepositories(Array.isArray(cfgOrList) ? cfgOrList : cfgOrList?.disabledRepositories ?? []);
  if (!list.length || typeof repo !== 'string' || repo.trim() !== repo) return false;
  const match = /^(?:https:\/\/github\.com\/|[A-Za-z0-9_.-]+\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(repo);
  if (!match) return false;
  const name = /^https:\/\//i.test(repo) ? match[1].replace(/\.git$/i, '') : match[1];
  return list.includes(name.toLowerCase());
}

export function applyRepositoryMergeOff(cfg, repo) {
  return isMergeDisabledForRepository(cfg, repo)
    ? { ...cfg, autonomousMergeExecutionEnabled: false, mergeDisabledForRepository: true }
    : cfg;
}
