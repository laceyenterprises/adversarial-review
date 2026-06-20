import test from 'node:test';
import assert from 'node:assert/strict';

import { assessMergeLeaseNeedsRevalidation } from '../src/ama/merge-lease.mjs';

const VALIDATION_BASE = '1111111111111111111111111111111111111111';
const CURRENT_BASE = '2222222222222222222222222222222222222222';
const MERGE_BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeGitStub(handlers) {
  const calls = [];
  const execFileImpl = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    assert.equal(command, 'git');
    const key = args.join(' ');
    const handler = handlers[key];
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler({ command, args, options, calls });
    if (handler !== undefined) return { stdout: handler, stderr: '' };
    throw new Error(`unexpected git call: ${key}`);
  };
  execFileImpl.calls = calls;
  return execFileImpl;
}

function defaultHandlers(overrides = {}) {
  return {
    [`cat-file -e ${VALIDATION_BASE}^{commit}`]: '',
    [`rev-parse --verify refs/remotes/origin/main^{commit}`]: `${CURRENT_BASE}\n`,
    [`rev-list --count ${VALIDATION_BASE}..${CURRENT_BASE}`]: '3\n',
    [`diff --name-only ${VALIDATION_BASE}..${CURRENT_BASE}`]: 'src/shared.mjs\nREADME.md\n',
    [`merge-base ${CURRENT_BASE} HEAD`]: `${MERGE_BASE}\n`,
    [`diff --name-only ${MERGE_BASE}..HEAD`]: 'src/shared.mjs\nsrc/pr-only.mjs\n',
    ...overrides,
  };
}

function decide(overrides = {}, args = {}) {
  return assessMergeLeaseNeedsRevalidation({
    repoPath: '/repo',
    base: 'main',
    validationBase: VALIDATION_BASE,
    currentBase: CURRENT_BASE,
    execFileImpl: makeGitStub(defaultHandlers(overrides)),
    ...args,
  });
}

test('overlap requires revalidation when base moved a PR-touched file', async () => {
  const decision = await decide();

  assert.equal(decision.needsRevalidation, true);
  assert.equal(decision.reason, 'overlapping-files');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.equal(decision.mainAdvancedBy, 3);
  assert.deepEqual(decision.overlappingFiles, ['src/shared.mjs']);
});

test('no overlap skips revalidation when base moved unrelated files', async () => {
  const decision = await decide({
    [`diff --name-only ${MERGE_BASE}..HEAD`]: 'src/pr-only.mjs\n',
  });

  assert.equal(decision.needsRevalidation, false);
  assert.equal(decision.reason, 'no-overlapping-files');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.equal(decision.mainAdvancedBy, 3);
  assert.deepEqual(decision.overlappingFiles, []);
});

test('empty PR diff fails closed when changed-files ref resolves to the base', async () => {
  const decision = await decide({
    [`merge-base ${CURRENT_BASE} HEAD`]: `${CURRENT_BASE}\n`,
    [`diff --name-only ${CURRENT_BASE}..HEAD`]: '',
  });

  assert.equal(decision.needsRevalidation, true);
  assert.equal(decision.reason, 'pr-diff-empty');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.equal(decision.mainAdvancedBy, 3);
  assert.deepEqual(decision.overlappingFiles, []);
});

test('base not advanced since validation-base skips revalidation with zero drift', async () => {
  const execFileImpl = makeGitStub({
    [`cat-file -e ${VALIDATION_BASE}^{commit}`]: '',
    [`rev-parse --verify refs/remotes/origin/main^{commit}`]: `${VALIDATION_BASE}\n`,
  });
  const decision = await assessMergeLeaseNeedsRevalidation({
    repoPath: '/repo',
    base: 'main',
    validationBase: VALIDATION_BASE,
    currentBase: VALIDATION_BASE,
    execFileImpl,
  });

  assert.equal(decision.needsRevalidation, false);
  assert.equal(decision.reason, 'base-not-advanced');
  assert.equal(decision.currentBase, VALIDATION_BASE);
  assert.equal(decision.mainAdvancedBy, 0);
  assert.deepEqual(decision.overlappingFiles, []);
  assert.equal(execFileImpl.calls.length, 2);
});

test('stale or unverified current-base fails closed after bounded fetch retry', async () => {
  const staleBase = '3333333333333333333333333333333333333333';
  const execFileImpl = makeGitStub({
    [`cat-file -e ${VALIDATION_BASE}^{commit}`]: '',
    [`rev-parse --verify refs/remotes/origin/main^{commit}`]: `${staleBase}\n`,
    'fetch --no-tags origin main': '',
  });
  const decision = await assessMergeLeaseNeedsRevalidation({
    repoPath: '/repo',
    base: 'main',
    validationBase: VALIDATION_BASE,
    currentBase: CURRENT_BASE,
    execFileImpl,
    fetchAttempts: 1,
  });

  assert.equal(decision.needsRevalidation, true);
  assert.equal(decision.reason, 'unverified-current-base');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.equal(decision.mainAdvancedBy, null);
  assert.deepEqual(decision.overlappingFiles, []);
  assert.deepEqual(execFileImpl.calls.map((call) => call.args[0]), [
    'cat-file',
    'rev-parse',
    'fetch',
    'rev-parse',
  ]);
});

test('malformed validation-base sha fails closed without git calls', async () => {
  const execFileImpl = makeGitStub({});
  const decision = await assessMergeLeaseNeedsRevalidation({
    repoPath: '/repo',
    base: 'main',
    validationBase: 'not-a-sha',
    currentBase: CURRENT_BASE,
    execFileImpl,
  });

  assert.equal(decision.needsRevalidation, true);
  assert.equal(decision.reason, 'malformed-validation-base');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.deepEqual(decision.overlappingFiles, []);
  assert.equal(execFileImpl.calls.length, 0);
});

test('unresolvable validation-base sha fails closed', async () => {
  const decision = await assessMergeLeaseNeedsRevalidation({
    repoPath: '/repo',
    base: 'main',
    validationBase: VALIDATION_BASE,
    currentBase: CURRENT_BASE,
    execFileImpl: makeGitStub({
      [`cat-file -e ${VALIDATION_BASE}^{commit}`]: new Error('missing object'),
    }),
  });

  assert.equal(decision.needsRevalidation, true);
  assert.equal(decision.reason, 'unresolvable-validation-base');
  assert.equal(decision.currentBase, CURRENT_BASE);
  assert.equal(decision.mainAdvancedBy, null);
  assert.deepEqual(decision.overlappingFiles, []);
});

test('decision output shape is stable', async () => {
  const decision = await decide();

  assert.deepEqual(Object.keys(decision), [
    'needsRevalidation',
    'reason',
    'currentBase',
    'mainAdvancedBy',
    'overlappingFiles',
  ]);
});
