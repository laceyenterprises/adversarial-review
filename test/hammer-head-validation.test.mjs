import test from 'node:test';
import assert from 'node:assert/strict';
import { exactHammerValidation, fetchHammerHeadRange, fleetCommitIdentityMatches } from '../src/ama/hammer-head-validation.mjs';

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
