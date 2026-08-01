import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

import {
  DEFAULT_BASE_BRANCH,
  branchProtectionAuditDirPath,
  deleteBranchProtectionAuditRecord,
  ensureAdversarialGateRequiredContext,
  fetchAdversarialGateBranchProtection,
  formatBranchProtectionWarning,
  resolveBaseBranchForRepo,
  summarizeBranchProtectionResults,
  writeBranchProtectionAuditRecord,
} from './branch-protection.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const USAGE = `\
Usage:
  node src/check-branch-protection.mjs [--repo <owner/repo>] [--base <branch>] [--config <path>] [--json] [--apply]

Checks whether watched repositories require the adversarial-review gate status
context in branch protection. Defaults to "agent-os/adversarial-gate"; override
with the ADV_GATE_STATUS_CONTEXT environment variable.

When --apply is set, readable branch protection that is missing only the
required context is updated in place. With --json, every non-OK result also
persists a machine-readable audit record under data/branch-protection-audits by
default; override with --evidence-dir <path>.
`;

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function nearestExistingPath(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function assertSharedEvidenceOwner(evidenceDir, { processImpl = process } = {}) {
  const resolvedEvidenceDir = resolve(evidenceDir);
  if (resolvedEvidenceDir !== resolve(branchProtectionAuditDirPath(ROOT))) return;
  if (typeof processImpl.getuid !== 'function') return;
  const currentUid = processImpl.getuid();
  const existingPath = nearestExistingPath(resolvedEvidenceDir);
  if (!existingPath) return;
  const existingStats = statSync(existingPath);
  if (typeof existingStats.uid === 'number' && existingStats.uid !== currentUid) {
    const rel = relative(ROOT, resolvedEvidenceDir) || '.';
    throw new Error(
      `refusing to write shared branch-protection audit state at ${rel} as uid ${currentUid}; `
      + `existing owner uid is ${existingStats.uid}. Re-run as that owner or pass --evidence-dir.`,
    );
  }
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
  now = () => new Date().toISOString(),
  processImpl = process,
} = {}) {
  const parsed = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'evidence-dir': { type: 'string' },
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
  const relativeToRoot = (path) => {
    const rel = relative(ROOT, path);
    return rel === '' ? '.' : rel && !rel.startsWith('..') ? rel : path;
  };
  const evidenceDir = parsed.values['evidence-dir']
    ? resolve(parsed.values['evidence-dir'])
    : branchProtectionAuditDirPath(ROOT);
  const shouldPersistEvidence = parsed.values.json === true;
  if (shouldPersistEvidence) {
    try {
      assertSharedEvidenceOwner(evidenceDir, { processImpl });
      mkdirSync(evidenceDir, { recursive: true });
      assertSharedEvidenceOwner(evidenceDir, { processImpl });
    } catch (err) {
      stderr.write(`error: ${err?.message || err}\n`);
      return 4;
    }
  }
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
  const results = [];
  for (const repoPath of repos) {
    const baseBranch = parsed.values.base || resolveBaseBranchForRepo(repoPath, {
      baseBranches,
      defaultBaseBranch,
    });
    const initial = await fetchAdversarialGateBranchProtection({
      repoPath,
      baseBranch,
      execFileImpl,
      env,
    });
    const result = parsed.values.apply
      ? await ensureAdversarialGateRequiredContext({
        result: initial,
        execFileImpl,
        env,
      })
      : initial;
    if (shouldPersistEvidence && (!result.ok || result.applied === true)) {
      const { filePath } = writeBranchProtectionAuditRecord(ROOT, result, {
        directoryPath: evidenceDir,
        now: now(),
      });
      result.evidencePath = relativeToRoot(filePath);
    } else if (shouldPersistEvidence && result.ok === true && result.applied !== true) {
      deleteBranchProtectionAuditRecord(ROOT, result, {
        directoryPath: evidenceDir,
      });
    }
    results.push(result);
  }
  const summary = summarizeBranchProtectionResults(results);
  const exitCode = summary.total === summary.ok ? 0 : 1;

  if (parsed.values.json) {
    stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      generatedAt: now(),
      configPath: relativeToRoot(configPath),
      evidenceDir: relativeToRoot(evidenceDir),
      applyRequested: parsed.values.apply === true,
      summary: {
        ...summary,
        exitCode,
      },
      results,
    }, null, 2)}\n`);
    return exitCode;
  }

  for (const result of results) {
    if (result.ok) {
      const applied = result.applied === true ? ' applied=true' : '';
      stdout.write(`[branch-protection] ok repo=${result.repo} base=${result.baseBranch} context=${result.context}${applied}\n`);
    } else {
      stderr.write(`${formatBranchProtectionWarning(result)}\n`);
      if (result.evidencePath) {
        stderr.write(`[branch-protection] evidence repo=${result.repo} path=${result.evidencePath}\n`);
      }
    }
  }
  return exitCode;
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
