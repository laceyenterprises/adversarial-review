import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

import {
  DEFAULT_BASE_BRANCH,
  fetchAdversarialGateBranchProtection,
  formatBranchProtectionWarning,
  resolveBaseBranchForRepo,
} from './branch-protection.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const USAGE = `\
Usage:
  node src/check-branch-protection.mjs [--repo <owner/repo>] [--base <branch>] [--config <path>]

Checks whether watched repositories require agent-os/adversarial-gate in branch protection.
`;

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

async function listOrgRepos(org, { execFileImpl = execFileAsync, env = process.env } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to list org repos');
  const { stdout } = await execFileImpl(
    'gh',
    ['api', `orgs/${org}/repos`, '--paginate', '--jq', '.[].full_name'],
    {
      env: {
        PATH: env.PATH ?? '/usr/bin:/bin',
        HOME: env.HOME ?? '',
        GH_TOKEN: token,
      },
      maxBuffer: 5 * 1024 * 1024,
    }
  );
  return String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

async function resolveRepos({ repo, config, execFileImpl, env }) {
  if (repo) return [repo];
  if (Array.isArray(config.repos) && config.repos.length > 0) return config.repos;
  if (config.org) {
    const excluded = new Set(config.excludeRepos || []);
    return (await listOrgRepos(config.org, { execFileImpl, env }))
      .filter((repoPath) => {
        const repoName = repoPath.split('/')[1];
        return !excluded.has(repoName) && !excluded.has(repoPath);
      });
  }
  return [];
}

async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const parsed = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const configPath = parsed.values.config
    ? resolve(parsed.values.config)
    : resolve(ROOT, 'config.json');
  const config = readConfig(configPath);
  const repos = await resolveRepos({
    repo: parsed.values.repo,
    config,
    execFileImpl,
    env,
  });
  if (repos.length === 0) {
    stderr.write('error: no repositories configured\n');
    return 2;
  }

  const baseBranches = config.adversarialGateBaseBranches || {};
  const defaultBaseBranch = parsed.values.base || config.adversarialGateBaseBranch || DEFAULT_BASE_BRANCH;
  let failures = 0;
  for (const repoPath of repos) {
    const baseBranch = parsed.values.base || resolveBaseBranchForRepo(repoPath, {
      baseBranches,
      defaultBaseBranch,
    });
    const result = await fetchAdversarialGateBranchProtection({
      repoPath,
      baseBranch,
      execFileImpl,
      env,
    });
    if (result.ok) {
      stdout.write(`[branch-protection] ok repo=${repoPath} base=${baseBranch} context=${result.context}\n`);
    } else {
      failures += 1;
      stderr.write(`${formatBranchProtectionWarning(result)}\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`error: ${err?.message || err}`);
    process.exitCode = 4;
  });
}

export { main };
