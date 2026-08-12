import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHamTerminalRemediationEvidenceFromGroundTruth,
} from '../src/ama/dispatch-closer.mjs';

test('HAM audit finding parsing does not attribute a file from unrelated comment sections', () => {
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
        '- **Auth path not threaded** (blocking) - Addressed the auth handoff.',
        '- **README note is stale** (non-blocking) - Updated README.md with the current workflow.',
        '',
        'Doc-currency: not applicable for changed files src/auth.js.',
      ].join('\n'),
    },
  });

  assert.deepEqual(evidence.auditComment.findings, [
    {
      title: 'README note is stale',
      blocking: false,
      file: 'README.md',
      addressed: true,
    },
  ]);
});
