import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture, localGit } from './helpers/queue-rebase-fixture.mjs';
import { proveQueueRebase } from '../src/finalization/queue-rebase-proof.mjs';

const proof = (f, candidate, exactBase = f.base) => proveQueueRebase({ oldHead: f.oldHead, candidate, exactBase,
  git: async args => localGit(f.source, args) + (args[0] === 'cat-file' ? '\n' : '') });

test('ordered complete binary proof is reused, pins base, preserves source bytes and author trailers', async t => {
  const f = gitFixture(t, { second: true }), p = await f.prepare();
  assert.notEqual(p.candidate, f.oldHead); assert.equal(p.proof.noop, false);
  assert.equal(p.proof.sourceCommits.length, 2);
  assert.match(p.proof.sourceCommits[0].raw, /Worker-Class: builder/);
  assert.equal(p.exactBase, f.base);
  assert.deepEqual(await f.adapter.verify({ entry: { ...f.entry, ...p, rebase: { workspace: p.workspace } }, deadline: '2026-10-23T00:30:00Z' }), p.proof);
});

for (const kind of ['whitespace', 'binary', 'path', 'mode', 'symlink', 'gitlink', 'generated', 'invalid-utf8']) {
  test(`changed ${kind} never passes the ordered preservation proof`, async t => {
    const f = gitFixture(t);
    // Establish each reviewed type before replay; then mutate only the candidate.
    f.g(['checkout', 'topic']);
    if (kind === 'binary') f.file('asset', Buffer.from([0, 1, 2, 255]));
    if (kind === 'symlink') symlinkSync('content', join(f.source, 'link'));
    if (kind === 'invalid-utf8') f.file('bytes', Buffer.from([0xff, 10]));
    if (['binary', 'symlink', 'gitlink', 'invalid-utf8'].includes(kind)) {
      f.g(['add', '--all']);
      if (kind === 'gitlink') f.g(['update-index', '--add', '--cacheinfo', `160000,${f.fork},module`]);
      f.g(['commit', '--amend', '--no-edit']); f.oldHead = f.g(['rev-parse', 'HEAD']);
      f.entry.head = f.oldHead; f.g(['push', '--force', f.remote, 'topic']);
    }
    const p = await f.prepare(), cwd = join(f.root, 'data/finalization-git', p.workspace);
    const g = args => localGit(cwd, args);
    if (kind === 'whitespace') writeFileSync(join(cwd, 'content'), 'reviewed \n');
    if (kind === 'binary') writeFileSync(join(cwd, 'asset'), Buffer.from([0, 1, 3, 255]));
    if (kind === 'path') g(['mv', 'content', 'other-name']);
    if (kind === 'mode') chmodSync(join(cwd, 'content'), 0o755);
    if (kind === 'symlink') { unlinkSync(join(cwd, 'link')); symlinkSync('base', join(cwd, 'link')); }
    if (kind === 'gitlink') g(['update-index', '--cacheinfo', `160000,${f.base},module`]);
    if (kind === 'generated') writeFileSync(join(cwd, 'INDEX.md'), 'regenerated\n');
    if (kind === 'invalid-utf8') writeFileSync(join(cwd, 'bytes'), Buffer.from([0xfe, 10]));
    if (kind !== 'gitlink') g(['add', '--all']);
    g(['commit', '--amend', '--no-edit']);
    const changed = g(['rev-parse', 'HEAD']);
    assert.equal(await f.adapter.verify({ entry: { ...f.entry, ...p, candidate: changed, rebase: { workspace: p.workspace } }, deadline: '2026-10-23T00:30:00Z' }), null);
  });
}

test('dropped, reordered, altered intermediate and wrong-base series fail closed', async t => {
  const f = gitFixture(t, { second: true });
  const first = f.g(['rev-parse', 'topic^']);
  f.g(['checkout', '--detach', f.base]);
  f.g(['cherry-pick', f.oldHead]);
  assert.equal(await proof(f, f.g(['rev-parse', 'HEAD'])), null, 'dropped first');
  f.g(['cherry-pick', first]);
  assert.equal(await proof(f, f.g(['rev-parse', 'HEAD'])), null, 'reordered patches');
  const p = await f.prepare();
  f.g(['fetch', join(f.root, 'data/finalization-git', p.workspace), p.candidate]);
  assert.equal(await proof(f, p.candidate, f.fork), null, 'wrong exact base includes upstream commits');
});

for (const option of [{ empty: true }, { conflict: true }]) test(`preparation refuses ${JSON.stringify(option)}`, async t => {
  const f = gitFixture(t, option);
  await assert.rejects(f.prepare(), /unsupported-rebase-history|rebase-conflict-or-unsupported/);
  assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), f.oldHead);
});

test('merge topology refuses preparation; no-op is explicit and retains the SHA', async t => {
  const f = gitFixture(t, { noop: true }), p = await f.prepare();
  assert.equal(p.candidate, f.oldHead); assert.equal(p.proof.noop, true);
  f.g(['checkout', '-b', 'other', f.fork]); f.file('other', 'other\n'); f.commit('other');
  f.g(['checkout', 'topic']); f.g(['merge', '--no-ff', 'other', '-m', 'merge']);
  f.oldHead = f.g(['rev-parse', 'HEAD']); f.entry.head = f.oldHead; f.g(['push', f.remote, 'topic']);
  await assert.rejects(f.prepare(), /unsupported-rebase-history/);
});

test('intermediate edits with identical final tree and original commit messages cannot pass', async t => {
  const f = gitFixture(t, { second: true });
  f.g(['checkout', '--detach', f.base]);
  f.g(['cherry-pick', f.g(['rev-parse', 'topic^'])]);
  f.file('content', 'altered intermediate\n'); f.g(['add', 'content']); f.g(['commit', '--amend', '--no-edit']);
  f.g(['cherry-pick', f.oldHead]);
  f.file('content', 'reviewed\n'); f.g(['add', 'content']); f.g(['commit', '--amend', '--no-edit']);
  assert.equal(await proof(f, f.g(['rev-parse', 'HEAD'])), null);
});

test('original signature headers stay in source proof and are never rebound to candidate commits', async t => {
  const f = gitFixture(t);
  const original = f.g(['cat-file', 'commit', 'topic']) + '\n';
  // Synthetic signature bytes exercise retention, not cryptographic validity;
  // the admission receipt separately owns authenticated source attestations.
  const signed = original.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n synthetic-source-signature\n -----END PGP SIGNATURE-----\n\n');
  f.oldHead = localGit(f.source, ['hash-object', '-t', 'commit', '-w', '--stdin'], signed);
  f.entry.head = f.oldHead;
  f.g(['update-ref', 'refs/heads/topic', f.oldHead]); f.g(['push', '--force', f.remote, 'topic']);
  const p = await f.prepare();
  assert.equal(p.proof.sourceCommits[0].sha, f.oldHead);
  assert.match(p.proof.sourceCommits[0].raw, /gpgsig -----BEGIN PGP SIGNATURE-----/);
  const replayed = localGit(join(f.root, 'data/finalization-git', p.workspace), ['cat-file', 'commit', p.candidate]);
  assert.doesNotMatch(replayed, /gpgsig /);
});
