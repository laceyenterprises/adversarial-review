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
      const liveHead = await fetchLivePrHead({ repo: family.target_repo, prNumber: survivorPrNumber, execFileImpl });
      if (liveHead !== survivor.head_sha) {
        throw new Error(`survivor cached head ${survivor.head_sha || '<missing>'} differs from live head ${liveHead}; wait for the watcher census to refresh`);
      }
      await verifyCommittedReport({
        repo: family.target_repo, headSha: liveHead,
        reportPath: options.reportPath, execFileImpl,
      });
      const selection = selectDuplicateFamilySurvivor(db, {
        ...options, survivorPrNumber, reportVerifiedHeadSha: liveHead,
      });
      await postSelectionComment({
        repo: family.target_repo, prNumber: survivorPrNumber, selection, execFileImpl,
      });
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
  validateReportPath,
  verifyCommittedReport,
};
