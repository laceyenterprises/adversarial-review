import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactHammerValidation, fetchHammerHeadRange, fleetCommitIdentityMatches, hammerAttestationChain, readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';

const fleet = sha => ({ sha, author: { login: 'lacey-codex-agent[bot]' }, committer: { login: 'web-flow' },
  commit: { verification: { verified: true, reason: 'valid' } } });
function fixture(commits, overrides = {}) {
  const calls = [];
  const compare = { status: 'ahead', commits, total_commits: commits.length };
  return { calls, options: { repo: 'example/repo', reviewedHead: 'reviewed', currentHead: 'head',
    env: {}, get: async path => {
      calls.push(path);
      path = path.split('?')[0];
      if (path.endsWith('/commits/main')) return { sha: 'base' };
      if (path.endsWith('reviewed...head')) return compare;
      if (path.endsWith('base...head')) return { ...compare, ...overrides };
      if (path.endsWith('base-parent...base')) return { status: 'ahead' };
      throw new Error(`unexpected ${path}`);
    } } };
}
test('HAMFINAL-02: remediation and hammer commits need no reviewed-head trailer', async () => {
  const hammer = { ...fleet('head'), author: 'hammer-worker', committer: 'web-flow' };
  const { options } = fixture([fleet('remediation'), hammer]);
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
});
test('HAMFINAL-02: foreign side commit is refused even with a trusted hammer tip', async () => {
  const foreign = { ...fleet('foreign'), committer: 'unverified-person' };
  assert.equal(await fetchHammerHeadRange(fixture([foreign, fleet('head')]).options), null);
});
test('HAMFINAL-02: spoofed fleet logins require a strictly verified signature', async () => {
  assert.equal(fleetCommitIdentityMatches(fleet('head')), true);
  for (const verification of [undefined, {}, { verified: false }, { verified: 'true' }]) {
    const spoof = { ...fleet('spoof'), commit: { verification } };
    assert.equal(fleetCommitIdentityMatches(spoof), false);
    assert.equal(await fetchHammerHeadRange(fixture([spoof, fleet('head')]).options), null);
  }
  assert.equal(fleetCommitIdentityMatches({ ...fleet('head'), commit: undefined }), false);
  assert.equal(fleetCommitIdentityMatches({ ...fleet('head'), author: 'foreign' }), false);
});
test('HAMFINAL-02: unsigned spoofed base merges cannot bypass signature verification', async () => {
  const merge = { ...fleet('head'), commit: { verification: { verified: false } },
    parents: [{ sha: 'fleet' }, { sha: 'base-parent' }] };
  assert.equal(await fetchHammerHeadRange(fixture([fleet('fleet'), merge]).options), null);
});
test('HAMFINAL-02: GitHub-signed base merge is permitted; foreign side merge is refused', async () => {
  const merge = { ...fleet('merge'), author: 'human', parents: [{ sha: 'fleet' }, { sha: 'base-parent' }] };
  const { options } = fixture([fleet('fleet'), merge, fleet('head')]);
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
  const get = options.get;
  assert.equal(await fetchHammerHeadRange({ ...options, get: path => path.endsWith('base-parent...base')
    ? { status: 'diverged' } : get(path) }), null);
});
test('HAMFINAL-02: locally signed human base merges cannot inject unreviewed edits', async () => {
  const merge = { ...fleet('merge'), author: 'human', committer: { login: 'human' },
    parents: [{ sha: 'fleet' }, { sha: 'base-parent' }] };
  const f = fixture([fleet('fleet'), merge, fleet('head')]);
  assert.equal(await fetchHammerHeadRange(f.options), null);
  assert.ok(!f.calls.some(path => path.endsWith('base-parent...base')));
  assert.equal(await fetchHammerHeadRange(fixture([{ ...merge, committer: { login: 'web-flow' },
    commit: { verification: { verified: true, reason: 'unknown_key' } } }, fleet('head')]).options), null);
});
test('HAMFINAL-02: incomplete comparisons fail closed', async () => {
  assert.equal(await fetchHammerHeadRange(fixture([fleet('head')], { total_commits: 251 }).options), null);
});
test('HAMFINAL-02: validation is exact-head and entitled-author bound', () => {
  const comment = { body: 'HAM-Validated-Head: head', author: 'hammer-worker' };
  assert.equal(exactHammerValidation(comment, 'head'), true);
  assert.equal(exactHammerValidation(comment, 'other'), false);
  assert.equal(exactHammerValidation({ ...comment, author: 'builder' }, 'head'), false);
});

test('HAMFINAL-02: reviewed history is outside the responsibility range; later foreign identities are refused', async () => {
  const old = { sha: 'reviewed', author: 'unverified-person', committer: 'unverified-person' };
  const current = fleet('head');
  const { options } = fixture([current], { commits: [old, current], total_commits: 2 });
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
  const operator = { ...fleet('head'), author: 'clio-airlock', committer: 'clio-airlock' };
  assert.equal(await fetchHammerHeadRange(fixture([operator]).options), null);
});

test('HAMFINAL-02: complete paginated fleet histories are validated beyond the first API page', async () => {
  const all = Array.from({ length: 260 }, (_, index) => fleet(index === 259 ? 'head' : `fleet-${index}`));
  const range = await fetchHammerHeadRange({ repo: 'example/repo', reviewedHead: 'reviewed', currentHead: 'head', env: {},
    get: async path => {
      if (path.endsWith('/commits/main')) return { sha: 'base' };
      const page = Number(new URL(`https://fixture/${path}`).searchParams.get('page'));
      return { status: 'ahead', total_commits: all.length,
        commits: page ? all.slice((page - 1) * 100, page * 100) : all.slice(0, 250) };
    } });
  assert.equal(range.verified, true);
  assert.equal(range.commits.length, 260);
});

for (const damage of ['invalid JSON', 'empty file', 'unreadable file', 'invalid job shape']) {
  test(`HAMCLOSE-05: ${damage} cannot discard other completed jobs' round proofs`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'completed-remediation-rounds-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'data', 'follow-up-jobs', 'completed');
    mkdirSync(dir, { recursive: true });
    const rounds = [
      { state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'round1' },
      { state: 'completed', startHeadSha: 'round1', resultingHeadSha: 'head' },
    ];
    const job = { repo: 'fixture/repo', prNumber: 1, status: 'completed', remediationPlan: { rounds: [
      rounds[0], { state: 'spawned', startHeadSha: 'reviewed', resultingHeadSha: 'unfinished' },
      { state: 'completed', startHeadSha: 'reviewed' },
    ] } };
    const prefix = 'fixture__repo-pr-1-';
    writeFileSync(join(dir, `${prefix}10-valid.json`), JSON.stringify(job));
    writeFileSync(join(dir, `${prefix}20-valid.json`), JSON.stringify({ ...job, remediationPlan: { rounds: [rounds[1]] } }));
    // Damage both before and after valid records so no scan ordering can hide it.
    for (const suffix of ['00-damaged.json', '99-damaged.json']) {
      const name = `${prefix}${suffix}`;
      if (damage === 'unreadable file') mkdirSync(join(dir, name));
      else writeFileSync(join(dir, name), damage === 'empty file' ? '' : damage === 'invalid job shape' ? 'null' : '{');
    }
    for (const [index, overrides] of [{ repo: 'fixture/other' }, { prNumber: 2 }, { status: 'failed' }].entries()) {
      writeFileSync(join(dir, `${prefix}unrelated-${index}.json`), JSON.stringify({ ...job, ...overrides }));
    }
    writeFileSync(join(dir, 'ignored.txt'), '{');
    assert.deepEqual((await readCompletedRemediationRounds(root, 'fixture/repo', '1')).sort((a, b) => a.startHeadSha.localeCompare(b.startHeadSha)), [...rounds].sort((a, b) => a.startHeadSha.localeCompare(b.startHeadSha)));
  });
}

test('HAMCLOSE-05: missing completed directory or only damaged jobs yields no round proof', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completed-remediation-rounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await readCompletedRemediationRounds(root, 'fixture/repo', 1), []);
  const dir = join(root, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture__repo-pr-1-broken.json'), '{');
  assert.deepEqual(await readCompletedRemediationRounds(root, 'fixture/repo', 1), []);
});

test('completed round lookup selects job prefixes and matches GitHub repo casing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completed-remediation-rounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const round = { state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'head' };
  const job = { repo: 'Fixture/Repo', prNumber: 1, status: 'completed', remediationPlan: { rounds: [round] } };
  writeFileSync(join(dir, 'Fixture__Repo-pr-1-2026-10-12.json'), JSON.stringify(job));
  // Even apparently matching contents in other PR/repo files are not scanned.
  for (const name of ['fixture__repo-pr-10-old.json', 'fixture__other-pr-1-old.json']) {
    writeFileSync(join(dir, name), JSON.stringify(job));
  }
  assert.deepEqual(await readCompletedRemediationRounds(root, 'fixture/repo', 1), [round]);
});

test('zero-edge proofs cannot masquerade as App or completed-round chains', async () => {
  const rounds = [{ state: 'completed', startHeadSha: 'other', resultingHeadSha: 'unrelated' }];
  assert.equal(hammerAttestationChain([], 'reviewed', 'reviewed'), null);
  for (const remediationRounds of [[], rounds]) {
    const f = fixture([], { status: 'identical' });
    const range = await fetchHammerHeadRange({ ...f.options, currentHead: 'reviewed', remediationRounds,
      get: async path => {
        f.calls.push(path);
        if (path.endsWith('/commits/main')) return { sha: 'base' };
        return { status: 'identical', total_commits: 0, commits: [] };
      } });
    assert.equal(range.verified, true);
    assert.equal(range.proof, undefined);
    assert.equal(f.calls.length, 3, 'exact head takes the ordinary comparison path');
  }
});

test('reviewed starting base has an explicit proof, independent of completed rounds', async () => {
  const range = await fetchHammerHeadRange({ reviewedHead: 'reviewed', currentHead: 'head',
    hammerBaseHead: 'reviewed', remediationRounds: [{ state: 'completed', startHeadSha: 'other', resultingHeadSha: 'unrelated' }],
    get() { throw new Error('HAMCLOSE-01 reviewed starting base needs no ancestry reads'); } });
  assert.equal(range.proof, 'reviewed-starting-base');
  assert.deepEqual(range.commits, ['head']);
});

for (const [name, rounds, target, diverged, proven] of [
  ['one round', [['reviewed', 'head']], 'head', false, true],
  ['two rounds', [['reviewed', 'round1'], ['round1', 'head']], 'head', false, true],
  ['extra commit', [['reviewed', 'head']], 'extra', false, false],
  ['wrong start', [['other', 'head']], 'head', false, false],
  ['unfinished', [['reviewed', 'head', 'spawned']], 'head', false, false],
  ['identical link', [['reviewed', 'head']], 'head', 'identical', false],
  ['unreadable compare', [['reviewed', 'head']], 'head', 'unreadable', false],
  ['diverged link', [['reviewed', 'round1'], ['round1', 'head']], 'head', true, false],
  ['no records', [], 'head', false, false],
  ['legacy missing result', [['reviewed', null]], 'head', false, false],
]) {
  test(`HAMCLOSE-05: ${name}`, async () => {
    const read = () => fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed',
      currentHead: target, hammerBaseHead: target,
      remediationRounds: rounds.map(([startHeadSha, resultingHeadSha, state = 'completed']) => ({ startHeadSha, resultingHeadSha, state })),
      get: async path => {
        if (diverged === 'unreadable') throw new Error('synthetic read failure');
        return { status: diverged === 'identical' ? 'identical'
          : diverged && path.endsWith('round1...head') ? 'diverged' : 'ahead' };
      },
    });
    if (diverged === 'unreadable') return assert.rejects(read(), { hammerHistoryReadFailed: true });
    const range = await read();
    assert.equal(Boolean(range), proven);
    if (proven) assert.equal(range.proof, 'completed-remediation-round-chain');
  });
}

for (const status of ['diverged', 'identical']) {
  test(`immutable ${status} remediation edges are evaluated once across passes`, async () => {
    const calls = [];
    const rounds = [['middle', 'head'], ['reviewed', 'bad'], ['reviewed', 'middle'], ['reviewed', 'bad']]
      .map(([startHeadSha, resultingHeadSha]) => ({ state: 'completed', startHeadSha, resultingHeadSha }));
    const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: 'head',
      hammerBaseHead: 'head', remediationRounds: rounds, get: async path => {
        calls.push(path);
        if (path.endsWith('reviewed...bad')) {
          if (status === 'error') throw new Error('unreadable comparison');
          return { status };
        }
        return { status: 'ahead' };
      }, loadComments() { throw new Error('completed round proof must avoid comment pagination'); } });
    assert.equal(range.proof, 'completed-remediation-round-chain');
    assert.equal(calls.filter(path => path.endsWith('reviewed...bad')).length, 1);
  });
}

test('lazy comments retain App proof fallback when local rounds do not prove the base', async () => {
  let loads = 0;
  const range = await fetchHammerHeadRange({ reviewedHead: 'reviewed', currentHead: 'head', hammerBaseHead: 'head',
    remediationRounds: [], loadComments: async () => {
      loads++;
      return [{ author: 'hammer-worker', body: 'HAM-Base-Head: reviewed\nHAM-Validated-Head: head' }];
    }, get() { throw new Error('App proof needs no comparison'); } });
  assert.equal(range.proof, 'hammer-app-attestation-chain');
  assert.equal(loads, 1);
});

const forcePush = (before, after, actor = { __typename: 'Bot', login: 'lacey-codex-agent[bot]' }) => ({
  __typename: 'HeadRefForcePushedEvent', beforeCommit: { oid: before },
  afterCommit: after ? { oid: after } : null, actor,
});
const timelinePage = (nodes, hasNextPage = false, endCursor = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });

for (const [name, events, statuses, kinds] of [
  ['direct rebase', [forcePush('reviewed', 'head')], {}, ['fleet-force-push']],
  ['rebase then push', [forcePush('reviewed', 'middle')], { 'middle...head': 'ahead' }, ['fleet-force-push']],
  ['two hops', [forcePush('reviewed', 'middle'), forcePush('middle', 'head')], {}, ['fleet-force-push']],
  ['retry after reset', [forcePush('reviewed', 'abandoned'), forcePush('abandoned', 'reviewed'),
    forcePush('reviewed', 'head')], {}, ['fleet-force-push']],
  ['latest User cannot inherit an older Bot proof', [forcePush('reviewed', 'head'),
    forcePush('head', 'reviewed'), forcePush('reviewed', 'head', { __typename: 'User', login: 'lacey-codex-agent[bot]' })], {}, null],
  ['User actor', [forcePush('reviewed', 'head', { __typename: 'User', login: 'lacey-codex-agent[bot]' })], {}, null],
  ['foreign Bot', [forcePush('reviewed', 'head', { __typename: 'Bot', login: 'synthetic-other[bot]' })], {}, null],
  ['wrong start', [forcePush('other', 'head')], {}, null],
  ['missing result', [forcePush('reviewed', null)], {}, null],
  ['missing start', [{ ...forcePush('reviewed', 'head'), beforeCommit: null }], {}, null],
  ['ten hops', Array.from({ length: 10 }, (_, i) => forcePush(i ? `hop${i}` : 'reviewed', i === 9 ? 'head' : `hop${i + 1}`)), {}, ['fleet-force-push']],
  ['eleven hops', Array.from({ length: 11 }, (_, i) => forcePush(i ? `hop${i}` : 'reviewed', i === 10 ? 'head' : `hop${i + 1}`)), {}, null],
]) {
  test(`HAMCLOSE-06: ${name}`, async () => {
    const result = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: 'head',
      hammerBaseHead: 'head', env: {}, remediationRounds: [{ state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'head' }],
      get: async path => ({ status: statuses[path.split('/compare/')[1]] || 'diverged' }),
      loadTimelinePage: async () => timelinePage(events) });
    assert.deepEqual(result?.linkKinds || null, kinds);
    if (kinds) assert.equal(result.proof, 'completed-remediation-round-chain');
  });
}

for (const pages of [10, 11]) {
  test(`HAMCLOSE-06: ${pages}-page timeline respects the all-or-nothing page bound`, async () => {
    const calls = [];
    const result = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: 'head',
      hammerBaseHead: 'head', env: {}, remediationRounds: [{ state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'head' }],
      get: async () => ({ status: 'diverged' }),
      loadTimelinePage: async cursor => {
        calls.push(cursor);
        // An early valid edge cannot authorize a truncated timeline.
        return timelinePage(calls.length === 1 ? [forcePush('reviewed', 'head')] : [],
          calls.length < pages, `page-${calls.length}`);
      } });
    assert.equal(calls.length, 10);
    assert.deepEqual(calls, [null, ...Array.from({ length: 9 }, (_, i) => `page-${i + 1}`)]);
    if (pages === 10) assert.deepEqual(result.linkKinds, ['fleet-force-push']);
    else assert.equal(result, null);
  });
}

for (const mode of ['throw', 'malformed', 'pagination', 'ahead', 'mixed']) {
  test(`HAMCLOSE-06: ${mode} timeline`, async () => {
    const calls = [];
    const read = () => fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: 'head',
      hammerBaseHead: 'head', env: {}, remediationRounds: (mode === 'mixed'
        ? [['reviewed', 'middle'], ['middle', 'head']] : [['reviewed', 'head']])
        .map(([startHeadSha, resultingHeadSha]) => ({ state: 'completed', startHeadSha, resultingHeadSha })),
      get: async path => ({ status: mode === 'ahead' || (mode === 'mixed' && path.endsWith('reviewed...middle')) ? 'ahead' : 'diverged' }),
      loadTimelinePage: async cursor => {
        calls.push(cursor);
        if (mode === 'throw' || mode === 'ahead') throw new Error('synthetic read failure');
        if (mode === 'malformed') return { nodes: [] };
        if (mode === 'pagination' && cursor === null) return timelinePage([], true, 'second');
        return timelinePage([forcePush(mode === 'mixed' ? 'middle' : 'reviewed', 'head')]);
      } });
    if (mode === 'throw') return assert.rejects(read(), { hammerHistoryReadFailed: true });
    const result = await read();
    if (mode === 'malformed') assert.equal(result, null);
    else assert.deepEqual(result.linkKinds, mode === 'mixed' ? ['ahead', 'fleet-force-push'] : [mode === 'ahead' ? 'ahead' : 'fleet-force-push']);
    assert.deepEqual(calls, mode === 'ahead' ? [] : mode === 'pagination' ? [null, 'second'] : [null]);
  });
}

test('HAMCLOSE-06 configured fleet App identity proves a rebase', async () => {
  const result = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: 'head',
    hammerBaseHead: 'head', env: { OAUTH_BROKER_CODEX_AGENT_PROVIDER: 'github-app-synthetic-remediator' },
    remediationRounds: [{ state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'head' }],
    get: async () => ({ status: 'diverged' }), loadTimelinePage: async () => timelinePage([
      forcePush('reviewed', 'head', { __typename: 'Bot', login: 'synthetic-remediator[bot]' }),
    ]) });
  assert.deepEqual(result.linkKinds, ['fleet-force-push']);
});

const activity = (before, after, kind = 'push', actor = { type: 'Bot', login: 'synthetic-remediator[bot]' }) => ({
  before, after, activity_type: kind, actor, ref: 'refs/heads/repair', timestamp: '2026-01-01T00:00:00Z',
});
function activityOptions(events, extra = {}) {
  return { repo: 'fixture/repo', prNumber: 1, reviewedHead: 'reviewed', currentHead: 'head', hammerBaseHead: 'head',
    env: { OAUTH_BROKER_CODEX_AGENT_PROVIDER: 'github-app-synthetic-remediator' },
    get: async path => path.includes('/commits/') ? fleet(path.split('/').at(-1))
      : ({ head: { ref: 'repair', repo: { full_name: 'fixture/repo' } } }),
    loadActivityPage: async () => ({ nodes: events.toReversed(), next: null }), ...extra };
}
for (const [name, events, rounds] of [
  ['one bot push', [activity('reviewed', 'head')], []],
  ['force push then push', [activity('reviewed', 'middle', 'force_push'), activity('middle', 'head')], []],
  ['three steps', [activity('reviewed', 'one'), activity('one', 'two', 'force_push'), activity('two', 'head')], []],
  ['stopped round without result', [activity('reviewed', 'head')], [{ state: 'stopped', startHeadSha: 'reviewed' }]],
  ['unrecorded force push', [activity('reviewed', 'head', 'force_push')], []],
  ['earlier hammer repair', [activity('reviewed', 'repair'), activity('repair', 'head')], []],
  ['trusted mutations return to expected head', [activity('reviewed', 'head'), activity('head', 'middle'), activity('middle', 'head', 'force_push')], []],
]) {
  test(`HAMCLOSE-07 activity: ${name}`, async () => {
    const range = await fetchHammerHeadRange(activityOptions(events, { remediationRounds: rounds }));
    assert.equal(range.proof, 'branch-activity');
    assert.deepEqual(range.steps, events.map(event => ({ before: event.before, after: event.after,
      kind: event.activity_type, actor: event.actor.login, time: event.timestamp })));
  });
}
for (const [name, events] of [
  ['untrusted actor', [activity('reviewed', 'middle'), activity('middle', 'head', 'push', { type: 'Bot', login: 'foreign-bot' })]],
  ['non-bot actor with trusted login', [activity('reviewed', 'head', 'push', { type: 'User', login: 'synthetic-remediator[bot]' })]],
  ['unknown actor', [activity('reviewed', 'head', 'push', null)]],
  ['gap', [activity('reviewed', 'middle'), activity('other', 'head')]],
  ['wrong ref', [{ ...activity('reviewed', 'head'), ref: 'refs/heads/other' }]],
  ['untrusted push after target', [activity('reviewed', 'head'), activity('head', 'foreign', 'push', { type: 'User', login: 'human' })]],
  ['non-bot force push after target', [activity('reviewed', 'head'), activity('head', 'foreign', 'force_push', { type: 'User', login: 'synthetic-remediator[bot]' })]],
  ['untrusted mutation followed by trusted return to target', [activity('reviewed', 'head'), activity('head', 'foreign', 'push', { type: 'User', login: 'human' }), activity('foreign', 'head', 'force_push')]],
  ['branch deletion after target', [activity('reviewed', 'head'), activity('head', '', 'branch_deletion')]],
  ['trusted push beyond expected head', [activity('reviewed', 'head'), activity('head', 'newer')]],
  ['wrong ref after target', [activity('reviewed', 'head'), { ...activity('head', 'newer'), ref: 'refs/heads/other' }]],
]) {
  test(`HAMCLOSE-07 activity declines ${name}`, async () => {
    assert.equal(await fetchHammerHeadRange(activityOptions(events)), null);
  });
}
test('HAMCLOSE-07 activity proves every step beyond a distinct hammer base', async () => {
  const events = [activity('reviewed', 'base'), activity('base', 'middle', 'force_push'), activity('middle', 'head')];
  const range = await fetchHammerHeadRange(activityOptions(events, { hammerBaseHead: 'base' }));
  assert.equal(range.proof, 'branch-activity');
  assert.deepEqual(range.commits, ['base', 'middle', 'head']);
  assert.equal(range.steps.length, 3);
});
for (const [name, events] of [
  ['missing current head', [activity('reviewed', 'base')]],
  ['untrusted push', [activity('reviewed', 'base'), activity('base', 'head', 'push', { type: 'User', login: 'human' })]],
  ['untrusted force push', [activity('reviewed', 'base'), activity('base', 'head', 'force_push', { type: 'Bot', login: 'foreign-bot' })]],
  ['missing base', [activity('reviewed', 'head')]],
]) {
  test(`HAMCLOSE-07 activity declines distinct hammer base with ${name}`, async () => {
    assert.equal(await fetchHammerHeadRange(activityOptions(events, { hammerBaseHead: 'base' })), null);
  });
}
test('FINALCLOSE-01 activity read failures retry; truncated history cannot prove ancestry', async () => {
  await assert.rejects(fetchHammerHeadRange(activityOptions([], { loadActivityPage: async () => {
    throw new Error('synthetic API failure');
  } })), { hammerHistoryReadFailed: true });
  for (const loadActivityPage of [
    async () => ({ nodes: [activity('reviewed', 'head')], next: 'another-page' }),
    async () => ({ nodes: [activity('other', 'head')], next: null })]) {
    assert.equal(await fetchHammerHeadRange(activityOptions([], { loadActivityPage })), null);
  }
});
test('HAMCLOSE-07 activity paginates using supplied cursors', async () => {
  const calls = [];
  const result = await fetchHammerHeadRange(activityOptions([], { loadActivityPage: async path => {
    calls.push(path);
    return calls.length === 1 ? { nodes: [activity('middle', 'head')], next: 'next-cursor' }
      : { nodes: [activity('reviewed', 'middle')], next: null };
  } }));
  assert.equal(result.proof, 'branch-activity');
  assert.equal(calls[1], 'next-cursor');
});
test('HAMCLOSE-07 activity validates trailing events across page boundaries', async () => {
  let calls = 0;
  const result = await fetchHammerHeadRange(activityOptions([], { loadActivityPage: async () => {
    calls++;
    return calls === 1 ? { nodes: [activity('foreign', 'head', 'force_push'),
      activity('head', 'foreign', 'push', { type: 'User', login: 'human' })], next: 'next-cursor' }
      : { nodes: [activity('reviewed', 'head')], next: null };
  } }));
  assert.equal(result, null);
  assert.equal(calls, 2);
});
test('HAMCLOSE-07 unchanged starting head and existing proofs avoid activity reads', async () => {
  const loadActivityPage = () => { throw new Error('activity must not be read'); };
  const unchanged = await fetchHammerHeadRange(activityOptions([], {
    currentHead: 'reviewed', hammerBaseHead: 'reviewed', get() { throw new Error('no API needed'); }, loadActivityPage,
  }));
  assert.equal(unchanged.proof, 'reviewed-starting-base');
  const attested = await fetchHammerHeadRange(activityOptions([], { loadActivityPage,
    comments: [{ author: 'hammer-worker', body: 'HAM-Base-Head: reviewed\nHAM-Validated-Head: head' }] }));
  assert.equal(attested.proof, 'hammer-app-attestation-chain');
});

test('activity declines unsigned or foreign pushed commits despite a trusted actor', async () => {
  for (const commit of [{ ...fleet('head'), commit: { verification: { verified: false } } },
    { ...fleet('head'), author: { login: 'foreign' } }, { ...fleet('wrong-sha') }]) {
    const options = activityOptions([activity('reviewed', 'head')]);
    const get = options.get;
    options.get = path => path.includes('/commits/head') ? commit : get(path);
    assert.equal(await fetchHammerHeadRange(options), null);
  }
});


test('activity commit lookups overlap with bounded concurrency and retain order', async () => {
  const events = Array.from({ length: 9 }, (_, i) => activity(i ? `step${i}` : 'reviewed', i === 8 ? 'head' : `step${i + 1}`));
  const options = activityOptions(events);
  const originalGet = options.get;
  let active = 0, maximum = 0;
  options.get = async path => {
    if (!path.includes('/commits/')) return originalGet(path);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return originalGet(path);
  };
  const range = await fetchHammerHeadRange(options);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(range.commits, events.map(event => event.after));
});

test('activity refuses invalid structure before fetching commits', async () => {
  const options = activityOptions([activity('reviewed', 'middle'), activity('gap', 'head')]);
  const originalGet = options.get;
  let calls = 0;
  options.get = path => { if (path.includes('/commits/')) calls++; return originalGet(path); };
  assert.equal(await fetchHammerHeadRange(options), null);
  assert.equal(calls, 0);
});

test('activity settles concurrent lookups and refuses a failed lookup', async () => {
  const options = activityOptions([activity('reviewed', 'middle'), activity('middle', 'head')]);
  const originalGet = options.get;
  let settled = false;
  options.get = async path => {
    if (path.endsWith('/commits/middle')) throw new Error('unreadable commit');
    if (path.endsWith('/commits/head')) { await new Promise(resolve => setImmediate(resolve)); settled = true; }
    return originalGet(path);
  };
  await assert.rejects(fetchHammerHeadRange(options), { hammerHistoryReadFailed: true });
  assert.equal(settled, true);
});
