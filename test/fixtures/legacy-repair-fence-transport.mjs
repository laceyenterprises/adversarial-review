// Disposable installed-layout transport used by the retirement CLI fixtures.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFollowUpJobDir } from '../../src/follow-up-jobs.mjs';

const [script, ...selector] = process.argv.slice(2);
const rootDir = dirname(dirname(script));
assert.equal(process.env.HQ_PYTHON3, undefined);
assert.equal(process.env.HQ_PYTHON3_CANDIDATES_FOR_TEST, undefined);
const { receipt, action, identity } = JSON.parse(readFileSync(join(rootDir, 'fixture-reader-input.json'), 'utf8'));
const { repo, prNumber, baseHead, epochId, ownerKey, handoffRound } = identity;
assert.deepEqual(selector, [repo, String(prNumber), baseHead, epochId, ownerKey, String(handoffRound)]);
switch (action) {
  case 'unavailable': throw new Error('canonical evidence unavailable');
  case 'queue-follow-up': {
    const pending = getFollowUpJobDir(rootDir, 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'misfiled.json'), JSON.stringify({ repo, prNumber, jobId: 'live-follow-up' }));
    break;
  }
  case 'read': break;
  default: throw new Error(`unexpected fixture action ${action}`);
}
console.log(JSON.stringify(receipt));
