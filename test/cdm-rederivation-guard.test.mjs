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

test('CDM re-derivation guard does not report its own implementation in default scan targets', () => {
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const report = runAudit({ root: repoRoot });

  assert.equal(
    report.findings.some((finding) => finding.file === 'scripts/audit-cdm-rederivation.mjs'),
    false,
  );
});

test('CDM re-derivation guard permits allowlisted site and records it in JSON artifact', () => {
  const root = makeTempRoot();
  try {
    writeSource(root, 'src/allowlisted-gate.mjs', `
      // cdm-allowlist: temporary audited exception CDM-123
      export function legacyGateDecision(row, pr) {
        const verdict = row.last_verdict || row.reviewBody;
        const reviewedHead = row.reviewer_head_sha;
        const mergeable = pr.mergeable || pr.mergeStateStatus;
        return verdict && reviewedHead === pr.headSha && mergeable === 'MERGEABLE';
      }
    `);

    const report = runAudit({ root, scans: ['src'] });
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.allowlisted, 1);
    assert.equal(report.summary.non_allowlisted, 0);
    assert.equal(report.findings[0].line, 3);
    assert.equal(report.findings[0].allowlist_marker_present, true);
    assert.equal(
      report.findings[0].allowlist_reason,
      'temporary audited exception CDM-123',
    );
    assert.match(JSON.stringify(report), /temporary audited exception CDM-123/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CDM re-derivation guard does not let a nearby allowlist suppress an unrelated finding', () => {
  const root = makeTempRoot();
  try {
    writeSource(root, 'src/allowlisted-gate.mjs', `
      // cdm-allowlist: legacy gate decision report until AMA export moves to canonical snapshot
      export function legacyGateDecision(row, pr) {
        const verdict = row.last_verdict || row.reviewBody;
        const reviewedHead = row.reviewer_head_sha;
        const mergeable = pr.mergeable || pr.mergeStateStatus;
        return verdict && reviewedHead === pr.headSha && mergeable === 'MERGEABLE';
      }
    `);
    writeSource(root, 'src/unallowlisted-gate.mjs', `
      export function newGateDecision(row, pr) {
        const verdict = row.last_verdict || row.reviewBody;
        const reviewedHead = row.reviewer_head_sha;
        const mergeable = pr.mergeable || pr.mergeStateStatus;
        return verdict && reviewedHead === pr.headSha && mergeable === 'MERGEABLE';
      }
    `);

    const report = runAudit({ root, scans: ['src'] });
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.allowlisted, 1);
    assert.equal(report.summary.non_allowlisted, 1);
    assert.deepEqual(
      report.findings.map((finding) => ({
        file: finding.file,
        allowlisted: finding.allowlist_marker_present,
      })),
      [
        { file: 'src/allowlisted-gate.mjs', allowlisted: true },
        { file: 'src/unallowlisted-gate.mjs', allowlisted: false },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
