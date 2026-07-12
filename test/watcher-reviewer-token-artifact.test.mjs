import test from 'node:test';
import assert from 'node:assert/strict';

import { writeReviewerTokenUsageArtifactBestEffort } from '../src/watcher.mjs';

test('reviewer token artifact failures are logged and fail open', () => {
  const warnings = [];
  const artifact = writeReviewerTokenUsageArtifactBestEffort(
    { tokenUsage: { input: 1, output: 1 } },
    {
      repo: 'lacey/repo',
      prNumber: 55,
      reviewerSessionUuid: 'session-1',
      writeImpl: () => { throw new Error('workspace unavailable'); },
      warn: (message) => warnings.push(message),
    }
  );

  assert.equal(artifact, null);
  assert.deepEqual(warnings, [
    '[watcher] reviewer_token_usage_artifact_write_failed repo=lacey/repo pr=55 ' +
      'session=session-1: workspace unavailable',
  ]);
});
