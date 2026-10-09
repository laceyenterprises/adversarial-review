import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reapFollowUpWorkspaces, workspaceTarget } from '../src/follow-up-workspace-reaper.mjs';
import { getFollowUpJobDir, reapTerminalFollowUpWorkspaces } from '../src/follow-up-jobs.mjs';
import { withFollowUpJobLock } from '../src/follow-up-job-write.mjs';

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'workspace-reap-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceRootDir = join(rootDir, 'workspaces');
  mkdirSync(workspaceRootDir);
  const logs = [];
  const deletes = [];
  const options = { rootDir, workspaceRootDir, nowMs: Date.now(), passOffsetsImpl: new Map(),
    logImpl: (line) => logs.push(line), logErrorImpl: (line) => logs.push(line),
    probeDirectoryImpl: async () => ({ state: 'inactive' }),
    lookupPRImpl: async () => ({ source: 'live', prState: 'merged' }),
    launchTrashDeleterImpl: (args) => deletes.push(args) };
  function workspace(pr, suffix = '2026-10-04T01-00-00-000Z', status = null, terminalAt = options.nowMs) {
    const id = `org__repo-pr-${pr}-${suffix}`;
    const path = join(workspaceRootDir, id);
    mkdirSync(path);
    if (status) {
      const key = status === 'in_progress' ? 'inProgress' : status;
      const dir = getFollowUpJobDir(rootDir, key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ jobId: id, repo: 'org/repo', prNumber: pr,
        status, completedAt: new Date(terminalAt).toISOString() }));
    }
    return path;
  }
  return { options, workspace, logs, deletes };
}

test('parses production timestamps and resume backups', () => {
  assert.deepEqual(workspaceTarget('org__some-repo-pr-123-2026-10-04T01-00-00-000Z.resume-backup-123-456'), { repo: 'org/some-repo', prNumber: 123 });
  assert.deepEqual(workspaceTarget('org__some-repo-pr-123-2026-10-04T01-00-00-000Z-2.resume-backup-123-456'), { repo: 'org/some-repo', prNumber: 123 });
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

test('an open orphan newly assigned a terminal record uses terminal age instead of directory mtime', async (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1);
  const id = path.split('/').at(-1);
  utimesSync(path, new Date(options.nowMs - 73 * 3600_000), new Date(options.nowMs - 73 * 3600_000));
  options.lookupPRImpl = async () => {
    const dir = getFollowUpJobDir(options.rootDir, 'completed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ jobId: id, status: 'completed',
      completedAt: new Date(options.nowMs).toISOString() }));
    return { source: 'live', prState: 'open' };
  };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reaped, 0);
  assert.equal(result.recentTerminalJob, 1);
  assert.equal(existsSync(path), true);
});

test('opaque unreadable records fail new paths closed and budget stops subsequent probes', async (t) => {
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

test('archived records are not orphans and recycled terminal worker PIDs do not protect workspaces', async (t) => {
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
  assert.equal(result.reapedPrDone, 2);
  assert.equal(result.reapedOrphan, 0);
  assert.equal(existsSync(live), false);
});

for (const condition of ['corrupt archive + null lookup', 'null lookup', 'unknown CWD', 'collision suffix', 'unknown name', 'lookup cap', 'lookup budget']) {
  test(`legacy terminal TTL remains eligible with ${condition}`, async (t) => {
    const { options, workspace } = fixture(t);
    const path = workspace(1, condition === 'collision suffix' ? '2026-10-04T01-00-00-000Z-2' : undefined,
      'completed', options.nowMs - 73 * 3600_000);
    if (condition === 'corrupt archive + null lookup') {
      const archive = join(getFollowUpJobDir(options.rootDir, 'stoppedArchived'), '2020-01');
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'broken.json'), '{');
      options.lookupPRImpl = async () => null;
    }
    if (condition === 'null lookup') options.lookupPRImpl = async () => null;
    if (condition === 'unknown CWD') options.probeDirectoryImpl = async () => ({ state: 'unknown' });
    if (condition === 'unknown name') {
      renameSync(path, join(options.workspaceRootDir, 'legacy-name'));
      const completed = getFollowUpJobDir(options.rootDir, 'completed');
      const id = path.split('/').at(-1);
      renameSync(join(completed, `${id}.json`), join(completed, 'legacy-name.json'));
    }
    if (condition === 'lookup cap') options.maxPrLookups = 0;
    if (condition === 'lookup budget') {
      let clock = 0;
      options.budgetMs = 10;
      options.clockImpl = () => { clock += 10; return clock; };
    }
    const result = await reapFollowUpWorkspaces(options);
    assert.equal(result.reaped, 1);
    assert.equal(existsSync(condition === 'unknown name' ? join(options.workspaceRootDir, 'legacy-name') : path), false);
  });
}

test('corrupt archived ownership is scoped to its PR and never becomes an orphan', async (t) => {
  const { options, workspace } = fixture(t);
  const owned = workspace(1);
  const unrelated = workspace(2);
  const archive = join(getFollowUpJobDir(options.rootDir, 'stoppedArchived'), '2020-01');
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'org__repo-pr-1-123.json'), '{');
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reapedOrphan, 1);
  assert.equal(existsSync(owned), true);
  assert.equal(existsSync(unrelated), false);
});

test('a pending record moved during inventory does not blind unrelated workspaces', async (t) => {
  const { options, workspace } = fixture(t);
  const owned = workspace(1, undefined, 'pending');
  const unrelated = workspace(2);
  const id = owned.split('/').at(-1);
  const pending = join(getFollowUpJobDir(options.rootDir, 'pending'), `${id}.json`);
  const inProgress = getFollowUpJobDir(options.rootDir, 'inProgress');
  mkdirSync(inProgress, { recursive: true });
  options.readInventoryFileImpl = (path, encoding) => {
    if (path === pending) {
      renameSync(pending, join(inProgress, `${id}.json`));
    }
    return readFileSync(path, encoding);
  };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reapedOrphan, 1);
  assert.equal(existsSync(owned), true);
  assert.equal(existsSync(unrelated), false);
});

test('an additive decision cannot override the inner pending/in-progress guard', (t) => {
  const { options, workspace } = fixture(t);
  const paths = ['pending', 'in_progress'].map((status, i) => workspace(i + 1, undefined, status));
  const result = reapTerminalFollowUpWorkspaces({ ...options, workspaceDecisionImpl: () => ({ reap: true }) });
  assert.equal(result.reaped, 0);
  assert.ok(paths.every(existsSync));
});

test('a throwing additive decision falls back to terminal TTL eligibility', (t) => {
  const { options, workspace, logs } = fixture(t);
  const expired = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const recent = workspace(2, undefined, 'completed');
  const result = reapTerminalFollowUpWorkspaces({ ...options,
    workspaceDecisionImpl: () => { throw new Error('malformed ownership metadata'); } });
  assert.equal(result.reaped, 1);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(recent), true);
  assert.ok(logs.some((line) => line.includes('using terminal TTL rule')));
});

test('a hung lookup is bounded through throttle wait and cannot prevent terminal TTL reaping', { timeout: 1000 }, async (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  options.budgetMs = 25;
  // Inventory setup must not spend the lookup budget on a busy CI runner.
  // Advance the pass clock only after admission; boundedLookup still uses
  // its real timer to end the hung request and abort the throttle wait.
  let clock = 0;
  let lookupSignal;
  options.clockImpl = () => clock;
  options.lookupPRImpl = ({ signal, timeoutMs }) => {
    assert.equal(timeoutMs, options.budgetMs);
    lookupSignal = signal;
    clock = options.budgetMs;
    return new Promise(() => {});
  };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.prLookups, 1);
  assert.equal(lookupSignal.aborted, true);
  assert.equal(result.reaped, 1);
  assert.equal(existsSync(path), false);
});

test('the env budget controls lookup admission and the terminal rename budget', async (t) => {
  const { options, workspace } = fixture(t);
  const orphan = workspace(1);
  workspace(2, undefined, 'completed', options.nowMs - 73 * 3600_000);
  options.env = { ADVERSARIAL_FOLLOW_UP_WORKSPACE_REAP_BUDGET_MS: '1' };
  let clock = 0;
  options.clockImpl = () => { clock += 2; return clock; };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.prLookups, 0);
  assert.equal(result.reaped, 0);
  assert.equal(result.deferredForBudget, 1);
  assert.equal(existsSync(orphan), true);
});

test('archive parsing and trash launch happen outside the writer lock', async (t) => {
  const { options, workspace } = fixture(t);
  workspace(1, undefined, 'completed');
  const script = `import fsExt from 'fs-ext'; import { openSync, closeSync } from 'node:fs';
    const fd = openSync(process.argv[1], 'a');
    fsExt.flockSync(fd, 'exnb'); fsExt.flockSync(fd, 'un'); closeSync(fd);`;
  const { spawnSync } = await import('node:child_process');
  const lockRoot = join(options.rootDir, 'data', 'follow-up-jobs');
  withFollowUpJobLock(lockRoot, () => {});
  let reads = 0;
  options.readInventoryFileImpl = (path, encoding) => {
    reads += 1;
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script, join(lockRoot, '.write.lock')], { cwd: new URL('../', import.meta.url) }).status, 0);
    return readFileSync(path, encoding);
  };
  options.launchTrashDeleterImpl = () => {
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script, join(lockRoot, '.write.lock')], { cwd: new URL('../', import.meta.url) }).status, 0);
  };
  assert.equal((await reapFollowUpWorkspaces(options)).reaped, 1);
  assert.equal(reads, 1, 'terminal inventory is not parsed again under the lock');
});


test('observed active CWD vetoes expired terminal TTL but unknown visibility does not', async (t) => {
  const { options, workspace } = fixture(t);
  const active = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const unknown = workspace(2, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const runAs = workspace(3);
  options.probeDirectoryImpl = async ({ workerDir }) => workerDir === active
    ? { state: 'active' } : { state: 'unknown', reason: workerDir === runAs ? 'run-as-user-unobservable' : 'cross-uid-unobservable' };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(result.reaped, 1);
  assert.equal(result.keptCwdActive, 1);
  assert.equal(result.keptCwdUnknown, 2);
  assert.equal(result.keptCwdCrossUid, 1);
  assert.equal(result.keptCwdRunAsUser, 1);
  assert.equal(existsSync(active), true);
  assert.equal(existsSync(unknown), false);
  assert.equal(existsSync(runAs), true);
});

test('writer lock contention defers terminal TTL without reporting a filesystem failure', (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const script = `import { reapTerminalFollowUpWorkspaces } from './src/follow-up-jobs.mjs';
    const result = reapTerminalFollowUpWorkspaces({ rootDir: process.argv[1], workspaceRootDir: process.argv[2],
      logErrorImpl: () => {}, launchTrashDeleterImpl: () => {} });
    console.log(JSON.stringify(result));`;
  const child = withFollowUpJobLock(join(options.rootDir, 'data', 'follow-up-jobs'), () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script, options.rootDir, options.workspaceRootDir],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 }));
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.errors, 0);
  assert.equal(result.deferredForLock, 1);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(path), true);
});

test('relative workspace references use rootDir both initially and under the rename lock', async (t) => {
  for (const phase of ['inventory', 'lookup']) {
    const { options, workspace } = fixture(t);
    const path = workspace(1);
    const record = () => {
      const dir = getFollowUpJobDir(options.rootDir, 'pending');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'other.json'), JSON.stringify({ jobId: 'other', status: 'pending',
        repo: 'other/repo', prNumber: 99, remediationWorker: { workspaceDir: relative(options.rootDir, path) } }));
    };
    if (phase === 'inventory') record();
    else options.lookupPRImpl = async () => { record(); return { source: 'live', prState: 'merged' }; };
    const result = await reapFollowUpWorkspaces(options);
    assert.equal(result.reaped, 0);
    assert.equal(result.prLookups, phase === 'inventory' ? 0 : 1);
    assert.equal(existsSync(path), true);
  }
});

test('inventory stops parsing at the pass deadline and fails additive paths closed', async (t) => {
  const { options, workspace } = fixture(t);
  const expired = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const orphan = workspace(2);
  const archive = join(getFollowUpJobDir(options.rootDir, 'stoppedArchived'), '2020-01');
  mkdirSync(archive, { recursive: true });
  for (let i = 0; i < 20; i += 1) writeFileSync(join(archive, `other-${i}.json`), JSON.stringify({ jobId: `other-${i}`, status: 'stopped' }));
  let clock = 0;
  let reads = 0;
  options.budgetMs = 10;
  options.clockImpl = () => clock;
  options.readInventoryFileImpl = (path, encoding) => { reads += 1; clock += 10; return readFileSync(path, encoding); };
  const result = await reapFollowUpWorkspaces(options);
  assert.equal(reads, 1);
  assert.equal(result.prLookups, 0);
  assert.equal(result.reaped, 1);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(orphan), true);
});

for (const prState of ['merged', 'closed']) {
  test(`resume backups keep semantic TTL even when the PR is ${prState}`, async (t) => {
    const { options, workspace } = fixture(t);
    const recent = workspace(1, undefined, 'completed');
    const expired = workspace(2, undefined, 'completed', options.nowMs - 73 * 3600_000);
    const backups = [recent, expired].map((path) => {
      const backup = `${path}.resume-backup-123-456`;
      renameSync(path, backup);
      return backup;
    });
    const orphan = workspace(3, '123.resume-backup-123-456');
    options.lookupPRImpl = async () => ({ source: 'live', prState });
    const result = await reapFollowUpWorkspaces(options);
    assert.equal(result.prLookups, 0);
    assert.equal(result.reapedPrDone, 0);
    assert.equal(result.reaped, 1);
    assert.equal(existsSync(backups[0]), true);
    assert.equal(existsSync(backups[1]), false);
    assert.equal(existsSync(orphan), true);
  });
}

test('rotation is isolated by workspace root and advances capped passes', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const offsets = new Map();
  const visited = [];
  for (const { options, workspace } of [first, second]) {
    workspace(1); workspace(2);
    options.passOffsetsImpl = offsets;
    options.maxPrLookups = 1;
    options.lookupPRImpl = async ({ prNumber }) => { visited.push(prNumber); return { source: 'live', prState: 'open' }; };
  }
  await reapFollowUpWorkspaces(first.options);
  await reapFollowUpWorkspaces(second.options);
  await reapFollowUpWorkspaces(first.options);
  assert.deepEqual(visited, [1, 1, 2]);
  assert.equal(offsets.size, 2);
});

test('bounded lookup aborts a subprocess still running when its deadline expires', async (t) => {
  const { options, workspace } = fixture(t);
  workspace(1);
  options.budgetMs = 10;
  let aborted = false;
  options.lookupPRImpl = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
  });
  await reapFollowUpWorkspaces(options);
  assert.equal(aborted, true);
});


test('EAGAIN during a rename remains an error rather than a lock deferral', (t) => {
  const { options, workspace } = fixture(t);
  const path = workspace(1, undefined, 'completed', options.nowMs - 73 * 3600_000);
  const result = reapTerminalFollowUpWorkspaces({ ...options,
    renameSyncImpl: () => { throw Object.assign(new Error('rename temporarily unavailable'), { code: 'EAGAIN' }); } });
  assert.equal(result.errors, 1);
  assert.equal(result.deferredForLock, 0);
  assert.equal(existsSync(path), true);
});
