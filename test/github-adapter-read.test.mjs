import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ADAPTER_READ_COMMANDS, __test__, readAdapterHeadAndState,
  readAdapterIssueComments, readAdapterReviewContext, readAdapterReviewBodiesForHead,
  readAdapterLatestLabelEvent, withGitHubAdapterReadTick } from '../src/github-adapter-client.mjs';
import { fetchPullRequestHeadAndState, fetchReviewBodiesForHead, fetchPullRequestRollup } from '../src/github-api.mjs';

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/github-adapter/read-cli.mjs', import.meta.url));
const repo = 'fixture/project';
const env = { GHA_ADAPTER_BIN: '/fixture/adapter' };
const params = { repo, prNumber: 7, headSha: 'synthetic-head', reviewerLogins: ['fixture-reviewer'],
  currentHeadSha: 'synthetic-head', labelName: 'fixture-label', withLabels: false, limit: 10,
  head: 'synthetic-branch', ticket: 'ADAPTERREAD-01', graphql: false };
function fixtureOptions({ unsupported = '', fallback = null } = {}) {
  const calls = [];
  return { calls, env, execFileImpl: async (bin, args, options) => {
    calls.push({ bin, args });
    if (bin === 'gh' && fallback) return fallback(args);
    assert.equal(bin, env.GHA_ADAPTER_BIN);
    return exec(process.execPath, [fixture, unsupported, ...args], options);
  } };
}

test('every read kind uses the documented subcommand and flags', async () => {
  const expected = {
    'pr-state': ['--repo', repo, '--number', '7'],
    'pr-reviews': ['--repo', repo, '--number', '7'],
    'issue-comments': ['--repo', repo, '--number', '7'],
    labels: ['--repo', repo, '--number', '7'],
    'check-rollup': ['--repo', repo, '--number', '7'],
    'label-events': ['--repo', repo, '--number', '7', '--label', 'fixture-label'],
    'prs-by-head': ['--repo', repo, '--head', 'synthetic-branch'],
    'search-merged-prs': ['--repo', repo, '--ticket', 'ADAPTERREAD-01', '--no-graphql'],
    'rate-limit': [],
  };
  const options = fixtureOptions();
  assert.deepEqual(ADAPTER_READ_COMMANDS, {
    'pull-request': 'pr-state', 'pull-request-head-state': 'pr-state',
    'pull-request-rollup': 'pr-state', 'pull-request-review-context': 'pr-state',
    'pull-request-review-bodies-for-head': 'pr-reviews', 'latest-label-event': 'label-events',
    ...Object.fromEntries(Object.keys(expected).map(command => [command, command])),
  });
  for (const [kind, command] of Object.entries(ADAPTER_READ_COMMANDS)) {
    assert.deepEqual(__test__.makeAdapterArgs(kind, params), [command, '--json', ...expected[command]]);
    assert.equal((await __test__.runGitHubAdapter(kind, params, options)).ok, true);
  }
  assert.ok(Object.isFrozen(ADAPTER_READ_COMMANDS));
});

test('real fixture subcommands serve reads without falling back', async () => {
  const options = fixtureOptions();
  assert.equal((await readAdapterHeadAndState(repo, 7, options)).headRefOid, 'synthetic-head');
  assert.equal((await readAdapterIssueComments(repo, 7, options))[0].body, 'Synthetic comment');
  const context = await readAdapterReviewContext(repo, 7, options);
  assert.equal(context.number, 7);
  assert.equal(context.comments[0].author.login, 'fixture-author');
  assert.equal(context.comments[0].authorAssociation, 'MEMBER');
  assert.equal(context.comments[0].authorType, 'Bot');
  assert.equal((await readAdapterReviewBodiesForHead(repo, 7, 'synthetic-head', options))[0].commitId, 'synthetic-head');
  const event = await readAdapterLatestLabelEvent(repo, 7, 'fixture-label', { ...options, currentHeadSha: 'synthetic-head' });
  assert.equal(event.actor.login, 'fixture-operator');
  assert.equal(await readAdapterLatestLabelEvent(repo, 7, 'fixture-label', { ...options, currentHeadSha: 'different-head' }), null);
  assert.equal((await fetchPullRequestHeadAndState(repo, 7, { ...options, recordApiCallImpl() {} })).state, 'open');
  assert.deepEqual(await fetchReviewBodiesForHead(options.execFileImpl, repo, 7, 'synthetic-head', {
    env, authoritativeReviewerLogins: ['fixture-reviewer'], recordApiCallImpl() {},
  }), ['Synthetic review']);
  assert.deepEqual(await fetchReviewBodiesForHead(options.execFileImpl, repo, 7, 'different-head', {
    env, authoritativeReviewerLogins: ['fixture-reviewer'], recordApiCallImpl() {},
  }), []);
  assert.deepEqual(await fetchReviewBodiesForHead(options.execFileImpl, repo, 7, 'synthetic-head', {
    env, authoritativeReviewerLogins: ['different-reviewer'], recordApiCallImpl() {},
  }), []);
  assert.ok(options.calls.every(call => call.bin === env.GHA_ADAPTER_BIN));
});

test('an older adapter falls back once per subcommand per tick and retries next tick', async () => {
  const warnings = [];
  const options = fixtureOptions({ unsupported: 'pr-reviews', fallback: () => ({ stdout: '[]' }) });
  const readReviews = () => fetchReviewBodiesForHead(options.execFileImpl, repo, 7, 'synthetic-head', {
    env, recordApiCallImpl() {},
  });
  for (let tick = 0; tick < 2; tick++) {
    await withGitHubAdapterReadTick(async () => {
      assert.deepEqual(await readReviews(), []);
      assert.deepEqual(await readReviews(), []);
      assert.equal((await readAdapterHeadAndState(repo, 7, options)).state, 'OPEN');
      assert.equal((await readAdapterIssueComments(repo, 7, options)).length, 1);
    }, { logger: { warn: message => warnings.push(message) } });
  }
  assert.equal(options.calls.filter(call => call.args[0] === 'pr-reviews').length, 2);
  assert.equal(options.calls.filter(call => call.bin === 'gh').length, 4);
  assert.equal(warnings.length, 2);
});

test('unsupported unmapped kinds are isolated and incomplete reads are never cached as unsupported', async () => {
  const options = fixtureOptions();
  await withGitHubAdapterReadTick(async () => {
    await assert.rejects(__test__.runGitHubAdapter('future-kind', { repo }, options));
    assert.equal(await __test__.runGitHubAdapter('future-kind', { repo }, options), null);
    assert.equal((await readAdapterHeadAndState(repo, 7, options)).state, 'OPEN');
  }, { logger: { warn() {} } });
  let attempts = 0;
  await withGitHubAdapterReadTick(async () => {
    for (let i = 0; i < 2; i++) await assert.rejects(readAdapterIssueComments(repo, 7, {
      env, execFileImpl: async () => { attempts++; return { stdout: '{"ok":true,"complete":false,"comments":[]}' }; },
    }), /incomplete/);
  });
  assert.equal(attempts, 2);
});

test('pr-state without mergeability keeps the established full rollup fallback', async () => {
  const options = fixtureOptions({ fallback: () => ({ stdout: JSON.stringify({ data: { repository: {
    pullRequest: { number: 7, headRefOid: 'synthetic-head', state: 'OPEN',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { contexts: { nodes: [{ name: 'build', conclusion: 'SUCCESS' }] } } },
  } } }) }) });
  const result = await fetchPullRequestRollup(repo, 7, { ...options, recordApiCallImpl() {} });
  assert.equal(result.mergeable, 'MERGEABLE');
  assert.equal(options.calls[0].args[0], 'pr-state');
  assert.equal(options.calls[1].bin, 'gh');
});
