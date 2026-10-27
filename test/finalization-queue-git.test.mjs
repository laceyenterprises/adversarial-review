import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQueueGitAdapter, runQueueGit } from '../src/finalization/queue-git.mjs';
import { gitFixture, localGit, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';
import { readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// An unsafe control uses only disposable local refs, to demonstrate the race
// protected by the new adapter. No credential or network boundary is exercised.
test('unsafe force control loses the author update in 5/5 repeated trials', async t => {
  for (let n = 0; n < 5; n++) {
    const f = gitFixture(t), p = await f.prepare();
    f.g(['checkout', 'topic']); f.file('author', `author ${n}\n`); const author = f.commit('author update');
    f.g(['push', f.remote, 'topic']);
    localGit(join(f.root, 'data/finalization-git', p.workspace), ['push', '--force', f.remote, `${p.candidate}:refs/heads/topic`]);
    assert.notEqual(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), author);
  }
  t.diagnostic('unsafe control: 5/5 overwritten author heads; leased adapter: 10/10 preserved in queue-rebase fixtures');
});

test('all Git execution calls consume a nominal single-scaled finite budget clipped to remaining patience', async t => {
  const f = gitFixture(t), waits = [];
  const adapter = load => resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load, run: async (_args, options) => {
    waits.push(options.timeoutMs); throw new Error('fixture stop');
  } });
  const request = { entry: f.entry, oldHead: f.oldHead, exactBase: f.base, headRepository: 'example/review', headRef: 'topic', deadline: handoffTime(1800) };
  await assert.rejects(adapter(idle).prepare(request)); assert.equal(waits.pop(), 30_000);
  await assert.rejects(adapter({ enabled: true, loadAvg1m: 2, cpuCount: 1, cpuBusyPercent: 100 }).prepare(request));
  assert.equal(waits.pop(), 60_000, '2x load scales nominal 30s once');
  f.clock(1799); await assert.rejects(adapter({ enabled: true, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 }).prepare(request));
  assert.equal(waits.pop(), 1000);
  assert.throws(() => runQueueGit(['--version'], { timeoutMs: Infinity }), /git-deadline-expired/);
  assert.throws(() => runQueueGit(['--version'], { timeoutMs: 2 ** 31 }), /git-deadline-expired/);
  assert.throws(() => runQueueGit(['--version'], { timeoutMs: 0 }), /git-deadline-expired/);
});

test('Git timeout drains its process group and returns no raw command output', async t => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const f = gitFixture(t), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "synthetic-private-diagnostic"\nsleep 60\n', { mode: 0o755 });
  const before = Date.now();
  await assert.rejects(runQueueGit(['--version'], { cwd: f.root, timeoutMs: 30, env: { PATH: `${bin}:/usr/bin:/bin` } }), e => {
    assert.equal(e.reason, 'git-deadline-or-output-limit');
    assert.equal(JSON.stringify(e).includes('synthetic-private-diagnostic'), false);
    return true;
  });
  assert.ok(Date.now() - before < 5000);
});

test('network Git has no ambient credential fallback and consumes an injected runner budget once', async t => {
  const f = gitFixture(t);
  const request = { entry: f.entry, oldHead: f.oldHead, exactBase: f.base,
    headRepository: 'example/review', headRef: 'topic', deadline: handoffTime(1800) };
  const guarded = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: idle });
  await assert.rejects(guarded.prepare(request), /entitled-git-runner-unavailable/);
  const calls = [];
  const injected = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: { enabled: true, loadAvg1m: 2, cpuCount: 1, cpuBusyPercent: 100 },
    networkRunner: async (args, options) => { calls.push({ args, options }); throw new Error('synthetic entitled transport stop'); } });
  await assert.rejects(injected.prepare(request), /synthetic entitled transport stop/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.timeoutMs, 60_000);
  assert.equal(calls[0].options.repository, f.entry.lane.repository);
  assert.equal(calls[0].args[0], 'fetch');
});

for (const failure of ['conflict', 'proof', 'fetch']) test(`failed preparation reclaims workspace: ${failure}`, async t => {
  const f = gitFixture(t, { conflict: failure === 'conflict', sharedFile: failure === 'proof' });
  if (failure === 'fetch') f.base = 'f'.repeat(40);
  await assert.rejects(f.prepare(), failure === 'proof' ? /rebase-preservation-unproven/ : undefined);
  assert.deepEqual(readdirSync(join(f.root, 'data/finalization-git')), []);
});

test('remote non-fast-forward refusal settles as not-applied without removing successful workspace', async t => {
  const f = gitFixture(t), p = await f.prepare();
  f.g(['--git-dir', f.remote, 'config', 'receive.denyNonFastForwards', 'true']);
  const entry = { ...f.entry, ...p, rebase: { workspace: p.workspace, headRepository: 'example/review', headRef: 'topic' } };
  const result = await f.adapter.push({ entry, intent: { expectedOldHead: f.oldHead, candidate: p.candidate,
    deadline: handoffTime(1800), timeoutMs: 30_000 } });
  assert.equal(result.outcome, 'not-applied'); assert.match(result.sourceRef, /^git:/);
  assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), f.oldHead);
  assert.deepEqual(readdirSync(join(f.root, 'data/finalization-git')), [p.workspace]);
});

for (const kind of ['rewrite', 'forward', 'no-op']) test(`real Git queue publication records receipts only for a rewrite: ${kind}`, async t => {
  const f = gitFixture(t), p = await f.prepare();
  const cwd = join(f.root, 'data/finalization-git', p.workspace);
  let candidate = p.candidate;
  if (kind !== 'rewrite') {
    localGit(cwd, ['checkout', '--detach', f.oldHead]);
    if (kind === 'forward') {
      writeFileSync(join(cwd, 'follow-up'), 'next change\n');
      localGit(cwd, ['add', 'follow-up']);
      localGit(cwd, ['commit', '-m', 'fast forward']);
    }
    candidate = localGit(cwd, ['rev-parse', 'HEAD']);
  }
  if (kind === 'rewrite') {
    await assert.rejects(runQueueGit(['merge-base', '--is-ancestor', f.oldHead, candidate], { cwd, timeoutMs: 5000 }), e => e.code === 1);
  }
  const adapter = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: idle, resolveRemote: () => f.remote, env: { HQ_ROOT: f.root } });
  const entry = { ...f.entry, ...p, rebase: { workspace: p.workspace, headRepository: 'example/review', headRef: 'topic' } };
  const result = await adapter.push({ entry, intent: { expectedOldHead: f.oldHead, candidate, deadline: handoffTime(1800), timeoutMs: 30_000 } });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), candidate);
  assert.equal(Boolean(result.rewriteReceipt), kind === 'rewrite');
  assert.equal(result.rewriteReceiptError, undefined);
});

for (const status of ['[rejected] (stale info)', '[remote rejected] (protected branch hook declined)',
  '[remote rejected] (pre-receive hook declined)', '[remote failure] (remote failed to report status)', 'unreadable']) {
  test(`only explicit single-ref porcelain refusal proves non-application: ${status}`, async t => {
    const f = gitFixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' 'To fixture' '!\told:refs/heads/topic\t${status}' 'Done'\nexit 1\n`, { mode: 0o755 });
    await assert.rejects(runQueueGit(['push', '--porcelain'], { cwd: f.root, timeoutMs: 5000,
      env: { PATH: `${bin}:/usr/bin:/bin` } }), e => {
      assert.equal(e.reason, 'git-command-refused');
      assert.equal(e.publicationRefused, /^\[(?:remote rejected|rejected)\]/.test(status));
      return true;
    });
  });
}

for (const failure of ['workspace', 'remote', 'runner', 'deadline']) test(`pre-invocation refusal is not ambiguous: ${failure}`, async t => {
  const f = gitFixture(t), p = await f.prepare();
  const entry = { ...f.entry, ...p, rebase: { workspace: p.workspace, headRepository: 'example/review', headRef: 'topic' } };
  if (failure === 'workspace') rmSync(join(f.root, 'data/finalization-git', p.workspace), { recursive: true });
  if (failure === 'deadline') f.clock(1800);
  let invoked = 0;
  const adapter = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: idle,
    run: async () => { invoked++; throw new Error('must not invoke'); },
    resolveRemote: () => {
      if (failure === 'remote') throw new Error('resolver unavailable');
      return failure === 'runner' ? 'git@github.com:example/review.git' : f.remote;
    } });
  assert.deepEqual(await adapter.push({ entry, intent: { expectedOldHead: f.oldHead, candidate: p.candidate,
    deadline: handoffTime(1800), timeoutMs: 30000 } }), { outcome: 'not-applied', sourceRef: 'git:push-not-spawned' });
  assert.equal(invoked, 0);
  assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), f.oldHead);
});

test('replay ignores ambient author and committer identity and dates', async t => {
  const f = gitFixture(t);
  const adapter = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: idle, resolveRemote: () => f.remote,
    run: (args, options) => runQueueGit(args, { ...options, env: { ...process.env,
      GIT_AUTHOR_NAME: 'Ambient', GIT_AUTHOR_EMAIL: 'ambient@example.invalid', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'Ambient', GIT_COMMITTER_EMAIL: 'ambient@example.invalid', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
      EMAIL: 'ambient@example.invalid' } }) });
  const p = await adapter.prepare({ entry: f.entry, oldHead: f.oldHead, exactBase: f.base,
    headRepository: 'example/review', headRef: 'topic', deadline: handoffTime(1800) });
  const raw = localGit(join(f.root, 'data/finalization-git', p.workspace), ['cat-file', 'commit', p.candidate]);
  assert.match(raw, /^committer Queue Rebase <queue@example.invalid> /m);
  assert.match(raw, /^author Example Author <author@example.invalid> 1767225600 /m);
  assert.equal(raw.includes('Ambient'), false);
  assert.doesNotMatch(raw, /^committer .* 978307200 /m);
});

for (const stage of ['initial-proof', 'replay', 'final-proof', 'shared-proof']) test(`prepare propagates transient Git failure: ${stage}`, async t => {
  const f = gitFixture(t); let mergeBases = 0, diffs = 0;
  const adapter = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: idle, resolveRemote: () => f.remote,
    run: (args, options) => {
      if (args[0] === 'merge-base') mergeBases++;
      if (args[0] === 'diff') diffs++;
      if ((stage === 'initial-proof' && args[0] === 'diff' && mergeBases === 2)
        || (stage === 'replay' && args.includes('rebase'))
        || (stage === 'final-proof' && args[0] === 'diff' && mergeBases === 3)
        || (stage === 'shared-proof' && args[0] === 'diff' && diffs === 4)) {
        throw Object.assign(new Error('transient'), { reason: 'git-deadline-or-output-limit' });
      }
      return runQueueGit(args, options);
    } });
  await assert.rejects(adapter.prepare({ entry: f.entry, oldHead: f.oldHead, exactBase: f.base,
    headRepository: 'example/review', headRef: 'topic', deadline: handoffTime(1800) }), e => e.reason === 'git-deadline-or-output-limit');
  assert.deepEqual(readdirSync(join(f.root, 'data/finalization-git')), []);
});
