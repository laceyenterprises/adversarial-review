import { isTransientGhError } from '../gh-cli.mjs';

const CI_CONFIG_PATH = /(?:^|\/)(?:\.github\/workflows\/|\.circleci\/|\.buildkite\/|Jenkinsfile(?:$|\.)|\.travis\.yml$|azure-pipelines\.ya?ml$|\.gitlab-ci\.yml$|vercel\.json$|netlify\.toml$|bitbucket-pipelines\.yml$|\.drone\.ya?ml$|\.?appveyor\.ya?ml$|cloudbuild\.ya?ml$|\.woodpecker(?:[.\/]|$)|\.semaphore\/|codemagic\.ya?ml$)/;

/** Corroborates the operator's no-CI declaration; unknown, truncated, or failed responses never authorize closure. */
async function readNoCiConfiguration({ repo, base, head, get }) {
  const branch = await get(`repos/${repo}/branches/${encodeURIComponent(base)}`);
  if (typeof branch?.protected !== 'boolean' || typeof branch?.commit?.sha !== 'string' || !branch.commit.sha) throw new Error('branch state unavailable');
  if (!head) throw new Error('head unavailable');
  // Once the base SHA is known, all remaining reads are independent. Settle
  // every request before returning so refusal leaves no detached probe work.
  const refs = [...new Set([branch.commit.sha, head])];
  const reads = await Promise.allSettled([
    ...refs.map((ref) => get(`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)),
    get(`repos/${repo}/commits/${encodeURIComponent(head)}/check-suites?per_page=1`),
    get(`repos/${repo}/commits/${encodeURIComponent(head)}/status?per_page=1`),
    get(`repos/${repo}/rules/branches/${encodeURIComponent(base)}`, { paginate: true }),
    ...(branch.protected ? [get(`repos/${repo}/branches/${encodeURIComponent(base)}/protection`)] : []),
  ]);
  const failures = reads.filter((read) => read.status === 'rejected');
  if (failures.length) {
    // A permanent refusal should not be hidden by an unrelated transient read.
    throw (failures.find((read) => !isTransientGhError(read.reason)) || failures[0]).reason;
  }
  const values = reads.map((read) => read.value);
  for (const tree of values.slice(0, refs.length)) {
    if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new Error('CI tree unavailable');
    if (tree.tree.some((entry) => typeof entry?.path !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type))) throw new Error('CI entries unavailable');
    if (tree.tree.some((entry) => entry.type === 'blob' && CI_CONFIG_PATH.test(entry.path))) return null;
  }
  const [suites, status, pages, protection] = values.slice(refs.length);
  for (const [response, entries] of [[suites, suites?.check_suites], [status, status?.statuses]]) {
    if (!Number.isInteger(response?.total_count) || response.total_count < 0 || !Array.isArray(entries)) {
      throw new Error('CI activity unavailable');
    }
    if (response.total_count > 0 || entries.length > 0) return null;
  }
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    throw new Error('branch rule pages unavailable');
  }
  const rules = pages.flat();
  if (!Array.isArray(rules) || rules.some((rule) => !rule?.type)) throw new Error('branch rules unavailable');
  if (rules.some((rule) => rule.type === 'required_status_checks' || rule.type === 'workflows')) return null;
  if (branch.protected) {
    if (!protection || typeof protection !== 'object' || Array.isArray(protection)) throw new Error('protection unavailable');
    if (protection.required_status_checks != null) return null;
    if (typeof protection.url !== 'string') throw new Error('protection state unavailable');
  }
  return { reason: 'no CI configured', repo, base, head, baseHead: branch.commit.sha, checkedAt: new Date().toISOString() };
}

/** Permanent read failures refuse the exception; only transport/rate-limit failures retry. */
export async function verifyNoCiConfigured({ logger = console, ...args }) {
  try {
    return await readNoCiConfiguration(args);
  } catch (err) {
    if (isTransientGhError(err)) throw err;
    logger?.warn?.(`[no-ci-configured] refusing no-CI proof for ${args.repo}: ${err?.stderr || err?.message || err}`);
    return null;
  }
}
