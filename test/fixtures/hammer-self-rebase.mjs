// Synthetic GitHub and exact-head gate boundaries for the rendered shell phases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCheckRollup } from '../../src/checks-summary.mjs';
import { evaluateMergeEligibility } from '../../src/ama/merge-eligibility.mjs';
import { publishPushedHammerAttestation } from '../../src/ama/hammer-pushed-attestation.mjs';
import { hammerRangeMatches } from '../../src/ama/hammer-head-validation.mjs';

const dir = process.env.FIXTURE_DIR;
const path = join(dir, 'state.json');
const state = JSON.parse(readFileSync(path));
const save = () => writeFileSync(path, JSON.stringify(state));
const log = (kind, value) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ kind, value }) + '\n');
const git = (...args) => execFileSync(process.env.REAL_GIT, args, { encoding: 'utf8' }).trim();
const localHead = () => git('rev-parse', 'HEAD');
const args = process.argv.slice(2);
const retryScenario = process.env.SCENARIO.startsWith('ci-');

if (args[0] === 'pushed') {
  const [baseHead, pushedHead] = args.slice(-2);
  assert.equal(pushedHead, state.head);
  await publishPushedHammerAttestation({ repo: 'fixture/repo', prNumber: 42, baseHead, pushedHead,
    api: async (endpoint, input) => {
      if (endpoint === 'graphql') return { data: { viewer: { login: 'hammer-worker' } } };
      if (!input) return [];
      assert.ok(!input.body.includes('HAM-Validated-Head:'));
      appendFileSync(join(dir, 'pushed-comments'), input.body + '\n');
      log('pushed-edge', { baseHead, pushedHead });
      return { id: 42 };
    } });
} else if (args[0] === 'gate') {
  const expected = process.env.POST_REMEDIATION_SHA;
  assert.equal(expected, state.retried ? state.nextRebased : state.rebased);
  assert.equal(localHead(), expected);
  if (!state.retried) assert.equal(readFileSync(join(dir, 'validated-head'), 'utf8').trim(), expected);
  state.checkReads = (state.checkReads || 0) + 1;
  if (retryScenario && state.checkReads === 1) {
    assert.equal(existsSync(join(dir, 'lease-held')), false);
    // A synthetic daemon finishes during the lease-free wait and advances main.
    git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/main', state.nextBase, state.base);
    state.behind = true;
  }
  const retryReads = state.retried ? (state.retryReads = (state.retryReads || 0) + 1) : 0;
  const pending = (process.env.SCENARIO === 'pending' && state.checkReads === 1) ||
    (process.env.SCENARIO === 'ci-shared-deadline' && state.checkReads === 1) ||
    (retryScenario && state.retried && (retryReads === 1 || ['ci-pending', 'ci-shared-deadline'].includes(process.env.SCENARIO)));
  const red = state.retried && process.env.SCENARIO === 'ci-red';
  if (state.retried && process.env.SCENARIO === 'ci-head-moved') state.head = state.foreign;
  const checks = [{ name: 'fixture-test', status: pending ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: pending ? null : red ? 'FAILURE' : 'SUCCESS' }];
  const verdict = evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true,
    requiredChecks: checks, branchProtectionRequired: false, mergeable: 'MERGEABLE',
    mergeStateStatus: !state.retried && process.env.SCENARIO === 'ci-strict-behind' ? 'BEHIND' : 'CLEAN', prState: 'OPEN', labels: [], candidateHead: state.head, validatedHead: expected });
  log('checks', { head: expected, held: existsSync(join(dir, 'lease-held')), conclusion: classifyCheckRollup(checks) });
  save();
  console.log(JSON.stringify({ ok: verdict.eligible, reasons: verdict.reasons, state: 'OPEN',
    headMatches: state.head === expected, liveHead: state.head, expectedHead: expected,
    checksConclusion: classifyCheckRollup(checks), mergeable: 'MERGEABLE', mergeStateStatus: !state.retried && process.env.SCENARIO === 'ci-strict-behind' ? 'BEHIND' : 'CLEAN' }));
} else if (args[0] === 'predicate') {
  const claim = JSON.parse(readFileSync(args[args.indexOf('--ham-terminal-remediation') + 1]));
  assert.equal(claim.commit.sha, state.nextRebased);
  assert.equal(claim.auditComment.body, state.publishedBody,
    'retry predicate must use the audit body produced by retry publication');
  assert.ok(state.publishedBody.includes(state.nextRebased));
  const range = JSON.parse(readFileSync(args[args.indexOf('--ham-range') + 1]));
  assert.equal(hammerRangeMatches(range, state.original, state.nextRebased), true,
    'retry predicate must receive fresh exact-head range evidence');
  assert.ok(range.commits.includes(state.nextRebased));
  log('predicate', state.nextRebased);
  console.log(JSON.stringify({ eligible: process.env.SCENARIO !== 'ci-predicate-refused',
    trace: { headMatch: { current: state.nextRebased }, branchProtection: { required: false } } }));
} else if (args[0] === 'range') {
  assert.deepEqual(args.slice(2), ['fixture/repo', state.original, state.head, '--pr', 'https://github.com/fixture/repo/pull/42']);
  log('range', state.head);
  if (state.retried && process.env.SCENARIO === 'ci-range-unavailable') {
    console.error('synthetic retry range proof unavailable');
    process.exit(65);
  }
  console.log(JSON.stringify({ verified: true, reviewedHead: state.original, currentHead: state.head,
    baseSha: state.original, commits: [state.head] }));
} else if (args[0] === 'gh') {
  args.shift();
  log('gh', args);
  if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => arg.includes('updatePullRequestBranch'))) {
    assert.ok(args.some(arg => arg.includes('updateMethod: REBASE')));
    assert.ok(args.includes(`head=${state.head}`));
    assert.ok(args.includes('id=synthetic-pr'));
    assert.equal(localHead(), state.head);
    assert.ok(existsSync(join(dir, 'lease-held')));
    if (process.env.SCENARIO === 'conflict' || (state.checkReads && process.env.SCENARIO === 'ci-conflict')) {
      console.error('synthetic rebase conflict: resolve conflicts');
      process.exit(1);
    }
    const target = state.checkReads ? state.nextRebased : state.rebased;
    git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/topic', target, state.head);
    state.head = target;
    if (state.checkReads) state.retried = true;
    if (state.retried && process.env.SCENARIO === 'ci-shared-deadline') {
      const clock = join(dir, 'clock');
      writeFileSync(clock, String(Number(readFileSync(clock, 'utf8')) + 60));
    }
    state.behind = false;
    save();
    console.log(JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: target } } } }));
  } else if (args[0] === 'pr' && args[1] === 'view') {
    if (args.includes('id') && args.includes('--jq')) {
      state.idReads = (state.idReads || 0) + 1;
      save();
      if (process.env.SCENARIO === 'id-exhausted' || process.env.SCENARIO === 'id-permanent' ||
        (process.env.SCENARIO === 'id-transient' && state.idReads === 1)) {
        console.error(process.env.SCENARIO === 'id-permanent' ? 'HTTP 403: Forbidden' : 'HTTP 502: Bad Gateway');
        process.exit(1);
      }
      console.log('synthetic-pr'); process.exit(0);
    }
    if (args.includes('number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName') &&
      ((process.env.SCENARIO === 'snapshot-failed' && state.head === state.rebased) ||
        (process.env.SCENARIO === 'ci-snapshot-failed' && state.retried))) {
      console.error('HTTP 502: synthetic post-rebase snapshot failure');
      process.exit(1);
    }
    if (process.env.SCENARIO === 'foreign-after-rebase' && state.behind === false) {
      state.head = state.foreign; save();
    }
    if (args.includes('headRefOid') && args.includes('--jq')) {
      state.headReads = (state.headReads || 0) + 1;
      if (process.env.SCENARIO === 'foreign-recovery' && state.headReads > 1) state.head = state.foreign;
      save();
      console.log(state.head);
    } else if (args.includes('body')) console.log('Synthetic change.');
    else if (args.includes('reviews')) console.log('{"reviews":[]}');
    else if (args.includes('title')) console.log('Repair synthetic surface');
    else console.log(JSON.stringify({ number: 42, headRefOid: state.head, baseRefName: 'main',
      state: state.merged ? 'MERGED' : 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
      mergeStateStatus: state.behind ? 'BEHIND' : 'CLEAN', labels: [], statusCheckRollup: [],
      mergedAt: state.merged ? '2026-01-01T00:00:00Z' : null, mergeCommit: { oid: state.base } }));
  } else if (args[0] === 'api' && args.includes('graphql')) {
    console.log(JSON.stringify({ login: 'hammer-worker', databaseId: 77 }));
  } else if (args[0] === 'api' && args.some(arg => arg.endsWith('required_status_checks'))) {
    console.log(JSON.stringify({ strict: process.env.SCENARIO !== 'ci-disjoint' }));
  } else if (args[0] === 'api' && args.some(arg => arg.includes('/commits/'))) {
    console.log(JSON.stringify({ sha: state.head, parents: [{ sha: state.nextBase }] }));
  } else if (args[0] === 'api' && args.includes('--paginate')) {
    console.log('[]');
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    assert.equal(localHead(), state.head);
    assert.ok(existsSync(join(dir, 'lease-held')));
    const body = args[args.indexOf('--body') + 1];
    assert.ok(body.includes(`HAM-Validated-Head: ${state.head}`));
    appendFileSync(join(dir, 'comments'), body + '\n');
    state.publishedBody = body;
    save();
  } else if (args[0] === 'pr' && args[1] === 'merge') {
    assert.equal(args[args.indexOf('--match-head-commit') + 1], state.retried ? state.nextRebased : state.rebased);
    if (retryScenario) assert.ok(state.retryReads >= 2, 'new exact head must pass checks');
    assert.ok(state.checkReads >= (process.env.SCENARIO === 'pending' ? 2 : 1), 'must read exact-head checks');
    assert.ok(existsSync(join(dir, 'lease-held')));
    state.merged = true;
    save();
  } else throw new Error(`unexpected fake gh call: ${JSON.stringify(args)}`);
} else throw new Error(`unexpected fixture mode: ${args[0]}`);
