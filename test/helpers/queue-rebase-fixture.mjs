import Database from 'better-sqlite3';
import { ensureFinalizationQueueSchema } from '../../src/finalization/queue-store.mjs';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFinalizationQueueStore } from './queue-fixture-store.mjs';
import { createQueueOwner } from '../../src/finalization/queue-owner.mjs';
import { createCleanReviewService } from '../../src/finalization/queue-clean-review.mjs';
import { createQueueHandoffService } from '../../src/finalization/queue-handoff-store.mjs';
import { createQueueAdmissionService } from '../../src/finalization/queue-admission.mjs';
import { resolveQueueGitAdapter } from '../../src/finalization/queue-git.mjs';
import { queueCleanFixture, queueLiveFixture } from './queue-clean-fixture.mjs';
import { handoffTime, queueHandoffFixture } from './queue-handoff-fixture.mjs';
export const idle = { enabled: false };
// File-private, pristine Git seeds. Copy ordinary objects (no hardlinks or
// alternates) before each case so production mutations cannot cross fixtures.
const seeds = new Map();
const cleanSeeds = () => { for (const { root } of seeds.values()) rmSync(root, { recursive: true, force: true }); };
process.once('exit', cleanSeeds);
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
  const g = args => localGit(source, args);
  const file = (name, data) => writeFileSync(join(source, name), data);
  const commit = message => { g(['add', '--all']); g(['commit', '-m', message]); return g(['rev-parse', 'HEAD']); };
  const key = JSON.stringify([second, conflict, noop, empty, sharedFile]);
  let fork, base, oldHead;
  const seed = seeds.get(key);
  if (seed) {
    cpSync(join(seed.root, 'source'), source, { recursive: true });
    cpSync(join(seed.root, 'remote.git'), remote, { recursive: true });
    cpSync(join(seed.root, 'data'), join(root, 'data'), { recursive: true });
    ({ fork, base, oldHead } = seed);
  } else {
    mkdirSync(source);
    g(['init', '-b', 'main']);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`);
    file('content', sharedFile ? lines.join('') : 'initial\n'); file('base', 'initial\n'); file('INDEX.md', 'initial\n');
    fork = commit('initial');
    g(['checkout', '-b', 'topic']); file('content', sharedFile ? ['reviewed\n', ...lines.slice(1)].join('') : 'reviewed\n');
    oldHead = commit('reviewed change\n\nWorker-Class: builder');
    if (second) { file('another', 'second\n'); oldHead = commit('second change'); }
    if (empty) { g(['commit', '--allow-empty', '-m', 'empty']); oldHead = g(['rev-parse', 'HEAD']); }
    g(['checkout', 'main']);
    base = fork;
    if (!noop) { file(sharedFile || conflict ? 'content' : 'base', sharedFile ? [...lines.slice(0, -1), 'upstream\n'].join('') : 'upstream\n'); base = commit('base advanced'); }
    g(['init', '--bare', remote]);
    g(['push', remote, 'main', 'topic']);
    mkdirSync(join(root, 'data'));
    const db = new Database(join(root, 'data', 'reviews.db'));
    try { db.transaction(() => ensureFinalizationQueueSchema(db))(); } finally { db.close(); }
    const seedRoot = mkdtempSync(join(tmpdir(), 'mgq-seed-'));
    cpSync(source, join(seedRoot, 'source'), { recursive: true });
    cpSync(remote, join(seedRoot, 'remote.git'), { recursive: true });
    cpSync(join(root, 'data'), join(seedRoot, 'data'), { recursive: true });
    seeds.set(key, { root: seedRoot, fork, base, oldHead });
  }
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
export async function admitted(f, { remediated = false } = {}) {
  let { h, e } = remediated ? queueHandoffFixture(102) : queueCleanFixture();
  // Replace only exact fixture head identities; signatures stay synthetic.
  const replace = value => JSON.parse(JSON.stringify(value).replaceAll('b'.repeat(40), f.oldHead));
  h = replace(h); e = replace(e);
  const service = remediated ? createQueueHandoffService : createCleanReviewService;
  const ack = await service({ store: f.store, now: f.now, load: idle,
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
