import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from './config-loader.mjs';
import { deliverAlert } from './alert-delivery.mjs';

export const PUBLIC_SAFE_REVIEW_ADDENDUM = `

Public-safe review requirements:
Refer to code and behaviour only. Never refer to the environment, operator,
host, accounts, internal trackers, internal links or operational identifiers.
Do not reproduce sensitive context from the diff or instructions. Describe
affected code by repository-relative path and line, without quoting secrets.
`;

export function isPublicHygieneRepo(repo, getConfigImpl = getConfig) {
  const repos = getConfigImpl('worker_pool.public_hygiene.repos', []);
  if (!Array.isArray(repos) || repos.some(value => typeof value !== 'string')) {
    throw new Error('Invalid public-hygiene repository configuration');
  }
  return repos.some(value => value.trim().toLowerCase() === String(repo).trim().toLowerCase());
}

// Accept only numeric locations and known classes; never persist CLI output or
// exceptions, even when a broken scanner returns an unsafe diagnostic.
function scanLocation(record) {
  return {
    class: ['text', 'configuration', 'scan-error', 'bound', 'encoding', 'denylist']
      .includes(record?.kind) ? record.kind : 'scanner-unavailable',
    line: Number.isSafeInteger(record?.line) && record.line >= 0 ? record.line : 0,
    rule: Number.isSafeInteger(record?.rule) && record.rule >= 0 ? record.rule : 0,
  };
}

export async function assertPublicSafeReview({
  repo, prNumber, reviewBody,
  getConfigImpl = getConfig,
  execFileImpl = promisify(execFile),
  deliverAlertImpl = deliverAlert,
  log = console,
}) {
  let record;
  let directory;
  try {
    if (!isPublicHygieneRepo(repo, getConfigImpl)) return;
    directory = await mkdtemp(join(tmpdir(), 'review-hygiene-'));
    const textFile = join(directory, 'review.txt');
    await writeFile(textFile, reviewBody, { mode: 0o600 });
    let output;
    let exitCode = 0;
    try {
      output = await execFileImpl('hq', [
        'hygiene', 'scan', '--repo', repo, '--text-file', textFile, '--json',
      ], { timeout: 130_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    } catch (error) {
      exitCode = error.code;
      output = { stdout: error.stdout };
    }
    record = JSON.parse(output.stdout);
    if (exitCode === 0 && record.status === 'clean') return;
  } catch {
    record = null;
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        log.error('Public-hygiene temporary text cleanup failed');
      }
    }
  }
  const hold = {
    event: 'reviewer.public_hygiene_hold', repo, prNumber,
    ...scanLocation(record),
  };
  log.error(JSON.stringify(hold));
  try {
    await deliverAlertImpl('Review posting held by public-hygiene scan. Repair the flagged text or scanner and retry.', {
      event: hold.event, payload: hold,
    });
  } catch {
    log.error('Public-hygiene hold alert delivery failed');
  }
  throw Object.assign(new Error('Review posting held by public-hygiene scan'), {
    code: 'PUBLIC_HYGIENE_HOLD', hold,
  });
}
