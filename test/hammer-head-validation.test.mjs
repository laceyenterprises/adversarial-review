import test from 'node:test';
import assert from 'node:assert/strict';
import { exactHammerValidation, fetchHammerHeadRange, fleetCommitIdentityMatches } from '../src/ama/hammer-head-validation.mjs';

const fleet = sha => ({ sha, author: { login: 'lacey-codex-agent[bot]' }, committer: { login: 'lacey-codex-agent[bot]' },
  commit: { verification: { verified: true } } });
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
  const hammer = { ...fleet('head'), author: 'hammer-worker', committer: 'hammer-worker' };
  const { options } = fixture([fleet('remediation'), hammer]);
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
});
test('HAMFINAL-02: foreign side commit is refused even with a trusted hammer tip', async () => {
  const foreign = { ...fleet('foreign'), committer: 'unverified-person' };
  assert.equal(await fetchHammerHeadRange(fixture([foreign, fleet('head')]).options), null);
});
test('HAMSIGN-01: unsigned hammer App commits are trusted by linked identity', async () => {
  const hammer = { ...fleet('head'), author: { login: 'the-hammer-lacey[bot]' },
    committer: { login: 'the-hammer-lacey[bot]' },
    commit: { verification: { verified: false, reason: 'unsigned' } } };
  assert.equal(fleetCommitIdentityMatches(hammer), true);
  assert.equal((await fetchHammerHeadRange(fixture([hammer]).options)).verified, true);
  assert.equal(fleetCommitIdentityMatches({ ...hammer, author: undefined }), true);
  for (const foreign of [{ ...hammer, author: 'foreign' }, { ...hammer, committer: 'foreign' }]) {
    assert.equal(fleetCommitIdentityMatches(foreign), false);
    assert.equal(await fetchHammerHeadRange(fixture([foreign]).options), null);
  }
});
test('HAMSIGN-01: unsigned base merges retain the base ancestry rule', async () => {
  const merge = { ...fleet('head'), author: 'human', committer: 'human',
    commit: { verification: { verified: false, reason: 'unsigned' } },
    parents: [{ sha: 'fleet' }, { sha: 'base-parent' }] };
  const { options } = fixture([fleet('fleet'), merge]);
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
  const get = options.get;
  assert.equal(await fetchHammerHeadRange({ ...options, get: path => path.endsWith('base-parent...base')
    ? { status: 'diverged' } : get(path) }), null);
});
test('HAMFINAL-02: merge of verified base is permitted; foreign side merge is refused', async () => {
  const merge = { ...fleet('merge'), author: 'human', committer: 'human', parents: [{ sha: 'fleet' }, { sha: 'base-parent' }] };
  const { options } = fixture([fleet('fleet'), merge, fleet('head')]);
  assert.equal((await fetchHammerHeadRange(options)).verified, true);
  const get = options.get;
  assert.equal(await fetchHammerHeadRange({ ...options, get: path => path.endsWith('base-parent...base')
    ? { status: 'diverged' } : get(path) }), null);
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
