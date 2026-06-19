import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAudit } from '../scripts/audit-cdm-rederivation.mjs';

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'cdm-rederivation-guard-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'adversarial-gate-status.mjs'),
    [
      'export function pickAdversarialGateStatus() {',
      '  return { state: "success" };',
      '}',
      '',
    ].join('\n'),
  );
  return root;
}

function writeSource(root, rel, body) {
  const filePath = path.join(root, rel);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${body.trim()}\n`);
}

test('CDM re-derivation guard flags planted raw verdict/head/mergeability gate decision outside owner', () => {
  const root = makeTempRoot();
  try {
    writeSource(root, 'src/planted-gate.mjs', `
      import { normalizeGithubMergeability } from './github-mergeability.mjs';

      export function canMergeFromRawFacts(row, pr) {
        const verdict = row.last_verdict || row.review_body;
        const reviewedHead = row.reviewer_head_sha;
        const mergeable = normalizeGithubMergeability({
          mergeable: pr.mergeable,
          mergeStateStatus: pr.mergeStateStatus,
        });
        return (
          (verdict === 'approved' || verdict === 'comment-only') &&
          reviewedHead === pr.headSha &&
          mergeable === 'MERGEABLE'
        );
      }
    `);

    const report = runAudit({ root, scans: ['src'] });
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.non_allowlisted, 1);
    assert.equal(report.findings[0].category, 'review-verdict');
    assert.equal(report.findings[0].file, 'src/planted-gate.mjs');
    assert.deepEqual(report.findings[0].facts.reviewerHeadLines, [5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CDM re-derivation guard passes clean on migrated adversarial-review tree', () => {
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const report = runAudit({ root: repoRoot, scans: ['src', 'scripts', 'bin'] });

  assert.equal(report.summary.total, 0, JSON.stringify(report.findings, null, 2));
  assert.deepEqual(report.findings, []);
});

test('CDM re-derivation guard permits allowlisted site and records it in JSON artifact', () => {
  const root = makeTempRoot();
  try {
    writeSource(root, 'src/allowlisted-gate.mjs', `
      export function legacyGateDecision(row, pr) {
        const verdict = row.last_verdict || row.reviewBody;
        const reviewedHead = row.reviewer_head_sha;
        const mergeable = pr.mergeable || pr.mergeStateStatus;
        // cdm-allowlist: legacy gate decision report until AMA export moves to canonical snapshot
        return verdict && reviewedHead === pr.headSha && mergeable === 'MERGEABLE';
      }
    `);

    const report = runAudit({ root, scans: ['src'] });
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.allowlisted, 1);
    assert.equal(report.summary.non_allowlisted, 0);
    assert.equal(report.findings[0].allowlist_marker_present, true);
    assert.equal(
      report.findings[0].allowlist_reason,
      'legacy gate decision report until AMA export moves to canonical snapshot',
    );
    assert.match(JSON.stringify(report), /legacy gate decision report/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
