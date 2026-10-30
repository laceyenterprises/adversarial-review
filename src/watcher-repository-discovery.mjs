import { canonicalRepositoryName, observeRepositoryListing } from './repository-identity.mjs';

// Discovery owns its refresh clock; identity conflicts quarantine only their repo.
export function createRepositoryRefresher({ config, db, rootDir, additionalStateDir,
  recordApiCall, apiStatusFromResult, apiStatusFromError, deliverAlert }) {
  let lastRepoRefresh = 0;
  return async function refreshOrgRepos(octokit, currentRepos) {
    let activeRepos = currentRepos;
    if (!config.org) return activeRepos;
  
    const now = Date.now();
    const refreshInterval = config.repoRefreshIntervalMs ?? 3_600_000;
    if (now - lastRepoRefresh < refreshInterval) return activeRepos;
  
    const repoLabel = config.org ? `${config.org}/*` : null;
    const params = {
      org: config.org,
      type: 'all',
      per_page: 100,
    };
  
    lastRepoRefresh = now;
    try {
      const all = [];
      if (typeof octokit.paginate?.iterator === 'function') {
        for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForOrg, params)) {
          recordApiCall({
            category: 'other',
            repo: repoLabel,
            status: apiStatusFromResult(response),
            durationMs: null,
          });
          all.push(...(response?.data || []));
        }
      } else {
        const startedAt = Date.now();
        const repos = await octokit.paginate(octokit.rest.repos.listForOrg, params);
        recordApiCall({
          category: 'other',
          repo: repoLabel,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        for (const repo of repos) all.push(repo);
      }
  
      const excluded = new Set(config.excludeRepos ?? []);
      const watched = all.filter(r => !r.archived && !excluded.has(r.name) && !excluded.has(r.full_name || `${config.org}/${r.name}`))
        .map(r => ({ ...r, full_name: r.full_name || `${config.org}/${r.name}` }));
      const observations = observeRepositoryListing({ db, rootDir,
        additionalStateDir, repositories: watched, logger: console });
      const conflicts = observations.filter(row => row.conflict);
      const quarantined = new Set(conflicts.map(row => row.fullName.toLowerCase()));
      for (const conflict of conflicts) {
        await deliverAlert(`Repository identity conflict: ${conflict.fullName}; intake quarantined for this repository. ${conflict.reason}`, {
          source: 'adversarial-repository-identity', severity: 'SEV2',
          dedupKey: `repository-identity-conflict:${conflict.repositoryId}:${conflict.fullName}`,
        }).catch(error => console.warn(`[watcher] Repository conflict notice deferred: ${error.message}`));
      }
      const discoveredRepos = watched.map(r => r.full_name);
      activeRepos = [...new Set([...(config.repos || []).map(name => canonicalRepositoryName(db, name)), ...discoveredRepos])]
        .filter(name => !quarantined.has(name.toLowerCase()));
  
      console.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
    } catch (err) {
      if (err.code === 'REPOSITORY_STATE_BUSY') throw err;
      recordApiCall({
        category: 'other',
        repo: repoLabel,
        status: apiStatusFromError(err),
        durationMs: null,
      });
      console.error(`[watcher] Failed to list org repos for ${config.org}:`, err.message);
    } finally {
      // Respect the refresh interval after failures too; retrying every poll tick
      // amplifies outages and rate limiting into a tight API loop.
      lastRepoRefresh = now;
    }
    return activeRepos;
  };
}
