import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergeLaneStatus, readMergeLaneRecords, renderMergeLaneStatus } from '../src/merge-lane-status.mjs';
import { appendShadowRecord } from '../src/merge-lane-journal.mjs';
import { captureMergeLaneObservation, readBranchCustody } from '../src/merge-lane-observation.mjs';
const NOW = Date.parse('2026-01-02T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const loadOptions = { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100 };
const inventory = { holdLabels: ['hold'], errors: [], repositories: { 'fixture/repo': [1, 2, 3, 4].map(number => ({ number, headRefOid: 'h', title: 'Synthetic', labels: [], isDraft: number === 4 })) } };
const record = (number, changes = {}) => ({ kind: 'observation', repo: 'fixture/repo', prNumber: number,
  subjectKey: `fixture/repo#${number}`, head: 'h', state: 'OPEN', generation: 4, passId: 'pass-4', observedAt: ago(1),
  next: { action: 'hammer', actor: 'hammer', row: 'R04-ownership', reason: 'ownership-unreadable',
    deadline: { at: ago(120), anchoredAt: ago(125), anchorSource: 'durable', budgetMs: 300_000 } },
  ownership: { live: false, ownerless: true, custody: { state: 'complete', dirty: true, branch: 'fixture' } }, ...changes });

test('one row per live open PR; terminal inventory wins over historical snapshots', () => {
  const status = buildMergeLaneStatus({ records: [record(1), record(2, { ownership: { live: true, ownerless: false } }), record(99, { state: 'MERGED' }), record(4)], inventory, now: NOW, loadOptions });
  assert.deepEqual(status.prs.map(p => p.number), [1, 2, 3, 4]);
  assert.equal(status.prs[0].overdueAgeMs, 120 * 60_000);
  assert.equal(status.prs[0].ownership.ownerless, true);
  assert.equal(status.prs[1].ownership.live, true);
  assert.equal(status.prs[2].evidenceState, 'missing');
  assert.equal(status.prs[3].pageEligible, false);
  assert.equal(status.source.generation, 4);
  assert.equal(status.flow.ownerlessMinutes24h, 2);
  assert.match(renderMergeLaneStatus(status), /MERGE LANE — 4 open/);
});

test('load scales proposed deadlines and page patience with a ceiling; owner deadlines stay authoritative', () => {
  const records = [record(1), record(2, { next: { ...record(2).next, deadline: { at: ago(120), anchorSource: 'owner' } } })];
  const status = buildMergeLaneStatus({ records, inventory, now: NOW, loadOptions: { ...loadOptions, loadAvg1m: 100 } });
  assert.equal(status.load.multiplier, 6);
  assert.equal(status.prs[0].overdueAgeMs, 95 * 60_000);
  assert.equal(status.prs[1].overdueAgeMs, 120 * 60_000);
  assert.equal(status.prs[0].pageEligible, false);
});

test('stale evidence and gaps stay unknown; observed anchors do not reset on every pass', () => {
  const next = { ...record(1).next, deadline: { at: ago(125), anchoredAt: ago(130), anchorSource: 'observed', budgetMs: 300_000 } };
  const records = [record(1, { observedAt: ago(130), next }), record(1, { next: { ...next, deadline: { ...next.deadline, at: ago(-4), anchoredAt: ago(1) } } }), record(2, { observedAt: ago(60) })];
  const status = buildMergeLaneStatus({ records, inventory, now: NOW, loadOptions });
  assert.equal(status.prs[0].overdueAgeMs, 125 * 60_000);
  assert.equal(status.prs[1].evidenceState, 'stale');
  assert.equal(status.prs[1].overdueAgeMs, null);
  assert.equal(status.flow.ownerlessMinutes24h, 11, 'gaps are capped, not extrapolated over 24h');
  assert.equal(status.flow.coverage, 'observed-intervals-only');
});

test('episode identity survives repeated passes but changes after observed progress', () => {
  const one = record(1);
  const get = records => buildMergeLaneStatus({ records, inventory, now: NOW, loadOptions }).prs[0].episode;
  assert.equal(get([one]), get([one, { ...one, observedAt: ago(0) }]));
  assert.notEqual(get([one]), get([one, { ...one, observedAt: ago(0), next: { ...one.next, reason: 'new-progress' } }]));
});

test('terminal launch dirty worktree is ownerless; unreadable custody stays unknown', async () => {
  const writes = [];
  const shared = { snapshot: { subjectKey: 'fixture/repo#1', generation: 4, observations: {
    pr: { value: { state: 'OPEN' } }, launches: { state: 'complete', value: { closer: { launchRequestId: 'lrq-fixture', row: { status: 'failed', terminal: true }, retryChain: [] } } } } },
  decision: { ...record(1).next, head: 'h' } };
  await captureMergeLaneObservation({ rootDir: 'unused', shared, repo: 'fixture/repo', prNumber: 1, observedMs: NOW,
    custodyRead: async () => ({ state: 'complete', branch: 'fixture', dirty: true }), write: (...args) => writes.push(args[2]) });
  assert.equal(writes[0].ownership.ownerless, true);
  assert.equal(writes[0].ownership.live, false);
  const custody = await readBranchCustody('lrq-fixture', { readWorker: async () => ({ ok: true, row: { worktree_path: '/synthetic/worktree' } }),
    git: async (_exe, args, opts) => { assert.equal(opts.env.GIT_OPTIONAL_LOCKS, '0'); return { stdout: args[0] === 'symbolic-ref' ? 'fixture\n' : ' M file\n' }; } });
  assert.deepEqual(custody, { state: 'complete', branch: 'fixture', dirty: true, live: null });
  assert.equal((await readBranchCustody('lrq-fixture', { readWorker: async () => ({ ok: false }) })).state, 'unknown');
});

test('both journals rotate within the byte bound; malformed records do not become healthy evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'merge-lane-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['observations.jsonl', 'disagreements.jsonl']) {
    for (let i = 0; i < 30; i++) appendShadowRecord(root, name, { ...record(1), generation: i }, { maxBytes: 1400 });
    for (const suffix of ['', '.1']) {
      const path = join(root, 'data/next-action-shadow', name + suffix);
      assert.ok(statSync(path).size <= 1400);
      for (const line of readFileSync(path, 'utf8').trim().split('\n')) assert.ok(JSON.parse(line).next);
    }
  }
  assert.ok(readMergeLaneRecords(root).records.length > 0);
  assert.throws(() => appendShadowRecord(root, 'observations.jsonl', { text: 'x'.repeat(2000) }, { maxBytes: 1400 }), /too large/);
});

test('episode and observed deadline survive rotation of every original sample', t => {
  const root = mkdtempSync(join(tmpdir(), 'merge-episode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const next = { ...record(1).next, deadline: { at: ago(125), anchoredAt: ago(130), anchorSource: 'observed', budgetMs: 300000 } };
  appendShadowRecord(root, 'observations.jsonl', record(1, { observedAt: ago(130), next }), { maxBytes: 1400 });
  const get = () => buildMergeLaneStatus({ records: readMergeLaneRecords(root).records, inventory, now: NOW, loadOptions }).prs[0];
  const firstEpisode = get().episode;
  for (let i = 20; i > 0; i--) appendShadowRecord(root, 'observations.jsonl', record(1, { observedAt: ago(i), next }), { maxBytes: 1400 });
  assert.equal(get().episode, firstEpisode);
  assert.equal(get().overdueAgeMs, 125 * 60000);
});

test('nonterminal launch records alone do not prove live custody', async () => {
  const writes = [];
  const shared = { snapshot: { subjectKey: 'fixture/repo#1', observations: {
    pr: { value: { state: 'OPEN' } }, launches: { state: 'complete', value: { closer: { launchRequestId: 'synthetic', row: { status: 'running' }, retryChain: [] } } } } },
    decision: { ...record(1).next, head: 'h' } };
  await captureMergeLaneObservation({ rootDir: 'unused', shared, repo: 'fixture/repo', prNumber: 1, observedMs: NOW,
    custodyRead: async () => ({ state: 'unknown', dirty: null, live: null }), write: (...args) => writes.push(args[2]) });
  assert.equal(writes[0].ownership.live, null);
  assert.equal(writes[0].ownership.ownerless, null);
});

test('process birth identity verifies liveness; failed probes stay unknown and retries use their own custody', async () => {
  const worker = { ok: true, row: { process: { pid: 123, started_at: '2026-01-02T12:00:00Z' } } };
  const read = git => readBranchCustody('synthetic', { readWorker: async () => worker, git });
  assert.equal((await read(async () => ({ stdout: 'Fri Jan  2 12:00:00 2026\n' }))).live, true);
  assert.equal((await read(async () => ({ stdout: 'Fri Jan  2 11:00:00 2026\n' }))).live, null);
  assert.equal((await read(async () => { throw Object.assign(new Error('synthetic'), { code: 1 }); })).live, null);
  let selected;
  await captureMergeLaneObservation({ rootDir: 'unused', repo: 'fixture/repo', prNumber: 1, observedMs: NOW,
    shared: { snapshot: { observations: { launches: { state: 'complete', value: { closer: { launchRequestId: 'parent',
      probe: { ok: true, row: { status: 'failed' }, retryChain: [{ launch_request_id: 'child', status: 'running' }] } } } } } },
      decision: { ...record(1).next, head: 'h' } },
    custodyRead: async id => { selected = id; return { live: true, dirty: true }; }, write: () => true });
  assert.equal(selected, 'child');
});

test('out-of-order samples cannot reset an episode and idle gaps do not expire it', t => {
  const root = mkdtempSync(join(tmpdir(), 'merge-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  appendShadowRecord(root, 'observations.jsonl', record(1));
  const first = readMergeLaneRecords(root).records[0].episodeStartedAt;
  assert.equal(appendShadowRecord(root, 'observations.jsonl', record(1, { observedAt: ago(2), next: { action: 'old' } })), false);
  appendShadowRecord(root, 'observations.jsonl', record(1, { observedAt: new Date(NOW + 2 * 86400000).toISOString() }));
  assert.equal(readMergeLaneRecords(root).records.at(-1).episodeStartedAt, first);
});


test('a completed clean closer does not displace the current reviewer owner', async () => {
  let observation;
  await captureMergeLaneObservation({ rootDir: 'unused', repo: 'fixture/repo', prNumber: 1, observedMs: NOW,
    shared: { snapshot: { observations: { reviews: { state: 'complete', value: { reviewerLive: true } },
      launches: { state: 'complete', value: { closer: { launchRequestId: 'old', headSha: 'previous',
        probe: { ok: true, row: { status: 'failed' }, retryChain: [] } } } } } },
      decision: { ...record(1).next, actor: 'reviewer', head: 'h' } },
    custodyRead: async () => ({ state: 'complete', dirty: false, live: false }),
    write: (_root, _name, row) => { observation = row; } });
  assert.equal(observation.ownership.live, true);
  assert.equal(observation.ownership.ownerless, false);
});
