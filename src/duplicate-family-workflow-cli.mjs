import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import {
  abandonDuplicateFamily,
  duplicateFamilyCandidateRows,
  ignoreDuplicateFamilyCandidate,
  selectDuplicateFamilySurvivor,
} from './duplicate-family-state.mjs';
import { openReviewStateDb } from './review-state.mjs';

const execFileDefault = promisify(execFileCallback);

const USAGE = `\
Usage:
  adversarial-review duplicate-family select <family-id> --survivor <pr> --report <path> --reason <text> --salvage <text> --validation <text> [--actor <login>] [--root <dir>]
  adversarial-review duplicate-family ignore <family-id> --pr <number> --reason <text> [--actor <login>] [--root <dir>]
  adversarial-review duplicate-family abandon <family-id> --reason <text> [--actor <login>] [--root <dir>]
`;

function parseArgs(argv, env = process.env) {
  const [command, familyId, ...rest] = argv;
  const options = {
    command, familyId, rootDir: process.cwd(), actor: env.GITHUB_ACTOR || env.USER || null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--root', '--actor', '--survivor', '--report', '--reason', '--salvage', '--validation', '--pr'].includes(arg)) {
      if (!rest[index + 1]) throw new Error(`${arg} requires a value`);
      const key = {
        '--root': 'rootDir', '--actor': 'actor', '--survivor': 'survivorPrNumber',
        '--report': 'reportPath', '--reason': 'reason', '--salvage': 'salvage',
        '--validation': 'validation', '--pr': 'prNumber',
      }[arg];
      options[key] = rest[++index];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function ghJson(execFileImpl, args) {
  const { stdout } = await execFileImpl('gh', args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '{}'));
}

async function verifyCommittedReport({ repo, headSha, reportPath, execFileImpl }) {
  const encodedPath = reportPath.split('/').map(encodeURIComponent).join('/');
  const result = await ghJson(execFileImpl, [
    'api', `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`,
  ]);
  if (result?.type !== 'file' || !result?.sha) {
    throw new Error(`report path is not a committed file at survivor head ${headSha}`);
  }
  return true;
}

function validateReportPath(reportPath) {
  const normalizedReportPath = String(reportPath || '').trim();
  if (!normalizedReportPath || normalizedReportPath.startsWith('/') || normalizedReportPath.includes('..')) {
    throw new Error('report path must be a repository-relative committed path');
  }
  if (!/^docs\/research\/duplicate-pr-divergence\/reports\/.+\.md$/i.test(normalizedReportPath)) {
    throw new Error('report path must name a duplicate-divergence corpus report');
  }
  return normalizedReportPath;
}

async function fetchLivePrHead({ repo, prNumber, execFileImpl }) {
  const result = await ghJson(execFileImpl, [
    'pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid',
  ]);
  const head = String(result?.headRefOid || '').trim();
  if (!head) throw new Error(`could not resolve live head for ${repo}#${prNumber}`);
  return head;
}

async function postSelectionComment({ repo, prNumber, selection, execFileImpl }) {
  const body = [
    '<!-- adversarial-review:duplicate-family-survivor-selection -->',
    'Selected as the sole duplicate-family survivor.',
    '',
    `Survivor choice: ${selection.reason}`,
    `Salvage: ${selection.salvage}`,
    `Report: \`${selection.reportPath}\` (verified at \`${selection.reportVerifiedHeadSha}\`)`,
    `Validation: ${selection.validation}`,
    '',
    'This selection does not bypass adversarial review, CI, mergeability, exact-head, or lease gates.',
  ].join('\n');
  await execFileImpl('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body], {
    timeout: 30_000, maxBuffer: 1024 * 1024,
  });
}

function isTransientSubprocessError(err) {
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  if (['EAGAIN', 'EBUSY', 'ECONNRESET', 'EHOSTUNREACH', 'EIO', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const status = Number(err?.status || err?.exitCode || err?.signalCode || 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const text = [
    err?.message,
    err?.stderr,
    err?.stdout,
  ].map((value) => String(value || '')).join('\n').toLowerCase();
  return [
    'resource temporarily unavailable',
    'operation timed out',
    'connection reset',
    'connection refused',
    'tls handshake timeout',
    'ssl',
    'early eof',
    'rpc failed',
    'remote end hung up unexpectedly',
    'http 429',
    'rate limit',
    'secondary rate limit',
    'http 500',
    'http 502',
    'http 503',
    'http 504',
  ].some((needle) => text.includes(needle));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRetry(operation, {
  attempts = 3,
  baseDelayMs = 250,
  sleepImpl = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isTransientSubprocessError(err)) throw err;
      await sleepImpl(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function snapshotSelectionState(db, familyId, candidates) {
  return {
    family: db.prepare(
      `SELECT status, selected_survivor_pr_number, report_path, operator_override_json,
              transition_log_json, updated_at
         FROM duplicate_families
        WHERE family_id = ?`
    ).get(familyId),
    candidates: candidates.map((candidate) => ({
      repo: candidate.repo,
      pr_number: candidate.pr_number,
      role: candidate.role,
      updated_at: candidate.updated_at,
    })),
  };
}

function restoreSelectionState(db, familyId, snapshot) {
  if (!snapshot?.family) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE duplicate_families
          SET status = ?,
              selected_survivor_pr_number = ?,
              report_path = ?,
              operator_override_json = ?,
              transition_log_json = ?,
              updated_at = ?
        WHERE family_id = ?`
    ).run(
      snapshot.family.status,
      snapshot.family.selected_survivor_pr_number,
      snapshot.family.report_path,
      snapshot.family.operator_override_json,
      snapshot.family.transition_log_json,
      snapshot.family.updated_at,
      familyId,
    );
    const restoreCandidate = db.prepare(
      `UPDATE duplicate_family_candidates
          SET role = ?, updated_at = ?
        WHERE repo = ? AND pr_number = ?`
    );
    for (const candidate of snapshot.candidates || []) {
      restoreCandidate.run(candidate.role, candidate.updated_at, candidate.repo, candidate.pr_number);
    }
  })();
}

export async function duplicateFamilyWorkflowMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv, io.env || process.env);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!['select', 'ignore', 'abandon'].includes(options.command) || !options.familyId) {
    stderr.write(`error: unknown or incomplete duplicate-family workflow command\n\n${USAGE}`);
    return 2;
  }
  const openDbImpl = io.openReviewStateDbImpl || openReviewStateDb;
  const execFileImpl = io.execFileImpl || execFileDefault;
  const sleepImpl = io.sleepImpl || sleep;
  const db = openDbImpl(options.rootDir);
  try {
    const family = db.prepare('SELECT * FROM duplicate_families WHERE family_id = ?').get(options.familyId);
    if (!family) throw new Error(`duplicate family not found: ${options.familyId}`);
    const candidates = duplicateFamilyCandidateRows(db, options.familyId);
    if (options.command === 'select') {
      const survivorPrNumber = Number(options.survivorPrNumber);
      const survivor = candidates.find((row) => Number(row.pr_number) === survivorPrNumber);
      if (!survivor || !options.reportPath) throw new Error('select requires a family-member --survivor and --report');
      options.reportPath = validateReportPath(options.reportPath);
      const liveHead = await withTransientRetry(
        () => fetchLivePrHead({ repo: family.target_repo, prNumber: survivorPrNumber, execFileImpl }),
        { attempts: 3, baseDelayMs: 250, sleepImpl },
      );
      if (liveHead !== survivor.head_sha) {
        throw new Error(`survivor cached head ${survivor.head_sha || '<missing>'} differs from live head ${liveHead}; wait for the watcher census to refresh`);
      }
      await withTransientRetry(
        () => verifyCommittedReport({
          repo: family.target_repo, headSha: liveHead,
          reportPath: options.reportPath, execFileImpl,
        }),
        { attempts: 3, baseDelayMs: 250, sleepImpl },
      );
      const selectionSnapshot = snapshotSelectionState(db, options.familyId, candidates);
      let selection;
      try {
        selection = selectDuplicateFamilySurvivor(db, {
          ...options, survivorPrNumber, reportVerifiedHeadSha: liveHead,
        });
        await withTransientRetry(
          () => postSelectionComment({
            repo: family.target_repo, prNumber: survivorPrNumber, selection, execFileImpl,
          }),
          { attempts: 3, baseDelayMs: 250, sleepImpl },
        );
      } catch (err) {
        restoreSelectionState(db, options.familyId, selectionSnapshot);
        throw err;
      }
      stdout.write(`selected ${family.target_repo}#${survivorPrNumber} as survivor at ${liveHead}\n`);
    } else if (options.command === 'ignore') {
      const prNumber = Number(options.prNumber);
      const candidate = candidates.find((row) => Number(row.pr_number) === prNumber);
      if (!candidate) throw new Error('ignore requires a family-member --pr');
      ignoreDuplicateFamilyCandidate(db, { ...options, prNumber, candidateHeadSha: candidate.head_sha });
      stdout.write(`ignored ${family.target_repo}#${prNumber} at ${candidate.head_sha}\n`);
    } else {
      abandonDuplicateFamily(db, options);
      stdout.write(`abandoned duplicate family ${options.familyId}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n`);
    return 2;
  } finally {
    db.close?.();
  }
}

export {
  parseArgs as parseDuplicateFamilyWorkflowArgs,
  USAGE as DUPLICATE_FAMILY_WORKFLOW_USAGE,
  fetchLivePrHead,
  isTransientSubprocessError,
  validateReportPath,
  verifyCommittedReport,
  withTransientRetry,
};
