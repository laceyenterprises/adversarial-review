import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapFollowUpWorkspaces, workspaceTarget } from '../src/follow-up-workspace-reaper.mjs';
import { getFollowUpJobDir } from '../src/follow-up-jobs.mjs';

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'workspace-reap-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceRootDir = join(rootDir, 'workspaces');
  mkdirSync(workspaceRootDir);
  const logs = [];
  const deletes = [];
  const options = { rootDir, workspaceRootDir, nowMs: Date.now(),
    logImpl: (line) => logs.push(line), logErrorImpl: (line) => logs.push(line),
    probeDirectoryImpl: async () => ({ state: 'inactive' }),
    lookupPRImpl: async () => ({ source: 'live', prState: 'merged' }),
    launchTrashDeleterImpl: (args) => deletes.push(args) };
  function workspace(pr, suffix = '2026-10-04T01-00-00-000Z', status = null) {
    const id = `org__repo-pr-${pr}-${suffix}`;
    const path = join(workspaceRootDir, id);
    mkdirSync(path);
    if (status) {
      const key = status === 'in_progress' ? 'inProgress' : status;
      const dir = getFollowUpJobDir(rootDir, key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ jobId: id, repo: 'org/repo', prNumber: pr,
        status, completedAt: new Date(options.nowMs).toISOString() }));
    }
    return path;
  }
  return { options, workspace, logs, deletes };
}

test('parses production timestamps and resume backups', () => {
  assert.deepEqual(workspaceTarget('org__some-repo-pr-123-2026-10-04T01-00-00-000Z.resume-backup-123-456'), { repo: 'org/some-repo', prNumber: 123 });
  assert.equal(workspaceTarget('not-a-workspace'), null);
});

test('merged terminal inside TTL goes through trash; open terminal stays', async (t) => {
  const { options, workspace, deletes, logs } = fixture(t);
  const merged = workspace(1, undefined, 'completed');
  const open = workspace(2, undefined, 'completed');
  options.lookupPRImpl = async ({ prNumber }) => ({ source: 'live', prState: prNumber === 1 ? 'merged' : 'open' });
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reapedPrDone, 1);
  assert.equal(result.keptOpenPr, 1);
  assert.equal(result.reapedOrphan, 0);
  assert.equal(existsSync(merged), false);
  assert.equal(existsSync(open), true);
  assert.equal(deletes.length, 1);
  assert.equal(existsSync(deletes[0].trashDir), true);
  assert.ok(logs.some((line) => line.includes('action=reaped reason=pr-done')));
});

test('orphans respect held and unknown CWD, open mtime TTL, and authoritative state', async (t) => {
  const { options, workspace } = fixture(t);
  const paths = [1, 2, 3, 4, 5, 6].map((pr) => workspace(pr));
  utimesSync(paths[3], new Date(options.nowMs - 10000), new Date(options.nowMs - 10000));
  options.ttlMs = 5000;
  options.lookupPRImpl = async ({ prNumber }) => ({ source: prNumber === 6 ? 'mirror' : 'live', prState: [3, 4].includes(prNumber) ? 'open' : 'closed' });
  options.probeDirectoryImpl = async ({ workerDir }) => ({ state: workerDir === paths[1] ? 'active' : workerDir === paths[4] ? 'unknown' : 'inactive' });
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reapedOrphan, 2);
  assert.equal(result.reapedPrDone, 1);
  assert.deepEqual(paths.map(existsSync), [false, true, true, false, true, true]);
});

test('lookups are cached, bounded, and reset each pass', async (t) => {
  const { options, workspace } = fixture(t);
  workspace(1);
  workspace(1, '123.resume-backup-456-789');
  workspace(2);
  let calls = 0;
  options.maxPrLookups = 1;
  options.lookupPRImpl = async () => { calls += 1; return { source: 'live', prState: 'open' }; };
  await reapFollowUpWorkspaces(options);
  assert.equal(calls, 1);
  await reapFollowUpWorkspaces(options);
  assert.equal(calls, 2);
});

test('pending/in-progress references protect same PR and differently named workspaces', async (t) => {
  const { options, workspace } = fixture(t);
  const paths = [workspace(1, undefined, 'pending'), workspace(1, '123'), workspace(2, undefined, 'in_progress'), workspace(3)];
  const dir = getFollowUpJobDir(options.rootDir, 'pending');
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ jobId: 'other', status: 'pending', repo: 'other/repo', prNumber: 9, remediationWorker: { workspaceDir: paths[3] } }));
  options.lookupPRImpl = async () => { throw new Error('must not look up owned workspaces'); };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reaped, 0);
  assert.equal(result.prLookups, 0);
  assert.ok(paths.every(existsSync));
});

test('ownership acquired during async lookup is checked again before rename', async (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1);
  options.lookupPRImpl = async () => {
    const dir = getFollowUpJobDir(options.rootDir, 'pending');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'new-job.json'), JSON.stringify({ jobId: 'new-job', status: 'pending', repo: 'org/repo', prNumber: 1 }));
    return { source: 'live', prState: 'merged' };
  };
  assert.equal((await reapFollowUpWorkspaces(options)).reaped, 0);
  assert.equal(existsSync(path), true);
});

test('unreadable records fail closed and budget stops subsequent probes', async (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1, undefined, 'completed');
  const dir = getFollowUpJobDir(options.rootDir, 'completed');
  writeFileSync(join(dir, 'broken.json'), '{');
  assert.equal((await reapFollowUpWorkspaces(options)).reaped, 0);
  rmSync(join(dir, 'broken.json'));
  let clock = 0;
  options.budgetMs = 10;
  options.clockImpl = () => { clock += 20; return clock; };
  assert.equal((await reapFollowUpWorkspaces(options)).prLookups, 0);
  assert.equal(existsSync(path), true);
});

test('CWD snapshot is shared and held child directories protect workspaces', async (t) => {
  const { options, workspace } = fixture(t);
  const held = workspace(1);
  const unused = workspace(2);
  delete options.probeDirectoryImpl;
  let calls = 0;
  options.execCwdImpl = async (command, args) => {
    calls += 1;
    assert.equal(command, 'lsof');
    assert.deepEqual(args, ['-a', '-d', 'cwd', '-Fn']);
    return { stdout: `p123\nn${held}/nested\n` };
  };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(calls, 1);
  assert.equal(result.reapedOrphan, 1);
  assert.equal(existsSync(held), true);
  assert.equal(existsSync(unused), false);
});

test('archived records are not orphans and live terminal worker PIDs remain protected', async (t) => {
  const { options, workspace } = fixture(t);
  const archived = workspace(1, undefined, 'stopped');
  const live = workspace(2, undefined, 'completed');
  const archiveDir = join(getFollowUpJobDir(options.rootDir, 'stoppedArchived'), '2026-10');
  mkdirSync(archiveDir, { recursive: true });
  const id = archived.split('/').at(-1);
  writeFileSync(join(archiveDir, `${id}.json`), JSON.stringify({ jobId: id, status: 'stopped', stoppedAt: new Date(options.nowMs).toISOString() }));
  rmSync(join(getFollowUpJobDir(options.rootDir, 'stopped'), `${id}.json`));
  const liveId = live.split('/').at(-1);
  writeFileSync(join(getFollowUpJobDir(options.rootDir, 'completed'), `${liveId}.json`), JSON.stringify({ jobId: liveId, status: 'completed', remediationWorker: { processId: process.pid } }));
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reapedPrDone, 1);
  assert.equal(result.reapedOrphan, 0);
  assert.equal(existsSync(live), true);
});
