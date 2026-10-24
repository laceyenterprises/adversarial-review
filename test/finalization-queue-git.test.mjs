import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQueueGitAdapter, runQueueGit } from '../src/finalization/queue-git.mjs';
import { gitFixture, localGit, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';
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
  await assert.rejects(adapter({ enabled: true, loadAvg1m: 2, cpuCount: 1 }).prepare(request));
  assert.equal(waits.pop(), 60_000, '2x load scales nominal 30s once');
  f.clock(1799); await assert.rejects(adapter({ enabled: true, loadAvg1m: 1000, cpuCount: 1 }).prepare(request));
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
  const injected = resolveQueueGitAdapter({ rootDir: f.root, now: f.now, load: { enabled: true, loadAvg1m: 2, cpuCount: 1 },
    networkRunner: async (args, options) => { calls.push({ args, options }); throw new Error('synthetic entitled transport stop'); } });
  await assert.rejects(injected.prepare(request), /synthetic entitled transport stop/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.timeoutMs, 60_000);
  assert.equal(calls[0].options.repository, f.entry.lane.repository);
  assert.equal(calls[0].args[0], 'fetch');
});
