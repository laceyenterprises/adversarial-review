// Synthetic GitHub and exact-head gate boundaries for the rendered shell phases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCheckRollup } from '../../src/checks-summary.mjs';
import { evaluateMergeEligibility } from '../../src/ama/merge-eligibility.mjs';
import { publishPushedHammerAttestation } from '../../src/ama/hammer-pushed-attestation.mjs';
import { hammerRangeMatches } from '../../src/ama/hammer-head-validation.mjs';
import { legacyLaneWriteMain } from '../../bin/legacy-lane-write.mjs';
import { runLegacyLaneWrite } from '../../src/finalization/legacy-lane-write.mjs';

const dir = process.env.FIXTURE_DIR;
const path = join(dir, 'state.json');
const state = JSON.parse(readFileSync(path));
const save = () => writeFileSync(path, JSON.stringify(state));
const log = (kind, value) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ kind, value }) + '\n');
const git = (...args) => execFileSync(process.env.REAL_GIT, args, { encoding: 'utf8' }).trim();
const localHead = () => git('rev-parse', 'HEAD');
const args = process.argv.slice(2);
const retryScenario = process.env.SCENARIO.startsWith('ci-') || process.env.SCENARIO === 'prepredicate-base-retry';

if (args[0] === 'advance-base') {
  git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/main', state.nextBase, state.base);
  save();
} else if (args[0] === 'legacy') {
  // The rendered shell and real lane writer must share the advancing fixture
  // clock; mixing the synthetic shell deadline with wall time expires it.
  const laneArgs = args.slice(1);
  laneArgs[laneArgs.indexOf('--root') + 1] = dir;
  process.exitCode = await legacyLaneWriteMain(laneArgs, {
    run: options => runLegacyLaneWrite({ ...options,
      now: () => new Date(Number(readFileSync(join(dir, 'clock'), 'utf8')) * 1000).toISOString() }),
  });
} else if (args[0] === 'pushed') {
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
  // A stale BEHIND snapshot settles independently of update-branch.
  if (process.env.SCENARIO === 'no-op' && state.checkReads >= 2) state.behind = false;
  if (retryScenario && state.checkReads === 1) {
    assert.equal(existsSync(join(dir, 'lease-held')), false);
    // A synthetic daemon finishes during the lease-free wait and advances main.
    git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/main', state.nextBase, state.base);
    state.behind = true;
  }
  const retryReads = state.retried ? (state.retryReads = (state.retryReads || 0) + 1) : 0;
  const now = Number(readFileSync(join(dir, 'clock'), 'utf8'));
  if (state.retried && !state.retryStartedAt) state.retryStartedAt = now;
  const pending = (process.env.SCENARIO === 'prepredicate-timeout') ||
    (process.env.SCENARIO === 'prepredicate-green' && now < 1700000060) ||
    (state.retried && process.env.SCENARIO === 'ci-slow-green' && now - state.retryStartedAt < 300) ||
    (['pending', 'ci-clean-pending'].includes(process.env.SCENARIO) && state.checkReads === 1) ||
    (process.env.SCENARIO === 'ci-shared-deadline' && state.checkReads === 1) ||
    (retryScenario && state.retried && (retryReads === 1 || ['ci-pending', 'ci-shared-deadline'].includes(process.env.SCENARIO)));
  const red = state.retried && process.env.SCENARIO === 'ci-red';
  if (state.retried && process.env.SCENARIO === 'ci-head-moved') state.head = state.foreign;
  const checks = [{ name: 'fixture-test', status: pending ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: pending ? null : red ? 'FAILURE' : 'SUCCESS' }];
  const mergeStateStatus = process.env.SCENARIO.startsWith('ci-clean-') ? 'CLEAN' : state.behind ? 'BEHIND' : 'CLEAN';
  const mergeable = !state.retried && process.env.SCENARIO === 'ci-disjoint-conflict' ? 'CONFLICTING' : 'MERGEABLE';
  const verdict = evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true,
    requiredChecks: checks, branchProtectionRequired: process.env.HAM_BRANCH_PROTECTION_REQUIRED === 'true', mergeable,
    requiresUpToDateBranch: process.env.HAM_REQUIRES_UP_TO_DATE !== '0',
    mergeStateStatus, prState: 'OPEN', labels: [], candidateHead: state.head, validatedHead: expected });
  log('checks', { at: Number(readFileSync(join(dir, 'clock'), 'utf8')), head: expected, held: existsSync(join(dir, 'lease-held')), conclusion: classifyCheckRollup(checks) });
  save();
  console.log(JSON.stringify({ ok: verdict.eligible, reasons: verdict.reasons, state: 'OPEN',
    headMatches: state.head === expected, liveHead: state.head, expectedHead: expected,
    checksConclusion: classifyCheckRollup(checks), mergeable, mergeStateStatus }));
} else if (args[0] === 'initial-predicate') {
  const at = Number(readFileSync(join(dir, 'clock'), 'utf8'));
  if (process.env.SCENARIO === 'prepredicate-green') assert.ok(at >= 1700000060);
  assert.ok(existsSync(join(dir, 'lease-held')));
  log('initial-predicate', { at, head: state.head });
  console.log(JSON.stringify({ eligible: true,
    trace: { headMatch: { current: state.head }, branchProtection: { required: false } } }));
} else if (args[0] === 'predicate') {
  const claim = JSON.parse(readFileSync(args[args.indexOf('--ham-terminal-remediation') + 1]));
  assert.equal(claim.commit.sha, state.nextRebased);
  assert.deepEqual(claim.auditComment.findings, JSON.parse(readFileSync(join(dir, 'terminal-remediation.json'))).auditComment.findings,
    'retry must preserve the original blocking and non-blocking source findings');
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
    if (process.env.SCENARIO === 'conflict' || (state.checkReads && ['ci-conflict', 'ci-disjoint-conflict'].includes(process.env.SCENARIO))) {
      console.error('synthetic rebase conflict: resolve conflicts');
      process.exit(1);
    }
    const target = state.checkReads ? state.nextRebased : state.rebased;
    git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/topic', target, state.head);
    const previous = state.head;
    state.head = target;
    state.updateAcknowledged = true;
    state.visibilityReads = 0;
    if (state.checkReads) state.retried = true;
    if (state.retried && process.env.SCENARIO === 'ci-shared-deadline') {
      const clock = join(dir, 'clock');
      writeFileSync(clock, String(Number(readFileSync(clock, 'utf8')) + 60));
    }
    state.behind = false;
    save();
    console.log(JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: process.env.SCENARIO.includes('old-reply') ? previous : target } } } }));
  } else if (args[0] === 'pr' && args[1] === 'view') {
    if (args.includes('body,headRefOid,state,isDraft,labels,statusCheckRollup') &&
      (process.env.SCENARIO === 'lease-probe-exhausted' ||
        (process.env.SCENARIO === 'prepredicate-probe-exhausted' && state.checkReads))) {
      state.leaseProbeFailures = (state.leaseProbeFailures || 0) + 1;
      save();
      console.error('HTTP 502: synthetic lease probe failure');
      process.exit(1);
    }
    if (args.includes('id') && args.includes('--jq')) {
      state.idReads = (state.idReads || 0) + 1;
      if (state.checkReads && process.env.SCENARIO === 'ci-id-deadline') writeFileSync(join(dir, 'clock'), '1700000900');
      save();
      if (process.env.SCENARIO === 'id-exhausted' || process.env.SCENARIO === 'id-permanent' ||
        (process.env.SCENARIO === 'id-transient' && state.idReads === 1)) {
        console.error(process.env.SCENARIO === 'id-permanent' ? 'HTTP 403: Forbidden' : 'HTTP 502: Bad Gateway');
        process.exit(1);
      }
      console.log('synthetic-pr'); process.exit(0);
    }
    if (args.includes('number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName') &&
      ((process.env.SCENARIO.startsWith('snapshot-') && process.env.SCENARIO !== 'snapshot-lag' && state.head === state.rebased) ||
        (process.env.SCENARIO.startsWith('ci-snapshot-') && state.retried))) {
      state.snapshotReads = (state.snapshotReads || 0) + 1;
      save();
      if (!process.env.SCENARIO.endsWith('transient') || state.snapshotReads === 1) {
        state.snapshotFailures = (state.snapshotFailures || 0) + 1;
        save();
        console.error(process.env.SCENARIO.endsWith('permanent')
          ? 'HTTP 403: Forbidden' : 'HTTP 502: synthetic post-rebase snapshot failure');
        process.exit(1);
      }
    }
    if (state.updateAcknowledged && args.includes('number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName') &&
      (process.env.SCENARIO.includes('old-reply') || process.env.SCENARIO === 'snapshot-lag')) {
      state.visibilityReads = (state.visibilityReads || 0) + 1;
      save();
      if (process.env.SCENARIO === 'old-reply-never' || state.visibilityReads === 1) {
        console.log(JSON.stringify({ headRefOid: state.retried ? state.rebased : state.original, baseRefName: 'main', state: 'OPEN' }));
        process.exit(0);
      }
      if (process.env.SCENARIO === 'old-reply-foreign') { state.head = state.foreign; save(); }
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
      state: state.merged ? 'MERGED' : state.checkReads && process.env.SCENARIO === 'ci-closed' ? 'CLOSED' : 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
      mergeStateStatus: state.behind ? 'BEHIND' : 'CLEAN', labels: state.checkReads && process.env.SCENARIO === 'ci-canceled' ? [{ name: 'no-merge-hold' }] : [], statusCheckRollup: [],
      mergedAt: state.merged ? '2026-01-01T00:00:00Z' : null, mergeCommit: { oid: state.base } }));
  } else if (args[0] === 'api' && args.includes('graphql')) {
    console.log(JSON.stringify({ login: 'hammer-worker', databaseId: 77 }));
  } else if (args[0] === 'api' && args.some(arg => arg.endsWith('required_status_checks'))) {
    console.log(JSON.stringify({ strict: !['initial-disjoint', 'ci-disjoint', 'ci-disjoint-conflict', 'ci-disjoint-lease-delay'].includes(process.env.SCENARIO) }));
  } else if (args[0] === 'api' && args.some(arg => arg.includes('/commits/'))) {
    console.log(JSON.stringify({ sha: state.head, parents: [{ sha: state.nextBase }] }));
  } else if (args[0] === 'api' && args.includes('--paginate')) {
    console.log('[]');
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    if (process.env.SCENARIO.startsWith('capped-')) {
      assert.equal(existsSync(join(dir, 'lease-held')), false);
      assert.match(args[args.indexOf('--body') + 1], /HAM closing status/);
      process.exit(0);
    }
    assert.equal(localHead(), state.head);
    assert.ok(existsSync(join(dir, 'lease-held')));
    const body = args[args.indexOf('--body') + 1];
    assert.ok(body.includes(`HAM-Validated-Head: ${state.head}`));
    appendFileSync(join(dir, 'comments'), body + '\n');
    state.publishedBody = body;
    save();
  } else if (args[0] === 'pr' && args[1] === 'merge') {
    assert.equal(args[args.indexOf('--match-head-commit') + 1], state.retried ? state.nextRebased : state.rebased);
    if (retryScenario && !process.env.SCENARIO.startsWith('ci-clean-') && !['ci-disjoint', 'ci-disjoint-lease-delay'].includes(process.env.SCENARIO)) assert.ok(state.retryReads >= 2, 'new exact head must pass checks');
    assert.ok(state.checkReads >= (process.env.SCENARIO === 'pending' ? 2 : 1), 'must read exact-head checks');
    assert.ok(existsSync(join(dir, 'lease-held')));
    if (['server-base-conflict', 'server-stable-conflict', 'server-base-auth'].includes(process.env.SCENARIO)) {
      if (process.env.SCENARIO !== 'server-stable-conflict') {
        git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/main', state.nextBase, state.base);
      }
      console.error(process.env.SCENARIO === 'server-base-auth' ? 'HTTP 403: Forbidden' : 'Pull request is not mergeable: server rebase conflict');
      process.exit(1);
    }
    state.merged = true;
    save();
  } else throw new Error(`unexpected fake gh call: ${JSON.stringify(args)}`);
} else throw new Error(`unexpected fixture mode: ${args[0]}`);
