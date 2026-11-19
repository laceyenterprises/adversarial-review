import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amaAuditFilePath, appendAmaAuditAttempt } from '../src/ama/audit.mjs';
import { createHammerScratchDir, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { deliverHammerClosingComment } from '../src/ama/hammer-closing-comment.mjs';
import { recordVerifiedHammerMerge } from '../src/ama/hammer-outcome.mjs';

const repo = 'fixture/repo';
const prNumber = 42;
const headSha = 'a'.repeat(40);
const mergeCommitSha = 'b'.repeat(40);
const mergedAt = '2026-11-19T21:52:21Z';
const launchRequestId = 'lrq_fixture';
const runId = 'wrun_fixture';
const author = { login: 'the-hammer-lacey[bot]' };
const closingMarker = `<!-- hq:ham-closing:${headSha}:${mergeCommitSha} -->`;

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-closing-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const env = { HQ_LAUNCH_REQUEST_ID: launchRequestId, HQ_WORKER_RUN_ID: runId, HAM_HQ_ROOT: rootDir };
  const params = { repo, prNumber, rootDir, hqRoot: rootDir, env };
  const identity = { repo, prNumber, headSha };
  const outcomePath = join(rootDir, 'dispatch', launchRequestId, 'hammer-progress', runId, 'outcome.json');
  const deliveryPath = join(rootDir, 'dispatch', launchRequestId, 'hammer-progress', runId, 'closing-comment-delivered.json');
  const live = { number: prNumber, state: 'closed', merged: true, head: { sha: headSha },
    merge_commit_sha: mergeCommitSha, merged_at: mergedAt, base: { ref: 'main' } };
  const attempt = { launchRequestId, outcome: 'succeeded', reason: 'merged', attemptPhase: 'hammer-gh-pr-merge',
    validatedHead: headSha, mergeCommitSha, mergedAt, preMergeEligible: true, eligibilityTrace: { eligible: true },
    githubGate: { ok: true, expectedHead: headSha, liveHead: headSha }, mergeMethod: 'squash',
    localCiStatus: 'local-battery-skipped-github-required-gate-authoritative', remoteCiStatus: 'remote-ci-green',
    remediatedFindings: '1 addressed (0 blocking, 1 non-blocking)', rebaseAttempts: 0 };
  const proof = recordVerifiedHammerMerge({
    live: { state: 'MERGED', headRefOid: headSha, mergedAt, mergeCommit: { oid: mergeCommitSha } },
    headSha, executedAt: mergedAt, env,
  });
  const auditPath = amaAuditFilePath(rootDir, repo, prNumber, headSha);
  const writeAudit = patch => {
    rmSync(auditPath, { force: true });
    appendAmaAuditAttempt({ hqRoot: rootDir, ...identity, attempt: { ...attempt, ...patch } });
  };
  writeAudit();
  const writeProof = patch => writeFileSync(outcomePath, JSON.stringify({ ...proof, ...patch }));
  const comments = [];
  const calls = [];
  const github = async args => {
    calls.push(args);
    if (args[1] === `repos/${repo}/pulls/${prNumber}`) return live;
    if (args[1] === '--paginate') return [comments];
    if (args[1] === 'graphql') return { data: { viewer: author } };
    if (args[2] === 'POST') {
      const comment = { id: comments.length + 1, user: author, body: args.at(-1).slice(5) };
      comments.push(comment);
      return comment;
    }
    assert.fail(`Unexpected GitHub request ${args}`);
  };
  const deliver = overrides => deliverHammerClosingComment(params, { github, ...overrides });
  return { rootDir, params, identity, outcomePath, deliveryPath, live, auditPath, writeAudit, writeProof, comments, calls, github, deliver };
}

test('successful dispatch scratch retirement removes inputs before final comment delivery', async t => {
  const f = fixture(t);
  const promptDir = join(f.rootDir, 'prompts');
  const scratchDir = createHammerScratchDir(promptDir);
  const inputs = join(scratchDir, 'inputs.sh');
  writeFileSync(inputs, 'exit 97 # Closeout must never source this.\n');
  writeFileSync(join(scratchDir, 'close-result.json'), '{"status":0,"outcome":"merged"}');
  updateAmaCloserDispatchRecord(f.rootDir, f.identity, () => ({ ...f.identity,
    state: 'dispatched', launchRequestId, lastObservedStatus: 'running', promptDir, scratchDir }));
  assert.equal(existsSync(inputs), true);
  updateAmaCloserDispatchRecord(f.rootDir, f.identity, current => ({ ...current, outcome: 'succeeded' }));
  assert.equal(existsSync(scratchDir), false);
  assert.equal(existsSync(f.outcomePath), true);
  assert.equal(existsSync(f.auditPath), true);
  // Even a stale shell's scratch exports cannot affect delivery.
  Object.assign(f.params.env, { TMPDIR: scratchDir, HAM_RUN_DIR: scratchDir });
  f.comments.push({ id: 1, user: { login: 'someone-else' }, body: closingMarker },
    { id: 2, user: author, body: ['<!-- hq:ham-terminal-remediation:audit -->',
      'Doc-currency: updated; fixture runbook', `HAM-Validated-Head: ${headSha}`].join('\n') });

  assert.equal((await f.deliver()).outcome, 'posted');
  assert.deepEqual(JSON.parse(readFileSync(f.deliveryPath, 'utf8')), {
    schemaVersion: 1, repo, prNumber, launchRequestId, runId, headSha, mergeCommitSha, commentId: 3,
  });
  assert.equal((await f.deliver()).outcome, 'already-posted');
  assert.equal(f.calls.filter(args => args[2] === 'POST').length, 1);
  assert.match(f.comments[2].body, /Exact-head GitHub gate and HAM predicate: passed \(remote-ci-green\)/);
  assert.match(f.comments[2].body, /Doc-currency: updated; fixture runbook/);
  assert.match(f.comments[2].body, /Failing tests fixed: unrecorded/);
  assert.match(f.comments[2].body, new RegExp(`Merge commit: ${mergeCommitSha}`));
});

test('the close launcher calls the scratch-independent helper after a successful controller exit', t => {
  const f = fixture(t);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scratchDir = createHammerScratchDir(f.rootDir);
  const helper = join(f.rootDir, 'fake-node');
  writeFileSync(helper, `#!/bin/bash
case "\${1##*/}:$2" in
  hammer-close-plan.mjs:check|hammer-controller.mjs:resolve-environment) exit 0 ;;
  hammer-controller.mjs:run) rm -rf "$HAM_RUN_DIR" ;;
  hammer-closing-comment.mjs:fixture/repo)
    [ ! -e "$HAM_RUN_DIR/inputs.sh" ] && [ "$3" = 42 ] && [ "$4" = "$FIXTURE_ROOT" ] || exit 98
    printf '{"outcome":"posted"}\\n'
    ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(scratchDir, 'inputs.sh'), `
export HAM_RUN_DIR="$FIXTURE_SCRATCH" HAM_ROOT_DIR="$FIXTURE_REPO_ROOT" HAM_NODE_BIN="$FIXTURE_NODE"
export HAM_REPO=fixture/repo HAM_PR_NUMBER=42 HAM_HQ_ROOT="$FIXTURE_ROOT"
`);
  const result = spawnSync('/bin/bash', [join(root, 'bin/hammer-close.sh'), join(scratchDir, 'close-plan.json')], {
    env: { ...process.env, FIXTURE_SCRATCH: scratchDir, FIXTURE_REPO_ROOT: root, FIXTURE_NODE: helper, FIXTURE_ROOT: f.rootDir },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"outcome":"controller-shell-ended"/);
  assert.match(result.stdout, /HAM closing comment: \{"outcome":"posted"\}/);
});

for (const [description, alter, error] of [
  ['missing outcome receipt', f => rmSync(f.outcomePath), /merge-proof-unavailable/],
  ['foreign run', f => f.writeProof({ runId: 'wrun_other' }), /merge-proof-invalid/],
  ['foreign launch receipt', f => f.writeProof({ launchRequestId: 'lrq_other' }), /merge-proof-invalid/],
  ['conflicting launch environment', f => { f.params.env.LAUNCH_REQUEST_ID = 'lrq_other'; }, /unambiguous HQ launch/],
  ['missing native run identity', f => { delete f.params.env.HQ_WORKER_RUN_ID; }, /run-identity-unavailable/],
  ['someone else merged', f => f.writeProof({ proof: 'already-merged-by-other' }), /merge-proof-invalid/],
  ['missing audit', f => rmSync(f.auditPath), /merge-audit-unconfirmed/],
  ['foreign launch audit', f => f.writeAudit({ launchRequestId: 'lrq_other' }), /merge-audit-unconfirmed/],
  ['failed predicate', f => f.writeAudit({ eligibilityTrace: { eligible: false } }), /merge-audit-unconfirmed/],
  ['unknown gate', f => f.writeAudit({ githubGate: null }), /merge-audit-unconfirmed/],
  ['open PR', f => { f.live.state = 'open'; f.live.merged = false; }, /live-merge-unconfirmed/],
  ['closed without merge', f => { f.live.merged = false; }, /live-merge-unconfirmed/],
  ['different live head', f => { f.live.head.sha = 'c'.repeat(40); }, /live-merge-unconfirmed/],
  ['different merge commit', f => { f.live.merge_commit_sha = 'c'.repeat(40); }, /live-merge-unconfirmed/],
]) {
  test(`${description} cannot authorize a closing comment`, async t => {
    const f = fixture(t);
    alter(f);
    await assert.rejects(f.deliver(), error);
    assert.equal(f.calls.some(args => args[2] === 'POST'), false);
  });
}

test('unknown GitHub state, lease or comment lookup leaves delivery unconfirmed', async t => {
  const f = fixture(t);
  await assert.rejects(f.deliver({
    github: async () => { throw new Error('offline'); },
    sleep: () => assert.fail('permanent read failure should not retry'),
  }), /github-closeout-read-unavailable/);
  await assert.rejects(f.deliver({ inspectLease: () => ({ holder: { holderPr: prNumber } }) }), /lease-release-unconfirmed/);
  await assert.rejects(f.deliver({ inspectLease: () => null }), /lease-release-unconfirmed/);
  await assert.rejects(f.deliver({ github: async args => args[1] === '--paginate' ? { partial: [] } : f.github(args) }),
    /closing-comments-unreadable/);
  await assert.rejects(f.deliver({ github: async args => args[1] === 'graphql' ? {} : f.github(args) }),
    /closing-comment-author-unconfirmed/);
  assert.equal(f.calls.some(args => args[2] === 'POST'), false);
  assert.equal(existsSync(f.deliveryPath), false);
});

test('an ambiguous POST is reconciled by lookup before any replay', async t => {
  const f = fixture(t);
  await assert.rejects(f.deliver({ github: async args => {
    const result = await f.github(args);
    if (args[2] === 'POST') throw new Error('TLS handshake timeout after write');
    return result;
  } }), /closing-comment-delivery-unconfirmed/);
  assert.equal(existsSync(f.deliveryPath), false);
  assert.equal((await f.deliver()).outcome, 'already-posted');
  assert.equal(existsSync(f.deliveryPath), true);
  assert.equal(f.calls.filter(args => args[2] === 'POST').length, 1);
});

for (const [legacySha, outcome] of [
  [mergeCommitSha, 'already-posted'],
  [mergeCommitSha.slice(0, 7), 'already-posted'],
  [mergeCommitSha.slice(0, 12).toUpperCase(), 'already-posted'],
  [mergeCommitSha.slice(0, 13), 'posted'],
  [`x${mergeCommitSha.slice(0, 7)}`, 'posted'],
  [`${mergeCommitSha.slice(0, 7)}x`, 'posted'],
  ['c'.repeat(7), 'posted'],
]) {
  test(`legacy merge SHA token ${legacySha} yields ${outcome}`, async t => {
    const f = fixture(t);
    f.comments.push({ id: 1, user: author, body: `## ✅ Closed by Hammer\n\nMerged SHA: \`${legacySha}\`\n\nClosed-By: hammer (adversarial-pipe-mode)` });
    assert.equal((await f.deliver()).outcome, outcome);
    assert.equal(f.calls.some(args => args[2] === 'POST'), outcome === 'posted');
  });
}

test('the owner lane cannot authorize or suppress a closing comment', async t => {
  const f = fixture(t);
  const owner = { login: 'clio-airlock' };
  f.comments.push({ id: 1, user: owner, body: closingMarker });
  await assert.rejects(f.deliver({ github: args => args[1] === 'graphql'
    ? { data: { viewer: owner } } : f.github(args) }), /closing-comment-author-unconfirmed/);
  assert.equal(f.calls.some(args => args[2] === 'POST'), false);
  assert.equal((await f.deliver()).outcome, 'posted');
});

test('the outgoing closing comment filters recorded local paths', async t => {
  const f = fixture(t);
  f.writeAudit({ failingTestsFixed: `details at ${join(f.rootDir, 'validation.log')}` });
  await f.deliver();
  assert.match(f.comments[0].body, /Failing tests fixed: details at <local>\/validation\.log/);
  assert.equal(f.comments[0].body.includes(f.rootDir), false);
});

test('each GitHub read can retry a transient failure with backoff', async t => {
  const f = fixture(t);
  const readAttempts = new Map();
  const waits = [];
  const result = await f.deliver({
    github: async args => {
      if (args[2] === 'POST') return f.github(args);
      const prior = readAttempts.get(args[1]) || 0;
      readAttempts.set(args[1], prior + 1);
      if (prior === 0) throw new Error('TLS handshake timeout');
      return f.github(args);
    },
    sleep: ms => waits.push(ms),
  });
  assert.equal(result.outcome, 'posted');
  assert.deepEqual([...readAttempts.values()], [2, 2, 2]);
  assert.deepEqual(waits, [1_000, 1_000, 1_000]);
});

test('exhausted reads preserve pending evidence for post-launch recovery', async t => {
  const f = fixture(t);
  const waits = [];
  let reads = 0;
  await assert.rejects(f.deliver({
    github: async () => {
      reads += 1;
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' });
    },
    sleep: ms => waits.push(ms),
  }), /github-closeout-read-unavailable/);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(existsSync(f.outcomePath), true);
  assert.equal(existsSync(f.deliveryPath), false);

  const recover = recovery => deliverHammerClosingComment({ ...f.params, env: {}, recovery }, { github: f.github });
  await assert.rejects(recover({ launchRequestId, runId: 'wrun_other' }), /merge-proof-unavailable/);
  assert.equal((await recover({ launchRequestId, runId })).outcome, 'posted');
  assert.equal(existsSync(f.deliveryPath), true);
});

test('concurrent delivery for the same receipt cannot post twice', async t => {
  const f = fixture(t);
  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const first = f.deliver({ github: async args => { await pending; return f.github(args); } });
  try {
    await assert.rejects(f.deliver(), /delivery-lock-unavailable/);
  } finally { resume(); }
  assert.equal((await first).outcome, 'posted');
  assert.equal(f.calls.filter(args => args[2] === 'POST').length, 1);
});
