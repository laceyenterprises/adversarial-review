import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  clobberGuardBlocks,
  clobberGuardEnabled,
  computePatchIdFromDiff,
  evaluateMovedHeadClobberGuard,
} from '../src/ama/clobber-guard.mjs';

// ---- fixtures -------------------------------------------------------------

// A unified diff for a single-file change, in the shape GitHub returns for
// `Accept: application/vnd.github.v3.diff`. `atLine` varies only the hunk offset
// so the SAME logical change at a different offset still hashes identically under
// `git patch-id --stable` (proving rebase stability).
function fileDiff({ file, add, atLine = 10 }) {
  return [
    `diff --git a/${file} b/${file}`,
    `index 1111111..2222222 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${atLine},2 +${atLine},3 @@`,
    ` context_before`,
    `+${add}`,
    ` context_after`,
    ``,
  ].join('\n');
}

const FIX_DIFF = fileDiff({ file: 'supervisor_recovery.py', add: '    # the real fix', atLine: 40 });
const TEST_DIFF = fileDiff({ file: 'test_supervisor_recovery.py', add: '    assert live', atLine: 12 });

// Build a stub execGh that answers `compare` (--jq list of shas) and per-commit
// diff lookups from in-memory maps. `compares` maps 'base...head' -> [sha...];
// `diffs` maps sha -> diff text. Uses the REAL git patch-id via default spawn.
function makeExecGh({ compares = {}, compareTotals = {}, diffs = {}, fail = false } = {}) {
  const calls = [];
  const execGh = async ({ args }) => {
    calls.push(args);
    if (fail) throw new Error('gh boom');
    const apiPath = String(args[1] || '');
    const cmp = /\/compare\/(.+?)\.\.\.(.+)$/u.exec(apiPath);
    if (cmp) {
      const key = `${cmp[1]}...${cmp[2]}`;
      const shas = compares[key] || [];
      return { stdout: JSON.stringify({ total: compareTotals[key] ?? shas.length, shas }) };
    }
    const commit = /\/commits\/([0-9a-fA-F]+)$/u.exec(apiPath);
    if (commit) {
      return { stdout: diffs[commit[1]] || '' };
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };
  execGh.calls = calls;
  return execGh;
}

const REVIEWED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLEAN_ENV = { ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: 'true' };

// ---- computePatchIdFromDiff ----------------------------------------------

test('computePatchIdFromDiff: empty diff -> null, real diff -> stable id, rebase-stable', async () => {
  assert.equal(await computePatchIdFromDiff(''), null);
  assert.equal(await computePatchIdFromDiff('   \n'), null);

  const id1 = await computePatchIdFromDiff(FIX_DIFF);
  const id2 = await computePatchIdFromDiff(FIX_DIFF);
  assert.ok(id1 && /^[0-9a-f]{40}$/u.test(id1), 'yields a sha1 patch-id');
  assert.equal(id1, id2, 'deterministic');

  // same change at a different line offset => same patch-id (rebase stability)
  const shifted = fileDiff({ file: 'supervisor_recovery.py', add: '    # the real fix', atLine: 400 });
  assert.equal(await computePatchIdFromDiff(shifted), id1);

  // a different change => different patch-id
  assert.notEqual(await computePatchIdFromDiff(TEST_DIFF), id1);
});

// ---- the #5455 clobber ----------------------------------------------------

test('clobber: rebase drops the reviewed fix commit, keeps only the test -> clobber', async () => {
  // reviewed head = base + [fix, test]; live head (clobbered) = base + [test'] (same
  // test content, DIFFERENT sha; the fix commit is gone).
  const execGh = makeExecGh({
    compares: {
      // commits on reviewed not on live
      [`${LIVE}...${REVIEWED}`]: ['f1100000', 'f2200000'],
      // commits on live not on reviewed
      [`${REVIEWED}...${LIVE}`]: ['f2200001'],
    },
    diffs: {
      f1100000: FIX_DIFF,
      f2200000: TEST_DIFF,
      f2200001: TEST_DIFF, // same content as the reviewed test commit
    },
  });

  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: CLEAN_ENV,
  });

  assert.equal(result.status, 'clobber');
  assert.equal(result.reason, 'reviewed-content-dropped-on-rebase');
  assert.equal(result.droppedCount, 1);
  assert.equal(result.dropped.length, 1);
  assert.equal(clobberGuardBlocks(result), true);
});

// ---- legitimate rebase (content preserved) --------------------------------

test('ok: legitimate rebase keeps every reviewed change (new shas, same content)', async () => {
  const execGh = makeExecGh({
    compares: {
      [`${LIVE}...${REVIEWED}`]: ['f1100000', 'f2200000'],
      [`${REVIEWED}...${LIVE}`]: ['f1100001', 'f2200001'],
    },
    diffs: {
      f1100000: FIX_DIFF,
      f2200000: TEST_DIFF,
      f1100001: FIX_DIFF, // same fix content, rebased
      f2200001: TEST_DIFF,
    },
  });

  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: CLEAN_ENV,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.reason, 'reviewed-content-preserved');
  assert.equal(clobberGuardBlocks(result), false);
});

// ---- already-upstream drop is NOT a false positive ------------------------

test('ok: a reviewed commit that legitimately landed upstream is not flagged', async () => {
  // The reviewed fix landed in the new base, so on the live side it appears as an
  // upstream commit with the SAME patch-id. It is dropped from the reviewed-only
  // set but present in the live-only set => preserved, not a clobber.
  const execGh = makeExecGh({
    compares: {
      [`${LIVE}...${REVIEWED}`]: ['f1100000', 'f2200000'],
      // live-only includes the upstream fix-equivalent commit + the rebased test
      [`${REVIEWED}...${LIVE}`]: ['f1100003', 'f2200001'],
    },
    diffs: {
      f1100000: FIX_DIFF,
      f2200000: TEST_DIFF,
      f1100003: FIX_DIFF, // same content as the reviewed fix, now upstream
      f2200001: TEST_DIFF,
    },
  });

  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: CLEAN_ENV,
  });

  assert.equal(result.status, 'ok');
  assert.equal(clobberGuardBlocks(result), false);
});

// ---- head-unchanged short-circuit (no gh calls) ---------------------------

test('ok: reviewed === live short-circuits without any gh call', async () => {
  const execGh = makeExecGh({});
  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: REVIEWED,
    execGh,
    env: CLEAN_ENV,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.reason, 'head-unchanged');
  assert.equal(execGh.calls.length, 0);
});

// ---- kill-switch ----------------------------------------------------------

test('skipped: kill-switch disables the guard (env override)', async () => {
  const execGh = makeExecGh({});
  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: { ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: 'false' },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'clobber-guard-disabled');
  assert.equal(clobberGuardBlocks(result), false);
  assert.equal(execGh.calls.length, 0, 'disabled guard does no work');
});

test('clobberGuardEnabled: env override wins, default is fail-safe ON', () => {
  assert.equal(clobberGuardEnabled({ ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: 'false' }), false);
  assert.equal(clobberGuardEnabled({ ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: '0' }), false);
  assert.equal(clobberGuardEnabled({ ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: 'true' }), true);
  assert.equal(
    clobberGuardEnabled(
      { ADVERSARIAL_MERGE_CLOBBER_GUARD_ENABLED: '  ' },
      { loaderImpl: () => ({ get: () => true }) },
    ),
    true,
  );
  // Unknown/empty env with an unreadable config falls back to the ON default.
  assert.equal(
    clobberGuardEnabled({}, { loaderImpl: () => { throw new Error('no config'); } }),
    true,
  );
});

// ---- fail-closed: gh error, missing heads, bad inputs, no gh --------------

test('unverifiable: gh failure fails closed (blocks the content-blind lane)', async () => {
  const execGh = makeExecGh({ fail: true });
  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: CLEAN_ENV,
    logger: { warn() {} },
  });
  assert.equal(result.status, 'unverifiable');
  assert.equal(result.reason, 'clobber-guard-verification-error');
  assert.equal(clobberGuardBlocks(result), true);
});

test('unverifiable: truncated GitHub compare response fails closed', async () => {
  const compareKey = `${LIVE}...${REVIEWED}`;
  const execGh = makeExecGh({
    compares: {
      [compareKey]: ['f1100000'],
      [`${REVIEWED}...${LIVE}`]: [],
    },
    compareTotals: {
      [compareKey]: 251,
    },
    diffs: {
      f1100000: FIX_DIFF,
    },
  });

  const result = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os',
    reviewedHead: REVIEWED,
    liveHead: LIVE,
    execGh,
    env: CLEAN_ENV,
    logger: { warn() {} },
  });

  assert.equal(result.status, 'unverifiable');
  assert.equal(result.reason, 'clobber-guard-verification-error');
  assert.match(result.error, /compare response truncated/u);
  assert.equal(clobberGuardBlocks(result), true);
});

test('skipped (not a block): malformed/non-SHA inputs cannot be a real merge head', async () => {
  // A non-SHA head cannot be merged by GitHub, so there is nothing to verify and no
  // clobber can reach main through it. These SKIP (non-blocking) rather than
  // fail-closed — only a runtime gh failure fails closed.
  const execGh = makeExecGh({});
  const missing = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os', reviewedHead: REVIEWED, liveHead: '', execGh, env: CLEAN_ENV,
  });
  assert.equal(missing.status, 'skipped');
  assert.equal(missing.reason, 'clobber-guard-not-applicable-missing-heads');
  assert.equal(clobberGuardBlocks(missing), false);

  const badRepo = await evaluateMovedHeadClobberGuard({
    repo: 'not a repo', reviewedHead: REVIEWED, liveHead: LIVE, execGh, env: CLEAN_ENV,
  });
  assert.equal(badRepo.status, 'skipped');
  assert.equal(badRepo.reason, 'clobber-guard-not-applicable-bad-inputs');

  const nonShaHead = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os', reviewedHead: 'not-a-sha', liveHead: LIVE, execGh, env: CLEAN_ENV,
  });
  assert.equal(nonShaHead.status, 'skipped');
  assert.equal(clobberGuardBlocks(nonShaHead), false);

  const noGh = await evaluateMovedHeadClobberGuard({
    repo: 'laceyenterprises/agent-os', reviewedHead: REVIEWED, liveHead: LIVE, env: CLEAN_ENV,
  });
  assert.equal(noGh.status, 'skipped');
  assert.equal(noGh.reason, 'clobber-guard-not-applicable-no-gh');
});

test('clobberGuardBlocks: only clobber and unverifiable block', () => {
  assert.equal(clobberGuardBlocks({ status: 'clobber' }), true);
  assert.equal(clobberGuardBlocks({ status: 'unverifiable' }), true);
  assert.equal(clobberGuardBlocks({ status: 'ok' }), false);
  assert.equal(clobberGuardBlocks({ status: 'skipped' }), false);
  assert.equal(clobberGuardBlocks(null), false);
});

test('ama-clobber-guard CLI rejects missing required assess flags', () => {
  const bin = fileURLToPath(new URL('../bin/ama-clobber-guard.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [
    bin,
    'assess',
    '--repo',
    'laceyenterprises/agent-os',
    '--reviewed-shas',
    REVIEWED,
    '--live-sha',
    LIVE,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/u);
});
