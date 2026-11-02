// PRAGE-01: read-only GitHub boundary. Import the review service's holds and
// metered execution seam, so this observer shares its policy and API budget.
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function collect(codeRoot, dataRoot, { run, holdLabels, config } = {}) {
  // dataRoot is retained for the Python caller's two-root CLI contract.
  // This boundary reads only code-owned modules and configuration.
  if (!run) {
    const meteredPath = join(codeRoot, 'src/metered-gh.mjs');
    if (!existsSync(meteredPath)) {
      throw new Error(`review service code root ${codeRoot} has no src/metered-gh.mjs`);
    }
    const { meteredExecFile } = await import(pathToFileURL(meteredPath));
    run = async (args) => {
      const result = await meteredExecFile(undefined, 'gh', args, {
        timeout: loadAwareTimeoutMs(60_000, { maxMs: 360_000 }), maxBuffer: 25 * 1024 * 1024, env: process.env,
      });
      return JSON.parse(result.stdout);
    };
  }
  if (holdLabels == null) {
    const holdLabelsPath = join(codeRoot, 'src/operator-hold-labels.mjs');
    if (!existsSync(holdLabelsPath)) {
      throw new Error(`review service code root ${codeRoot} has no src/operator-hold-labels.mjs`);
    }
    holdLabels = (await import(pathToFileURL(holdLabelsPath))).OPERATOR_HOLD_LABELS;
  }
  config ??= JSON.parse(await readFile(join(codeRoot, 'config.json'), 'utf8'));
  const repos = new Set(config.repos ?? []);
  const errors = [];
  if (config.org) {
    try {
      const pages = await run(['api', `orgs/${config.org}/repos?type=all&per_page=100`, '--paginate', '--slurp']);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('invalid repository list');
      const excluded = new Set(config.excludeRepos ?? []);
      for (const repo of pages.flat()) {
        if (repo?.full_name && !repo.archived && !excluded.has(repo.name) && !excluded.has(repo.full_name)) repos.add(repo.full_name);
      }
    } catch (error) { errors.push({ repo: config.org, error: `repository discovery: ${error.message}` }); }
  }
  if (!repos.size && !errors.length) throw new Error('review service watches no repositories');
  const repositories = {};
  for (const repo of repos) {
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('invalid repository slug');
      const prs = await run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '10000',
        '--json', 'number,title,url,createdAt,isDraft,labels,statusCheckRollup,headRefOid']);
      if (!Array.isArray(prs) || prs.length >= 10000) throw new Error('invalid or truncated PR list');
      repositories[repo] = prs;
    } catch (error) { errors.push({ repo, error: error.message }); }
  }
  return { holdLabels, repositories, errors };
}
