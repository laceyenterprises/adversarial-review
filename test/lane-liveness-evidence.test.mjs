import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLaneLivenessEvidence } from '../src/lane-liveness-evidence.mjs';
import { main, parseArgs } from '../src/review-pipeline-health-cli.mjs';

const NOW = '2026-01-02T10:30:00.000Z';
const OLD = '2026-01-02T09:58:00.000Z';
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const REPO = 'sample/project';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lane-evidence-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT,
    labels_json TEXT, review_status TEXT, reviewed_at TEXT, last_attempted_at TEXT,
    revision_ref TEXT, reviewer_head_sha TEXT);
    CREATE TABLE review_latency_events (repo TEXT, pr_number INTEGER, at TEXT, event_type TEXT);`);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const write = (path, value) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
    return target;
  };
  const pr = (number, state = 'open', status = 'settled', head = HEAD) => db.prepare(
    `INSERT INTO reviewed_prs VALUES (?, ?, ?, '[]', ?, ?, NULL, ?, ?)`
  ).run(REPO, number, state, status, OLD, head, head);
  const collect = () => collectLaneLivenessEvidence({ db, rootDir: root, hqRoot: root, nowMs: Date.parse(NOW) });
  return { root, db, write, pr, collect };
}

function audit(outcome = 'succeeded', name = 'hammer', prNumber = 1, headSha = HEAD) {
  return { repo: REPO, prNumber, headSha, attempts: [{ outcome, path: name === 'daemon' ? 'daemon-merge' : 'hammer',
    startedAt: OLD, attemptPhase: name === 'daemon' ? 'daemon-merged' : 'hammer-gh-pr-merge' }] };
}
const AUDIT = 'dispatch/audit/adversarial-merge-authority/one.json';
const RECEIPT = 'dispatch/audit/automation-merge-actions/one.json';
const LEASE = 'data/ama-closer-leases/one.json';
const PARK = 'data/daemon-merge-parks/one.json';
const JOB = 'data/follow-up-jobs/';

for (const mutation of ['missing', 'other-head', 'other-pr', 'refused', 'daemon', 'not-succeeded']) {
  test(`hammer success requires succeeded audit plus exact-head merged receipt: ${mutation}`, (t) => {
    const f = fixture(t);
    f.write(AUDIT, audit(mutation === 'not-succeeded' ? 'failed-without-merge' : 'succeeded'));
    if (mutation !== 'missing') f.write(RECEIPT, { repo: REPO, prNumber: mutation === 'other-pr' ? 2 : 1,
      headSha: mutation === 'other-head' ? NEXT : HEAD, merged: mutation !== 'refused',
      producerClass: mutation === 'daemon' ? 'ama-daemon' : 'closer-hammer', executedAt: OLD });
    const result = f.collect().lanes.hammer;
    assert.equal(result.lastRealEvent, null);
    assert.equal(result.lastRuns[0].outcome, 'failed');
  });
}

test('real hammer and daemon merges remain distinct from eligible/no-work audits', (t) => {
  const f = fixture(t);
  f.write(AUDIT, audit());
  f.write(RECEIPT, { repo: REPO, prNumber: 1, headSha: HEAD, merged: true, producerClass: 'closer-hammer', executedAt: OLD });
  f.write('dispatch/audit/adversarial-merge-authority/two.json', audit('succeeded', 'daemon', 2));
  f.write('dispatch/audit/adversarial-merge-authority/three.json', audit('no_work_done', 'hammer', 3));
  f.write('dispatch/audit/adversarial-merge-authority/four.json', audit('eligible', 'hammer', 4));
  const { hammer, daemon } = f.collect().lanes;
  assert.equal(hammer.lastRealEvent.kind, 'hammer_merge');
  assert.equal(hammer.lastRealEvent.prNumber, 1);
  assert.equal(daemon.lastRealEvent.kind, 'daemon_merge');
  assert.equal(daemon.lastRealEvent.prNumber, 2);
  assert.equal(hammer.lastRuns.length, 2);
  assert(hammer.lastRuns.some((run) => run.outcome === 'failed' && run.reason === 'no_work_done'));
});

test('waiting demand excludes terminal PRs, stale heads and handoffs; includes unknown holds', (t) => {
  const f = fixture(t);
  f.pr(1); f.pr(2, 'merged'); f.pr(3, 'closed'); f.pr(4); f.pr(5);
  f.write(LEASE, { repo: REPO, prNumber: 1, headSha: HEAD, status: 'dispatched', acquiredAt: OLD });
  f.write('data/ama-closer-leases/terminal.json', { repo: REPO, prNumber: 2, headSha: HEAD, status: 'dispatched' });
  f.write('data/ama-closer-leases/stale.json', { repo: REPO, prNumber: 4, headSha: NEXT, status: 'pending' });
  f.write(PARK, { repo: REPO, prNumber: 4, headSha: HEAD, reason: 'lease-not-held', firstObservedAt: OLD });
  f.write('data/daemon-merge-parks/handoff.json', { repo: REPO, prNumber: 5, headSha: HEAD, reason: 'verdict-not-eligible', firstObservedAt: OLD });
  const { hammer, daemon } = f.collect().lanes;
  assert.deepEqual(hammer.waiting.map((row) => row.prNumber), [1]);
  assert.deepEqual(daemon.waiting.map((row) => row.prNumber), [4]);
  assert.equal(daemon.waiting[0].at, OLD);
  assert.equal(hammer.labelsUnknown, true);
});

test('old closer prompt stays demand only for open matching head, without reading prompt content', (t) => {
  const f = fixture(t);
  f.pr(1); f.pr(2, 'merged');
  for (const number of [1, 2]) {
    const path = f.write(`data/follow-up-jobs/ama-closer-prompts/sample-project-pr-${number}-${HEAD}.md`, 'synthetic');
    utimesSync(path, new Date(OLD), new Date(OLD));
  }
  assert.deepEqual(f.collect().lanes.hammer.waiting.map((row) => row.prNumber), [1]);
});

test('remediation needs completed published commit proof; unchanged/local commits are not pushes', (t) => {
  const f = fixture(t);
  f.pr(1); f.pr(2, 'merged');
  f.write(`${JOB}pending/one.json`, { repo: REPO, prNumber: 1, createdAt: OLD });
  f.write(`${JOB}pending/two.json`, { repo: REPO, prNumber: 2, createdAt: OLD });
  for (const [number, sha] of [[3, NEXT], [4, HEAD], [5, null]]) {
    f.write(`${JOB}completed/${number}.json`, { repo: REPO, prNumber: number, revisionRef: HEAD, completedAt: OLD,
      completion: { workerPushedHeadSha: sha }, unpublishedWork: { commitSha: NEXT } });
  }
  const result = f.collect().lanes.remediation;
  assert.equal(result.lastRealEvent.prNumber, 3);
  assert.equal(result.lastRealEvent.commitSha, NEXT);
  assert.equal(result.lastRuns.filter((run) => run.outcome === 'succeeded').length, 1);
  assert.deepEqual(result.waiting.map((row) => row.prNumber), [1]);
});

test('review posts only count reviewer_post_success, never starts or exits', (t) => {
  const f = fixture(t);
  f.pr(1, 'open', 'pending'); f.pr(2, 'open', 'reviewing'); f.pr(3, 'merged', 'pending');
  const insert = f.db.prepare('INSERT INTO review_latency_events VALUES (?, ?, ?, ?)');
  for (const type of ['reviewer_started', 'reviewer_post_attempt', 'reviewer_post_failure', 'reviewer_reaped']) insert.run(REPO, 1, NOW, type);
  assert.equal(f.collect().lanes.review.lastRealEvent, null);
  insert.run(REPO, 1, OLD, 'reviewer_post_success');
  const result = f.collect().lanes.review;
  assert.equal(result.lastRealEvent.at, OLD);
  assert.deepEqual(result.waiting.map((row) => row.prNumber), [1, 2]);
  assert.equal(result.lastRuns.length, 3);
});

test('last five outcomes are chronological even with more history than the projection cap', (t) => {
  const f = fixture(t);
  const insert = f.db.prepare('INSERT INTO review_latency_events VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 2100; i++) insert.run(REPO, i + 1, new Date(Date.parse(OLD) + i * 1000).toISOString(), 'reviewer_post_failure');
  const result = f.collect().lanes.review;
  assert.equal(result.available, true);
  assert.deepEqual(result.lastRuns.map((row) => row.prNumber), [2100, 2099, 2098, 2097, 2096]);
});

test('unreadable inputs report unavailable, not healthy idle; metadata and secret details stay private', (t) => {
  const f = fixture(t);
  const secret = 'ghp_' + 's'.repeat(36);
  f.write(AUDIT, audit('failed-without-merge'));
  f.write(`${JOB}failed/one.json`, { repo: REPO, prNumber: 1, failedAt: OLD,
    failureClass: secret, stderr: secret, metadata: { token: secret } });
  assert(!JSON.stringify(f.collect()).includes(secret));
  writeFileSync(join(f.root, AUDIT), '{');
  assert.equal(f.collect().lanes.hammer.available, false);
  f.db.exec('DROP TABLE review_latency_events');
  assert.equal(f.collect().lanes.review.available, false);
});

test('local-only health CLI flag requires no schema write, GitHub, provider, or reconcile', async (t) => {
  const f = fixture(t);
  assert.equal(parseArgs(['--lane-liveness']).laneLiveness, true);
  const output = [];
  assert.equal(await main(['--lane-liveness', '--root', f.root, '--hq-root', f.root, '--now', NOW], {
    stdout: { write: (line) => output.push(line) }, stderr: { write: () => assert.fail('unexpected error') },
  }), 0);
  const payload = JSON.parse(output.join(''));
  assert.equal(payload.version, 1);
  assert.equal(payload.lanes.review.available, false); // Missing DB is blindness, no creation.
  assert.equal(payload.observedAt, NOW);
});

test('local-only CLI never imports the full collector or its writable daemon graph', async (t) => {
  const f = fixture(t);
  const { execFileSync } = await import('node:child_process');
  const cli = new URL('../src/review-pipeline-health-cli.mjs', import.meta.url).href;
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/review-pipeline-health.mjs') || specifier.endsWith('/review-state-db.mjs'))
        throw new Error('writable collector graph imported');
      return next(specifier, context);
    }});
    const { main } = await import(${JSON.stringify(cli)});
    process.exitCode = await main(['--lane-liveness', '--root', process.argv[1], '--hq-root', process.argv[1]]);`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, f.root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(JSON.parse(output).version, 1);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(f.root, 'data', 'reviews.db')), false);
  assert.throws(() => parseArgs(['--lane-liveness', '--sentinel']), /JSON output only/);
});
