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
    const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed',
      currentHead: target, hammerBaseHead: target,
      remediationRounds: rounds.map(([startHeadSha, resultingHeadSha, state = 'completed']) => ({ startHeadSha, resultingHeadSha, state })),
      get: async path => {
        if (diverged === 'unreadable') throw new Error('synthetic read failure');
        return { status: diverged === 'identical' ? 'identical'
          : diverged && path.endsWith('round1...head') ? 'diverged' : 'ahead' };
      },
    });
    assert.equal(Boolean(range), proven);
    if (proven) assert.equal(range.proof, 'completed-remediation-round-chain');
  });
}

for (const status of ['diverged', 'identical', 'error']) {
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
