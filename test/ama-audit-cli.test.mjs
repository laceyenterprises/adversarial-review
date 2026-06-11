import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAmaAuditEntry } from '../src/ama/audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'ama-audit.mjs');

const DEFAULT_TUPLE = Object.freeze({
  repo: 'acme/myrepo',
  prNumber: 1234,
  headSha: 'abc12345abc12345abc12345abc12345abc12345',
});

function freshHqRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-audit-cli-'));
}

test('ama-audit append returns exit 66 for sticky-succeeded refusal', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'succeeded' },
      now: '2026-06-11T20:00:00Z',
    });

    let err = null;
    try {
      execFileSync(process.execPath, [
        CLI_PATH,
        'append',
        '--hq-root', hqRoot,
        '--repo', DEFAULT_TUPLE.repo,
        '--pr', String(DEFAULT_TUPLE.prNumber),
        '--head', DEFAULT_TUPLE.headSha,
        '--outcome', 'deferred',
        '--now', '2026-06-11T20:05:00Z',
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (caught) {
      err = caught;
    }

    assert.ok(err, 'append should fail for sticky-succeeded refusal');
    assert.equal(err.status, 66);
    assert.match(String(err.stderr || ''), /refusing to demote terminal 'succeeded'/);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('ama-audit append returns exit 65 for generic writer/data failures', () => {
  const hqRoot = freshHqRoot();
  try {
    let err = null;
    try {
      execFileSync(process.execPath, [
        CLI_PATH,
        'append',
        '--hq-root', hqRoot,
        '--repo', DEFAULT_TUPLE.repo,
        '--pr', String(DEFAULT_TUPLE.prNumber),
        '--head', DEFAULT_TUPLE.headSha,
        '--outcome', 'deferred',
        '--now', '2026-06-11T20:05:00Z',
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (caught) {
      err = caught;
    }

    assert.ok(err, 'append should fail when the audit record is missing');
    assert.equal(err.status, 65);
    assert.match(String(err.stderr || ''), /no existing record/);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});
