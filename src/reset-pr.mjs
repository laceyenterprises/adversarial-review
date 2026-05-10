#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { parseArgs as nodeParseArgs } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  getFollowUpJobDir,
  readFollowUpJob,
} from './follow-up-jobs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 4;
const VERB = 'hq.adversarial.reset-pr';

const USAGE = `\
Usage:
  adversarial-review reset-pr <owner/repo> <pr-number> [options]
  node src/reset-pr.mjs <owner/repo> <pr-number> [options]

Optional:
  --root-dir <path>        Tool root containing data/follow-up-jobs/
  --audit-root-dir <path>  Root that owns data/operator-mutations/
  --quiet                  Suppress JSON receipt output
  -h, --help               Show this help text

Exit codes:
  0 success (entries moved, or no-op receipt written)
  2 usage error
  4 runtime error
`;

class UsageError extends Error {}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      options: {
        'root-dir': { type: 'string' },
        'audit-root-dir': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  if (parsed.values.help) return { values: parsed.values, positionals: parsed.positionals };
  if (parsed.positionals.length !== 2) {
    throw new UsageError('expected <owner/repo> and <pr-number>');
  }

  const [repo, prRaw] = parsed.positionals;
  const pr = Number.parseInt(prRaw, 10);
  if (!repo || !repo.includes('/')) {
    throw new UsageError(`repo must be an owner/repo slug (got: ${repo || '<empty>'})`);
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new UsageError(`pr-number must be a positive integer (got: ${prRaw})`);
  }

  return { values: parsed.values, repo, pr };
}

function sanitizeTimestamp(ts) {
  return String(ts).replace(/[:.]/g, '-');
}

function operatorResetDir(rootDir, ts) {
  return join(rootDir, 'data', 'follow-up-jobs', '_operator-reset', sanitizeTimestamp(ts));
}

function receiptPath(auditRootDir, ts, attempt = 0) {
  const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
  return join(auditRootDir, 'data', 'operator-mutations', `${sanitizeTimestamp(ts)}${suffix}.json`);
}

function relatedEntryNames(dir, jobFileName) {
  return readdirSync(dir)
    .filter((name) => name === jobFileName || name.startsWith(`${jobFileName}.`))
    .sort();
}

function findResetCandidates(rootDir, { repo, prNumber }) {
  const dirs = [
    { key: 'pending', name: 'pending' },
    { key: 'inProgress', name: 'in-progress' },
    { key: 'stopped', name: 'stopped' },
    { key: 'failed', name: 'failed' },
    { key: 'completed', name: 'completed' },
  ];
  const candidates = [];

  for (const dirInfo of dirs) {
    const dir = getFollowUpJobDir(rootDir, dirInfo.key);
    if (!existsSync(dir)) continue;

    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch {
        continue;
      }
      if (job.repo !== repo || Number(job.prNumber) !== Number(prNumber)) {
        continue;
      }
      if (dirInfo.key === 'completed' && job?.reReview?.requested !== true) {
        continue;
      }
      candidates.push({
        statusDir: dirInfo.name,
        jobId: job.jobId || name.replace(/\.json$/u, ''),
        jobPath,
        entryNames: relatedEntryNames(dir, name),
      });
    }
  }

  return candidates;
}

function moveCandidates(rootDir, candidates, ts) {
  const resetRoot = operatorResetDir(rootDir, ts);
  const moved = [];

  for (const candidate of candidates) {
    const sourceDir = dirname(candidate.jobPath);
    const targetDir = join(resetRoot, candidate.statusDir);
    mkdirSync(targetDir, { recursive: true });

    const movedEntries = [];
    for (const entryName of candidate.entryNames) {
      const sourcePath = join(sourceDir, entryName);
      if (!existsSync(sourcePath)) continue;

      const targetPath = join(targetDir, entryName);
      renameSync(sourcePath, targetPath);
      movedEntries.push({
        from: sourcePath,
        to: targetPath,
      });
    }

    moved.push({
      status: candidate.statusDir,
      jobId: candidate.jobId,
      jobFile: basename(candidate.jobPath),
      entries: movedEntries,
    });
  }

  return { resetRoot, moved };
}

function writeReceipt(auditRootDir, receipt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targetPath = receiptPath(auditRootDir, receipt.ts, attempt);
    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      writeFileAtomic(targetPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o640,
        overwrite: false,
      });
      return targetPath;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`could not allocate reset receipt path for timestamp ${receipt.ts}`);
}

function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date().toISOString(),
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const rootDir = parsed.values['root-dir'] ? resolve(parsed.values['root-dir']) : DEFAULT_ROOT_DIR;
  const auditRootDir = parsed.values['audit-root-dir'] ? resolve(parsed.values['audit-root-dir']) : rootDir;
  const ts = now();
  const operator = process.env.HQ_OPERATOR || process.env.USER || 'unknown';

  try {
    const candidates = findResetCandidates(rootDir, {
      repo: parsed.repo,
      prNumber: parsed.pr,
    });
    const { resetRoot, moved } = moveCandidates(rootDir, candidates, ts);
    const movedEntryCount = moved.reduce((sum, item) => sum + item.entries.length, 0);
    const receipt = {
      ts,
      verb: VERB,
      repo: parsed.repo,
      pr: parsed.pr,
      operator,
      outcome: movedEntryCount > 0 ? 'reset' : 'noop',
      resetRoot,
      movedJobCount: moved.length,
      movedEntryCount,
      moved,
    };
    const path = writeReceipt(auditRootDir, receipt);
    const emitted = { ...receipt, receiptPath: path };
    if (!parsed.values.quiet) stdout.write(`${JSON.stringify(emitted)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return EXIT_RUNTIME;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export {
  findResetCandidates,
  main,
  moveCandidates,
  parseArgs,
};
