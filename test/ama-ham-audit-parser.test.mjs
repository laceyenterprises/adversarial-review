import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHamTerminalRemediationEvidenceFromGroundTruth,
} from '../src/ama/dispatch-closer.mjs';

test('HAM audit finding parsing preserves findings without exact file matches', () => {
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: 'abc123',
    verifiedCommit: {
      sha: 'def456',
      parentSha: 'abc123',
      trailers: { 'worker-ticket': 'HAM' },
      changedFiles: ['src/auth.js', 'README.md'],
    },
    verifiedAuditComment: {
      body: [
        '<!-- hq:ham-terminal-remediation:audit -->',
        '  - **Auth path not threaded** (blocking) - Addressed the auth handoff.',
        '- **README note is stale** (non-blocking) - Updated README.md with the current workflow.',
        '',
        'Doc-currency: not applicable for changed files src/auth.js.',
      ].join('\n'),
    },
  });

  assert.deepEqual(evidence.auditComment.findings, [
    {
      title: 'Auth path not threaded',
      blocking: true,
      file: '',
      addressed: true,
    },
    {
      title: 'README note is stale',
      blocking: false,
      file: 'README.md',
      addressed: true,
    },
  ]);
});

test('HAM audit doc-currency parsing is scoped to the Doc-currency line', () => {
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: 'abc123',
    verifiedCommit: {
      sha: 'def456',
      parentSha: 'abc123',
      trailers: { 'worker-ticket': 'HAM' },
      changedFiles: ['README.md'],
    },
    verifiedAuditComment: {
      body: [
        '<!-- hq:ham-terminal-remediation:audit -->',
        '- **README note is stale** (non-blocking) - Updated README.md; unrelated quoted text says not applicable.',
        '',
        'Doc-currency: updated README.md for changed files README.md.',
      ].join('\n'),
    },
  });

  assert.deepEqual(evidence.auditComment.docCurrency, {
    status: 'updated',
    changedFiles: ['README.md'],
    docsUpdated: ['README.md'],
  });
});
