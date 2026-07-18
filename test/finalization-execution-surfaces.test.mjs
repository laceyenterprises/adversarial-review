// ARC-17 — the executor's merge/identity surfaces (docs/SPEC-merge-authority-v2.md
// §4). The ARC-20 adjudicate surface is preferred; the github-adapter
// `pull-request-merge` is the local-mode fallback; the ARC-22 identity surface is
// read-through and fail-closed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCodePrSubject,
  resolveMergeSurface,
  checkIdentityAttestation,
  createGithubAdapterMergeSurface,
} from '../src/finalization/execution-surfaces.mjs';

test('parseCodePrSubject extracts repo + pr from owner/repo#N', () => {
  assert.deepEqual(parseCodePrSubject('owner/repo#17'), { repo: 'owner/repo', prNumber: 17 });
  assert.equal(parseCodePrSubject('not-a-subject'), null);
  assert.equal(parseCodePrSubject(''), null);
  assert.equal(parseCodePrSubject('owner/repo'), null);
});

test('resolveMergeSurface prefers the ARC-20 adjudicate surface, then the local fallback', () => {
  const adjudicate = { merge() {} };
  const local = { merge() {} };
  assert.equal(resolveMergeSurface({ adjudicateSurface: adjudicate, localFallback: local }), adjudicate);
  assert.equal(resolveMergeSurface({ adjudicateSurface: null, localFallback: local }), local);
  assert.equal(resolveMergeSurface({ githubAdapter: local }), local);
  assert.equal(resolveMergeSurface({}), null, 'no surface available → null (executor fails closed)');
});

test('github-adapter fallback merges at the decided revision via matchHeadCommit', async () => {
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ merged: true, sha: 'merge-sha' }) };
  };
  const surface = createGithubAdapterMergeSurface({
    execFileImpl,
    env: { GHA_ADAPTER_BIN: '/fake/github-adapter', GH_TOKEN: 'x' },
  });
  const result = await surface.merge({ subjectExternalId: 'owner/repo#17', revisionRef: 'sha-A', mergeMethod: 'squash' });

  assert.equal(result.ok, true);
  // The adapter is invoked with the decided head pinned — a stale-head merge is
  // structurally impossible to issue (§4).
  const merged = calls[0].join(' ');
  assert.match(merged, /--match-head-commit sha-A/);
  assert.match(merged, /--merge-method squash/);
});

test('github-adapter fallback fails closed when the merge is refused', async () => {
  const execFileImpl = async () => ({ stdout: JSON.stringify({ merged: false, reason: 'head moved' }) });
  const surface = createGithubAdapterMergeSurface({
    execFileImpl,
    env: { GHA_ADAPTER_BIN: '/fake/github-adapter' },
  });
  const result = await surface.merge({ subjectExternalId: 'owner/repo#17', revisionRef: 'sha-A' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'merge-refused');
});

test('github-adapter fallback refuses a merge without a decided revision', async () => {
  const surface = createGithubAdapterMergeSurface({ env: { GHA_ADAPTER_BIN: '/fake/github-adapter' } });
  const result = await surface.merge({ subjectExternalId: 'owner/repo#17', revisionRef: '' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-revision');
});

test('checkIdentityAttestation: absent surface is local mode (ok); present-and-denied fails closed', async () => {
  assert.deepEqual(await checkIdentityAttestation(null, {}), { ok: true, localMode: true });

  const allow = { check: async () => ({ ok: true }) };
  assert.equal((await checkIdentityAttestation(allow, {})).ok, true);

  const deny = { check: async () => ({ ok: false, reason: 'no attestation' }) };
  const denied = await checkIdentityAttestation(deny, {});
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /no attestation/);

  const thrower = { check: async () => { throw new Error('surface down'); } };
  const errored = await checkIdentityAttestation(thrower, {});
  assert.equal(errored.ok, false, 'a throwing surface fails closed');
  assert.match(errored.reason, /fail-closed/);
});
