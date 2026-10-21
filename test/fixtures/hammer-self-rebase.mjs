// Synthetic GitHub and exact-head gate boundaries for the rendered shell phases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCheckRollup } from '../../src/checks-summary.mjs';
import { evaluateMergeEligibility } from '../../src/ama/merge-eligibility.mjs';

const dir = process.env.FIXTURE_DIR;
const path = join(dir, 'state.json');
const state = JSON.parse(readFileSync(path));
const save = () => writeFileSync(path, JSON.stringify(state));
const log = (kind, value) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ kind, value }) + '\n');
const git = (...args) => execFileSync(process.env.REAL_GIT, args, { encoding: 'utf8' }).trim();
const localHead = () => git('rev-parse', 'HEAD');
const args = process.argv.slice(2);

if (args[0] === 'gate') {
  const expected = process.env.POST_REMEDIATION_SHA;
  assert.equal(expected, state.rebased);
  assert.equal(localHead(), expected);
  assert.equal(readFileSync(join(dir, 'validated-head'), 'utf8').trim(), expected);
  state.checkReads = (state.checkReads || 0) + 1;
  const pending = process.env.SCENARIO === 'pending' && state.checkReads === 1;
  const checks = [{ name: 'fixture-test', status: pending ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: pending ? null : 'SUCCESS' }];
  const verdict = evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true,
    requiredChecks: checks, branchProtectionRequired: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', prState: 'OPEN', labels: [], candidateHead: state.head, validatedHead: expected });
  log('checks', { head: expected, conclusion: classifyCheckRollup(checks) });
  save();
  console.log(JSON.stringify({ ok: verdict.eligible, reasons: verdict.reasons, state: 'OPEN',
    headMatches: state.head === expected, liveHead: state.head, expectedHead: expected,
    checksConclusion: classifyCheckRollup(checks), mergeable: true, notBehind: true }));
} else if (args[0] === 'range') {
  console.log(JSON.stringify({ verified: true, reviewedHead: state.original, currentHead: state.rebased,
    baseSha: state.original, commits: [state.rebased] }));
} else if (args[0] === 'gh') {
  args.shift();
  log('gh', args);
  if (args[0] === 'pr' && args[1] === 'update-branch') {
    assert.ok(args.includes('--rebase'));
    assert.equal(localHead(), state.head);
    assert.ok(existsSync(join(dir, 'lease-held')));
    if (process.env.SCENARIO === 'conflict') {
      console.error('synthetic rebase conflict: resolve conflicts');
      process.exit(1);
    }
    git('--git-dir', join(dir, 'remote.git'), 'update-ref', 'refs/heads/topic', state.rebased, state.original);
    state.head = state.rebased;
    state.behind = false;
    save();
  } else if (args[0] === 'pr' && args[1] === 'view') {
    if (args.includes('headRefOid') && args.includes('--jq')) {
      state.headReads = (state.headReads || 0) + 1;
      if (process.env.SCENARIO === 'foreign-recovery' && state.headReads > 1) state.head = state.foreign;
      save();
      console.log(state.head);
    } else if (args.includes('body')) console.log('Synthetic change.');
    else if (args.includes('title')) console.log('Repair synthetic surface');
    else console.log(JSON.stringify({ number: 42, headRefOid: state.head, baseRefName: 'main',
      state: state.merged ? 'MERGED' : 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
      mergeStateStatus: state.behind ? 'BEHIND' : 'CLEAN', labels: [], statusCheckRollup: [],
      mergedAt: state.merged ? '2026-01-01T00:00:00Z' : null, mergeCommit: { oid: state.base } }));
  } else if (args[0] === 'api' && args.includes('graphql')) {
    console.log(JSON.stringify({ login: 'hammer-worker', databaseId: 77 }));
  } else if (args[0] === 'api' && args.some(arg => arg.endsWith('required_status_checks'))) {
    console.log('{"strict":true}');
  } else if (args[0] === 'api' && args.includes('--paginate')) {
    console.log('[]');
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    assert.equal(localHead(), state.rebased);
    assert.ok(existsSync(join(dir, 'lease-held')));
    const body = args[args.indexOf('--body') + 1];
    assert.ok(body.includes(`HAM-Validated-Head: ${state.rebased}`));
    appendFileSync(join(dir, 'comments'), body + '\n');
  } else if (args[0] === 'pr' && args[1] === 'merge') {
    assert.equal(args[args.indexOf('--match-head-commit') + 1], state.rebased);
    assert.equal(state.head, state.rebased);
    assert.ok(state.checkReads >= (process.env.SCENARIO === 'pending' ? 2 : 1), 'must read exact-head checks');
    assert.ok(existsSync(join(dir, 'lease-held')));
    state.merged = true;
    save();
  } else throw new Error(`unexpected fake gh call: ${JSON.stringify(args)}`);
} else throw new Error(`unexpected fixture mode: ${args[0]}`);
