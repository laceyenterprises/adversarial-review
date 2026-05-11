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
import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import {
  FOLLOW_UP_JOB_DIRS,
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
class ResetMoveError extends Error {
  constructor(message, { cause, resetRoot, moved }) {
    super(message);
    this.name = 'ResetMoveError';
    this.cause = cause;
    this.resetRoot = resetRoot;
    this.moved = moved;
  }
}

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

function attemptSuffix(attempt = 0) {
  return attempt === 0 ? '' : `-${attempt + 1}`;
}

function operatorResetDir(rootDir, ts, attempt = 0) {
  return join(rootDir, 'data', 'follow-up-jobs', '_operator-reset', `${sanitizeTimestamp(ts)}${attemptSuffix(attempt)}`);
}

function receiptPath(auditRootDir, ts, attempt = 0) {
  return join(auditRootDir, 'data', 'operator-mutations', `${sanitizeTimestamp(ts)}${attemptSuffix(attempt)}.json`);
}

function relatedEntryNames(dir, jobFileName) {
  return readdirSync(dir)
    .filter((name) => name === jobFileName || name.startsWith(`${jobFileName}.`))
    .sort();
}

function findResetCandidates(rootDir, { repo, prNumber }) {
  const dirs = ['pending', 'inProgress', 'stopped', 'failed', 'completed']
    .map((key) => ({ key, name: FOLLOW_UP_JOB_DIRS[key].at(-1) }));
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

function moveCandidates(candidates, resetRoot) {
  const moved = [];

  for (const candidate of candidates) {
    const sourceDir = dirname(candidate.jobPath);
    const targetDir = join(resetRoot, candidate.statusDir);
    mkdirSync(targetDir, { recursive: true });

    const movedEntries = [];
    try {
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
    } catch (err) {
      moved.push({
        status: candidate.statusDir,
        jobId: candidate.jobId,
        jobFile: basename(candidate.jobPath),
        entries: movedEntries,
        error: err?.message || String(err),
      });
      throw new ResetMoveError(`reset-pr move failed for ${candidate.jobId}: ${err?.message || err}`, {
        cause: err,
        resetRoot,
        moved,
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

function reserveReceipt(auditRootDir, receipt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targetPath = receiptPath(auditRootDir, receipt.ts, attempt);
    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      writeFileAtomic(targetPath, `${JSON.stringify({ ...receipt, outcome: 'pending' }, null, 2)}\n`, {
        mode: 0o640,
        overwrite: false,
      });
      return { path: targetPath, attempt };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`could not allocate reset receipt path for timestamp ${receipt.ts}`);
}

function finalizeReceipt(path, receipt) {
  writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o640,
    overwrite: true,
  });
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
    const subjectIdentity = buildCodePrSubjectIdentity({
      repo: parsed.repo,
      prNumber: parsed.pr,
    });
    const baseReceipt = {
      ts,
      verb: VERB,
      repo: parsed.repo,
      pr: parsed.pr,
      domainId: subjectIdentity.domainId,
      subjectExternalId: subjectIdentity.subjectExternalId,
      revisionRef: subjectIdentity.revisionRef,
      operator,
    };
    const reservation = reserveReceipt(auditRootDir, {
      ...baseReceipt,
      candidateJobCount: candidates.length,
      candidates: candidates.map((candidate) => ({
        status: candidate.statusDir,
        jobId: candidate.jobId,
        jobFile: basename(candidate.jobPath),
        entryCount: candidate.entryNames.length,
      })),
    });

    const resetRoot = operatorResetDir(rootDir, ts, reservation.attempt);
    let moved;
    try {
      ({ moved } = moveCandidates(candidates, resetRoot));
    } catch (err) {
      if (err instanceof ResetMoveError) {
        const movedEntryCount = err.moved.reduce((sum, item) => sum + item.entries.length, 0);
        finalizeReceipt(reservation.path, {
          ...baseReceipt,
          outcome: 'partial',
          resetRoot: err.resetRoot,
          movedJobCount: err.moved.length,
          movedEntryCount,
          moved: err.moved,
          error: err.message,
        });
      }
      throw err;
    }

    const movedEntryCount = moved.reduce((sum, item) => sum + item.entries.length, 0);
    const receipt = {
      ...baseReceipt,
      outcome: movedEntryCount > 0 ? 'reset' : 'noop',
      resetRoot,
      movedJobCount: moved.length,
      movedEntryCount,
      moved,
    };
    finalizeReceipt(reservation.path, receipt);
    const emitted = { ...receipt, receiptPath: reservation.path };
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
