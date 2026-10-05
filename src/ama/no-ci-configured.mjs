const CI_CONFIG_PATH = /^(?:\.github\/workflows\/|\.circleci\/|\.buildkite\/|Jenkinsfile(?:$|\.)|\.travis\.yml$|azure-pipelines\.ya?ml$|\.gitlab-ci\.yml$|vercel\.json$|netlify\.toml$)/;

/** Corroborates the operator's no-CI declaration; unknown, truncated, or failed responses never authorize closure. */
export async function verifyNoCiConfigured({ repo, base, head, get }) {
  const branch = await get(`repos/${repo}/branches/${encodeURIComponent(base)}`);
  if (typeof branch?.protected !== 'boolean' || typeof branch?.commit?.sha !== 'string' || !branch.commit.sha) throw new Error('branch state unavailable');
  for (const ref of new Set([branch.commit.sha, head])) {
    if (!ref) throw new Error('head unavailable');
    const tree = await get(`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new Error('CI tree unavailable');
    if (tree.tree.some((entry) => typeof entry?.path !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type))) throw new Error('CI entries unavailable');
    if (tree.tree.some((entry) => entry.type === 'blob' && CI_CONFIG_PATH.test(entry.path))) return null;
  }
  const suites = await get(`repos/${repo}/commits/${encodeURIComponent(head)}/check-suites?per_page=1`);
  const status = await get(`repos/${repo}/commits/${encodeURIComponent(head)}/status?per_page=1`);
  for (const [response, entries] of [[suites, suites?.check_suites], [status, status?.statuses]]) {
    if (!Number.isInteger(response?.total_count) || response.total_count < 0 || !Array.isArray(entries)) {
      throw new Error('CI activity unavailable');
    }
    if (response.total_count > 0 || entries.length > 0) return null;
  }
  const pages = await get(`repos/${repo}/rules/branches/${encodeURIComponent(base)}`, { paginate: true });
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    throw new Error('branch rule pages unavailable');
  }
  const rules = pages.flat();
  if (!Array.isArray(rules) || rules.some((rule) => !rule?.type)) throw new Error('branch rules unavailable');
  if (rules.some((rule) => rule.type === 'required_status_checks' || rule.type === 'workflows')) return null;
  if (branch.protected) {
    const protection = await get(`repos/${repo}/branches/${encodeURIComponent(base)}/protection`);
    if (!protection || typeof protection !== 'object' || Array.isArray(protection)) throw new Error('protection unavailable');
    if (protection.required_status_checks != null) return null;
    if (typeof protection.url !== 'string') throw new Error('protection state unavailable');
  }
  return { reason: 'no CI configured', repo, base, head, baseHead: branch.commit.sha, checkedAt: new Date().toISOString() };
}
