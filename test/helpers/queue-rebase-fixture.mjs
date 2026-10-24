import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFinalizationQueueStore } from '../../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../../src/finalization/queue-owner.mjs';
import { createCleanReviewService } from '../../src/finalization/queue-clean-review.mjs';
import { createQueueAdmissionService } from '../../src/finalization/queue-admission.mjs';
import { resolveQueueGitAdapter } from '../../src/finalization/queue-git.mjs';
import { queueCleanFixture, queueLiveFixture } from './queue-clean-fixture.mjs';
import { handoffTime } from './queue-handoff-fixture.mjs';
export const idle = { enabled: false };
export function localGit(cwd, args, input) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'latin1', timeout: 10000, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Example Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Example Author', GIT_COMMITTER_EMAIL: 'author@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  }).trimEnd();
}
export function gitFixture(t, { second = false, conflict = false, noop = false, empty = false, sharedFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mgq-rebase-'));
  const source = join(root, 'source'), remote = join(root, 'remote.git');
  mkdirSync(source);
  const g = args => localGit(source, args);
  g(['init', '-b', 'main']);
  const file = (name, data) => writeFileSync(join(source, name), data);
  const commit = message => { g(['add', '--all']); g(['commit', '-m', message]); return g(['rev-parse', 'HEAD']); };
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`);
  file('content', sharedFile ? lines.join('') : 'initial\n'); file('base', 'initial\n'); file('INDEX.md', 'initial\n');
  const fork = commit('initial');
  g(['checkout', '-b', 'topic']); file('content', sharedFile ? ['reviewed\n', ...lines.slice(1)].join('') : 'reviewed\n');
  let oldHead = commit('reviewed change\n\nWorker-Class: builder');
  if (second) { file('another', 'second\n'); oldHead = commit('second change'); }
  if (empty) { g(['commit', '--allow-empty', '-m', 'empty']); oldHead = g(['rev-parse', 'HEAD']); }
  g(['checkout', 'main']);
  let base = fork;
  if (!noop) { file(sharedFile || conflict ? 'content' : 'base', sharedFile ? [...lines.slice(0, -1), 'upstream\n'].join('') : 'upstream\n'); base = commit('base advanced'); }
  g(['init', '--bare', remote]);
  g(['push', remote, 'main', 'topic']);
  let store = openFinalizationQueueStore({ rootDir: root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let clock = handoffTime(0);
  const now = () => clock;
  const adapter = resolveQueueGitAdapter({ rootDir: root, now, load: idle, resolveRemote: () => remote });
  const entry = { lane: { repository: 'example/review', base: 'main' }, prNumber: 102, head: oldHead };
  const fixture = { root, source, remote, g, file, commit, fork, base, oldHead, adapter, entry, now,
    clock: n => { clock = handoffTime(n); }, get store() { return store; },
    reopen() { store.close(); store = openFinalizationQueueStore({ rootDir: root }); },
    prepare: () => adapter.prepare({ entry, oldHead: fixture.oldHead, exactBase: fixture.base, headRepository: 'example/review', headRef: 'topic', deadline: handoffTime(1800) }),
  };
  return fixture;
}
export async function admitted(f) {
  let { h, e } = queueCleanFixture();
  // Replace only exact fixture head identities; signatures stay synthetic.
  const replace = value => JSON.parse(JSON.stringify(value).replaceAll('b'.repeat(40), f.oldHead));
  h = replace(h); e = replace(e);
  const ack = await createCleanReviewService({ store: f.store, now: f.now, load: idle,
    evidenceAdapter: { read: async () => e } }).submit(h);
  const live = queueLiveFixture(h);
  live.subject.baseSha = f.base;
  Object.assign(live.subject, { headRepository: 'example/review', headRef: 'topic' });
  Object.assign(live.permission, { canForcePush: true, canWriteHeadRepository: true, maintainerCanModify: true,
    fork: false, rulesSourceRef: 'rules:1', headRepository: 'example/review', headRef: 'topic' });
  const owner = createQueueOwner({ store: f.store, now: f.now });
  const { fence } = await owner.claim({ lane: h.lane, ownerId: 'owner', expiresAt: handoffTime(4000) });
  await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
    liveAdapter: { read: async () => live } }).reconcile({ fence, entryId: ack.entryId });
  return { h, e, ack, live, owner, fence };
}
