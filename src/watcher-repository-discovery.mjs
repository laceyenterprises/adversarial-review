import { canonicalRepositoryName, ensureRepositoryIdentitySchema, observeRepositoryListing } from './repository-identity.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';

// Discovery owns its refresh clock; identity conflicts quarantine only their repo.
export function createRepositoryRefresher({ config, db, rootDir, additionalStateDir,
  recordApiCall, apiStatusFromResult, apiStatusFromError, deliverAlert,
  additionalOrgs = () => [], clientForOrg = () => null,
  now = Date.now, logger = console }) {
  let nextRefreshAt = 0;
  let hasSuccessfulListing = false;
  let startupFailures = 0;
  let emptySince = null;
  let emptyAlertSent = false;
  withSqliteBusyRetrySync(() => {
    ensureRepositoryIdentitySchema(db);
    // A restart must not restore a name rejected by the last identity observation.
    db.exec(`CREATE TABLE IF NOT EXISTS repository_discovery_quarantine (
      full_name TEXT PRIMARY KEY COLLATE NOCASE
    )`);
  }, { label: 'repository-discovery-schema-bootstrap', log: logger });
  const excluded = new Set((config.excludeRepos ?? []).map(name => name.toLowerCase()));
  const isExcluded = name => excluded.has(name.toLowerCase())
    || excluded.has(name.split('/').at(-1).toLowerCase());

  async function listOrg(octokit, org) {
    const params = { org, type: 'all', per_page: 100 };
    const repoLabel = `${org}/*`;
    const all = [];
    if (typeof octokit.paginate?.iterator === 'function') {
      for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForOrg, params)) {
        recordApiCall({ category: 'other', repo: repoLabel, status: apiStatusFromResult(response), durationMs: null });
        all.push(...(response?.data || []));
      }
    } else {
      const startedAt = Date.now();
      const repos = await octokit.paginate(octokit.rest.repos.listForOrg, params);
      recordApiCall({ category: 'other', repo: repoLabel, status: 200, durationMs: Date.now() - startedAt });
      for (const repo of repos) all.push(repo);
    }
    return all;
  }

  // Observes one org's listing; identity conflicts quarantine only their repository.
  async function observeListing(watched) {
    const observations = observeRepositoryListing({ db, rootDir,
      additionalStateDir, repositories: watched, logger });
    const conflicts = observations.filter(row => row.conflict);
    const quarantined = new Set(conflicts.map(row => row.fullName.toLowerCase()));
    try {
      db.transaction(() => {
        const remove = db.prepare('DELETE FROM repository_discovery_quarantine WHERE full_name=?');
        const insert = db.prepare('INSERT INTO repository_discovery_quarantine VALUES (?)');
        for (const observation of observations) {
          remove.run(observation.fullName);
          if (observation.conflict) insert.run(observation.fullName);
        }
      }).immediate();
    } catch (error) {
      logger.warn(`[watcher] Repository quarantine persistence failed; using in-memory conflicts for this listing: ${error.message}`);
    }
    for (const conflict of conflicts) {
      await deliverAlert(`Repository identity conflict: ${conflict.fullName}; intake quarantined for this repository. ${conflict.reason}`, {
        source: 'adversarial-repository-identity', severity: 'SEV2',
        dedupKey: `repository-identity-conflict:${conflict.repositoryId}:${conflict.fullName}`,
      }).catch(error => logger.warn(`[watcher] Repository conflict notice deferred: ${error.message}`));
    }
    return quarantined;
  }

  // Historical ambiguity also fences names before discovery persists a quarantine.
  const fencedNames = () => new Set(db.prepare(`SELECT full_name FROM repository_discovery_quarantine
    UNION SELECT full_name FROM repository_name_history
    GROUP BY full_name HAVING count(DISTINCT repository_id) > 1`).all()
    .map(row => row.full_name.toLowerCase()));
  const knownNames = org => db.prepare('SELECT full_name FROM repository_identities ORDER BY full_name').all()
    .map(row => row.full_name).filter(name => name.split('/')[0].toLowerCase() === org.toLowerCase());

  // Additional orgs are isolated: each lists with its own owner-scoped client and
  // keeps its own previous set, so one org's failure never shrinks another's.
  const orgSets = new Map(), orgClients = new Map(), unavailableLogged = new Set();
  function additionalClient(org) {
    if (orgClients.has(org)) return orgClients.get(org);
    let client = null, reason = 'no owner-scoped client';
    try { client = clientForOrg(org); } catch (error) { reason = error.message; }
    if (client) orgClients.set(org, client);
    else if (!unavailableLogged.has(org)) {
      unavailableLogged.add(org);
      logger.warn(`[watcher] Additional org ${org} skipped: owner-scoped GitHub client unavailable (${reason}).`);
    }
    return client;
  }
  async function refreshAdditionalOrg(org) {
    const previous = orgSets.get(org);
    const client = additionalClient(org);
    if (!client) return previous ?? [];
    let listingComplete = false;
    try {
      const all = await listOrg(client, org);
      listingComplete = true;
      const watched = all.map(r => ({ ...r, full_name: r.full_name || `${org}/${r.name}` }))
        .filter(r => !r.archived && !isExcluded(r.full_name));
      const quarantined = await observeListing(watched);
      const names = watched.map(r => r.full_name).filter(name => !quarantined.has(name.toLowerCase()));
      logger.log(`[watcher] Additional org ${org} refreshed — watching ${names.length} repos: ${names.join(', ')}`);
      unavailableLogged.delete(org);
      return names;
    } catch (err) {
      if (err.code === 'REPOSITORY_STATE_BUSY' && hasSuccessfulListing) throw err;
      if (err?.code === 'github-owner-token-unavailable') {
        if (!unavailableLogged.has(org)) {
          unavailableLogged.add(org);
          logger.warn(`[watcher] Additional org ${org} skipped: owner-scoped GitHub client unavailable (${err.message}).`);
        }
        return previous ?? [];
      }
      if (!listingComplete) {
        recordApiCall({ category: 'other', repo: `${org}/*`, status: apiStatusFromError(err), durationMs: null });
      }
      logger.error(`[watcher] Failed to ${listingComplete ? 'reconcile' : 'list'} additional org repos for ${org}:`, err.message);
      if (previous) return previous;
      const fenced = fencedNames();
      const candidates = knownNames(org);
      for (const name of candidates.filter(name => !isExcluded(name) && fenced.has(name.toLowerCase()))) {
        logger.warn(`[watcher] Startup fallback omitted candidate repository ${name}: persisted quarantine or ambiguous ownership history; an authoritative safe listing is required.`);
      }
      return candidates.filter(name => !isExcluded(name) && !fenced.has(name.toLowerCase()));
    }
  }
  async function withAdditionalOrgs(repos, due) {
    let configured = [...orgSets.keys()]; // an unreadable config keeps the known orgs rather than failing the default org
    let configRead = false;
    try { configured = additionalOrgs(); configRead = true; } catch (error) { logger.warn(`[watcher] Additional orgs unreadable; keeping known orgs: ${error.message}`); }
    const orgs = [...new Set(configured.map(org => org.toLowerCase()))].filter(org => org !== config.org.toLowerCase());
    if (!orgs.length && !orgSets.size) return repos;
    const contributed = new Set([...orgSets.values()].flat().map(name => name.toLowerCase()));
    if (configRead) for (const org of orgSets.keys()) if (!orgs.includes(org)) {
      orgSets.delete(org);
      orgClients.delete(org);
      unavailableLogged.delete(org);
    }
    const pinned = new Set((config.repos || []).map(name => canonicalRepositoryName(db, name).toLowerCase()));
    const merged = repos.filter(name => !contributed.has(name.toLowerCase()) || pinned.has(name.toLowerCase()));
    for (const org of orgs) if (due || !orgSets.has(org)) orgSets.set(org, await refreshAdditionalOrg(org));
    return [...new Set([...merged, ...orgs.flatMap(org => orgSets.get(org) ?? [])])];
  }

  async function refresh(octokit, currentRepos) {
    let activeRepos = currentRepos;
    if (!config.org) return [...new Set(activeRepos.map(name => canonicalRepositoryName(db, name)))]
      .filter(name => !isExcluded(name));

    const startedAt = now();
    const refreshInterval = config.repoRefreshIntervalMs ?? 3_600_000;
    if (startedAt < nextRefreshAt) return activeRepos;

    const repoLabel = config.org ? `${config.org}/*` : null;
    nextRefreshAt = startedAt + refreshInterval;
    let listingComplete = false;
    try {
      const all = await listOrg(octokit, config.org);

      listingComplete = true;
      const watched = all.map(r => ({ ...r, full_name: r.full_name || `${config.org}/${r.name}` }))
        .filter(r => !r.archived && !isExcluded(r.full_name));
      const quarantined = await observeListing(watched);
      const discoveredRepos = watched.map(r => r.full_name);
      activeRepos = [...new Set([...(config.repos || []).map(name => canonicalRepositoryName(db, name)), ...discoveredRepos])]
        .filter(name => !isExcluded(name) && !quarantined.has(name.toLowerCase()));

      hasSuccessfulListing = true;
      logger.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
    } catch (err) {
      if (err.code === 'REPOSITORY_STATE_BUSY' && hasSuccessfulListing) throw err;
      if (!listingComplete) {
        recordApiCall({
          category: 'other',
          repo: repoLabel,
          status: apiStatusFromError(err),
          durationMs: null,
        });
      }
      logger.error(`[watcher] Failed to ${listingComplete ? 'reconcile' : 'list'} org repos for ${config.org}:`, err.message);
      if (!hasSuccessfulListing) {
        // A complete listing is not yet an identity-safe scope: a busy rename
        // may leave observation/recovery unfinished. New repositories wait for
        // the first contention-free reconciliation rather than bypassing it.
        if (listingComplete && err.code === 'REPOSITORY_STATE_BUSY') {
          logger.warn('[watcher] Startup repository reconciliation blocked by repository-state lock contention; new repositories wait for a contention-free listing.');
        }
        const backoff = Math.min(refreshInterval, [120_000, 300_000, 600_000][Math.min(startupFailures++, 2)]);
        const deferredUntil = err.budgetDeferred ? Date.parse(err.observation?.resetAt) : NaN;
        nextRefreshAt = Math.min(startedAt + backoff, deferredUntil > startedAt ? deferredUntil : Infinity);
        // Historical ambiguity also fences names on the first deployment,
        // before discovery has had a chance to persist a quarantine.
        const quarantined = fencedNames();
        const known = knownNames(config.org);
        const candidates = [...new Set([...(config.repos || []).map(name => canonicalRepositoryName(db, name)), ...known])];
        for (const name of candidates.filter(name => !isExcluded(name) && quarantined.has(name.toLowerCase()))) {
          logger.warn(`[watcher] Startup fallback omitted candidate repository ${name}: persisted quarantine or ambiguous ownership history; an authoritative safe listing is required.`);
        }
        activeRepos = candidates.filter(name => !isExcluded(name) && !quarantined.has(name.toLowerCase()));
        logger.log(`[watcher] watching ${activeRepos.length} repos (fallback: last known set): ${activeRepos.join(', ')}`);
        logger.warn(`[watcher] Startup repository discovery degraded; retry at ${new Date(nextRefreshAt).toISOString()}`);
      }
      // After a success, failures still consume the full interval.
    }
    return activeRepos;
  }

  return async function refreshOrgRepos(octokit, currentRepos) {
    const due = now() >= nextRefreshAt;
    let activeRepos = await refresh(octokit, currentRepos);
    if (config.org) activeRepos = await withAdditionalOrgs(activeRepos, due);
    if (activeRepos.length) {
      emptySince = null;
      emptyAlertSent = false;
    } else {
      const at = now();
      emptySince ??= at;
      logger.warn('[watcher] Zero watched repositories; open PR discovery is inactive and review/closure coverage is degraded.');
      if (!emptyAlertSent && at - emptySince >= 120_000) {
        try {
          await deliverAlert('Watcher has watched zero repositories for at least two minutes; inspect repository discovery.', {
            event: 'adversarial-repository-discovery',
            payload: { org: config.org || null, watchedRepositories: 0, emptySince: new Date(emptySince).toISOString() },
          });
          emptyAlertSent = true;
        } catch (error) {
          logger.warn(`[watcher] Repository discovery alert deferred: ${error.message}`);
        }
      }
    }
    return activeRepos;
  };
}
