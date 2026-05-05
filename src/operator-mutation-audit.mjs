import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const EX_USAGE = 64;
const EX_DATAERR = 65;

function buildRequestFingerprint({ verb, repo, pr, reason }) {
  return `${verb}:${repo}:${pr}:${reason}`;
}

function digestSha256(text) {
  return `sha256:${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`;
}

function resolveIdempotencyKey({ verb, repo, pr, reason, idempotencyKey }) {
  const requestFingerprint = buildRequestFingerprint({ verb, repo, pr, reason });
  return {
    requestFingerprint,
    idempotencyKey: idempotencyKey || digestSha256(requestFingerprint),
  };
}

function operatorMutationsDir(rootDir) {
  return join(rootDir, 'data', 'operator-mutations');
}

function monthFilePath(rootDir, ts) {
  return join(operatorMutationsDir(rootDir), `${String(ts).slice(0, 7)}.jsonl`);
}

function listJsonlFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(dirPath, name));
}

function buildExistingFingerprint(row) {
  return buildRequestFingerprint({
    verb: row.verb,
    repo: row.repo,
    pr: row.pr,
    reason: row.reason,
  });
}

function findOperatorMutationAuditRow(rootDir, idempotencyKey) {
  for (const filePath of listJsonlFiles(operatorMutationsDir(rootDir))) {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      if (row.idempotencyKey === idempotencyKey) {
        return row;
      }
    }
  }
  return null;
}

function assertNoIdempotencyMismatch(existingRow, requestFingerprint) {
  if (!existingRow) return;
  if (buildExistingFingerprint(existingRow) !== requestFingerprint) {
    const err = new Error('IDEMPOTENCY_KEY_MISMATCH');
    err.code = 'IDEMPOTENCY_KEY_MISMATCH';
    err.exitCode = EX_DATAERR;
    throw err;
  }
}

function appendOperatorMutationAuditRow(rootDir, row) {
  const filePath = monthFilePath(rootDir, row.ts);
  mkdirSync(operatorMutationsDir(rootDir), { recursive: true });
  const fd = openSync(filePath, 'a', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

function isCommittedOperatorMutationOutcome(outcome) {
  return typeof outcome === 'string' && !outcome.startsWith('refused:');
}

export {
  EX_DATAERR,
  EX_USAGE,
  appendOperatorMutationAuditRow,
  assertNoIdempotencyMismatch,
  digestSha256,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
};
