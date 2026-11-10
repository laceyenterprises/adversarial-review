import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLegacyActor } from '../src/finalization/legacy-actor-boundary.mjs';
import { runLegacyPrWrite } from '../src/finalization/legacy-pr-write.mjs';
import { legacyPrWriteMain } from '../bin/legacy-pr-write.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createLaneRoutingController, resolveLaneRoute } from '../src/finalization/queue-routing.mjs';

const lane = { repository: 'example/project', base: 'main' };
const queueCfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
function root(t) {
  const path = mkdtempSync(join(tmpdir(), 'mlr06-route-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('legacy actor preflight preserves default legacy and refuses configured queue composition', async t => {
  const rootDir = root(t);
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, base: lane.base, cfg: {} })).ok, true);
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, base: lane.base, cfg: queueCfg })).ok, false);
});
test('durable queue ownership survives removed selector; wrong/missing base never bypasses it', async t => {
  const rootDir = root(t);
  const store = openFinalizationQueueStore({ rootDir });
  const controller = createLaneRoutingController({ store });
  await controller.run({ cfg: {}, lane, kind: 'closer', legacy: () => ({ ok: true }) });
  const desired = resolveLaneRoute(queueCfg, lane);
  store.db.prepare('UPDATE finalization_queue_route SET executor=?,config_generation=? WHERE repository=? AND base=?')
    .run('queue-v2', desired.configGeneration, lane.repository, lane.base);
  store.close();
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, base: lane.base, cfg: {} })).ok, false);
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, cfg: {} })).ok, false);
  // A different base is a different whole lane, never a short repo-name match.
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, base: 'release', cfg: {} })).ok, true);
});
test('unreadable durable route fails closed without executing a command', async t => {
  const rootDir = root(t);
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  db.exec('CREATE TABLE finalization_queue_route (repository TEXT)'); db.close();
  assert.equal((await prepareLegacyActor({ rootDir, repo: lane.repository, base: lane.base, cfg: {} })).ok, false);
});
test('PR wrapper resolves the live base and preserves the original entitled argv', async () => {
  const command = '/fixture/hq';
  const argv = ['dispatch', '--pr', '5', '--prompt', '/fixture/prompt'];
  let seen;
  const result = await runLegacyPrWrite({ rootDir: '/fixture/ar', repository: lane.repository, prNumber: 5, head: 'A', command, argv,
    readCandidate: async () => ({ prState: 'open', headSha: 'A', baseBranch: 'release' }),
    run: async args => { seen = args; return { stdout: 'fixture:receipt' }; } });
  assert.equal(result.stdout, 'fixture:receipt');
  assert.equal(seen.base, 'release');
  assert.deepEqual(seen.argv, argv);
  assert.equal(seen.command, command);
});
test('terminal or moved-head PR refuses before lane issuance', async () => {
  for (const candidate of [{ prState: 'merged' }, { prState: 'open', headSha: 'B', baseBranch: 'main' }]) {
    const result = await runLegacyPrWrite({ rootDir: '/fixture/ar', repository: lane.repository, prNumber: 5, head: 'A',
      readCandidate: async () => candidate, run: () => assert.fail('no command') });
    assert.equal(result.ok, false);
  }
});
test('CLI transports exact argv and output and uses temporary failure for queue ownership', async () => {
  const output = []; const stdout = { write: text => output.push(text) }; const stderr = stdout;
  const args = ['--root', '/fixture/ar', '--repo', lane.repository, '--pr', '5', '--', '/fixture/hq', 'dispatch'];
  const code = await legacyPrWriteMain(args, { stdout, stderr, run: async input => {
    assert.deepEqual(input.argv, ['dispatch']); return { ok: false, reason: 'queue-v2-owns-lane' };
  } });
  assert.equal(code, 75);
  assert.match(output.join(''), /queue-v2-owns-lane/);
  assert.equal(await legacyPrWriteMain(['--pr', 'bad'], { stdout, stderr }), 64);
});
