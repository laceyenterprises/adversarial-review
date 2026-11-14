import './helpers/registry-session-fixture.mjs';
import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveRemediationDispatchPathForJob, resolveRemediationRuntimeMode } from '../src/remediation-dispatch-mode.mjs';
import { createRemediationRuntime, dispatchRemediationViaHq } from '../src/follow-up-remediation.mjs';
import { resolveHqWorkerWorkspace } from '../src/remediation-hq-dispatch.mjs';

const job = { jobId: 'fixture-fix-all', closureHandoff: { reason: 'final-fix-all' } };
const localRouter = { getMode: () => 'local' };

test('incident #10762/#10780: native and degraded routing cannot launch fix-all in a manifest-less checkout', async () => {
  for (const remediationPlan of [undefined, { dispatchPath: 'bare' }, { dispatchPath: 'hq' }]) {
    assert.equal(resolveRemediationRuntimeMode({ ...job, remediationPlan },
      { healthRouter: localRouter, env: {} }), 'os');
    assert.equal(resolveRemediationDispatchPathForJob({ ...job, remediationPlan },
      { AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native' }), 'hq');
  }
  assert.equal(resolveRemediationRuntimeMode({}, { healthRouter: localRouter, env: {} }), 'local');
  let spawned = false;
  const runtime = createRemediationRuntime({ spawnImpl: () => { spawned = true; } });
  await assert.rejects(runtime.run({ mode: 'local', mesJob: job }), /requires HQ launch custody/);
  assert.equal(spawned, false);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ffacustody-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.hq'));
  writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
  const slot = join(root, 'workers', 'fixture-worker');
  const workspace = join(slot, 'repo');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const manifest = { workerId: 'fixture-worker', workerClass: 'codex',
    launchRequestId: 'lrq_fixture', ownerUser: userInfo().username, hqRoot: root,
    worktreePath: workspace, repo: 'repo', branch: 'fixture/branch',
    ticketRef: job.jobId, expectedCompletionShape: 'branch-push' };
  const path = join(slot, 'workspace.json');
  const save = value => writeFileSync(path, JSON.stringify(value));
  save(manifest);
  const env = { HQ_ROOT: root, HQ_PARENT_SESSION: 'session:fixture:parent', HQ_PROJECT: 'fixture',
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native' };
  const request = { hqRoot: root, workerClass: 'codex', repo: 'fixture/repo', prNumber: 7,
    branch: manifest.branch, jobId: job.jobId, promptPath: join(root, 'prompt.md'),
    replyPath: join(root, 'reply.json'), requiresProducedAttestation: true, env };
  const worker = { requiresProducedAttestation: true, dispatchId: 'dispatch_fixture',
    launchRequestId: manifest.launchRequestId, workerClass: manifest.workerClass,
    hqOwnerUser: manifest.ownerUser, ticketRef: manifest.ticketRef,
    custodyRepo: manifest.repo, custodyBranch: manifest.branch, workspaceDir: null };
  return { root, workspace, path, manifest, save, request, worker };
}

test('workspace custody uses the caller HQ root when the persisted descriptor omits it', async t => {
  const f = fixture(t);
  const execFileImpl = async (_command, args, options) => {
    assert.equal(args[args.indexOf('--root') + 1], f.root);
    assert.equal(options.env.HQ_ROOT, f.root);
    return { stdout: JSON.stringify({ status: 'succeeded', workspacePath: f.workspace }) };
  };
  for (const workspaceDir of [null, f.workspace]) {
    const worker = { ...f.worker, workspaceDir };
    const original = structuredClone(worker);
    assert.equal(await resolveHqWorkerWorkspace({ worker, env: f.request.env, execFileImpl }),
      realpathSync(f.workspace));
    assert.deepEqual(worker, original, 'root fallback does not rewrite durable worker identity');
    assert.equal(await resolveHqWorkerWorkspace({
      worker: { ...worker, hqRoot: f.root }, env: { HQ_ROOT: tmpdir() }, execFileImpl,
    }), realpathSync(f.workspace), 'an explicit root takes precedence');
  }
  await assert.rejects(resolveHqWorkerWorkspace({
    worker: { ...f.worker, workspaceDir: f.workspace, hqRoot: tmpdir() }, env: f.request.env,
  }), /custody unavailable or mismatched/, 'ambient fallback cannot mask an explicit foreign root');
  await assert.rejects(resolveHqWorkerWorkspace({
    worker: { ...f.worker, workspaceDir: f.workspace }, env: {},
  }), /custody unavailable or mismatched/, 'missing root evidence remains a refusal');
});

test('queued provisioning without a workspace refuses inspection and preserves worker state', async t => {
  const f = fixture(t);
  const worker = { ...f.worker, hqRoot: f.root };
  const original = structuredClone(worker);
  await assert.rejects(resolveHqWorkerWorkspace({
    worker, env: f.request.env,
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'queued', workspacePath: null }) }),
  }), /hq dispatch status payload missing workspaceDir\/workspacePath\/worktreePath/);
  assert.deepEqual(worker, original);
  assert.equal(await resolveHqWorkerWorkspace({
    worker, env: f.request.env,
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'succeeded', workspacePath: f.workspace }) }),
  }), realpathSync(f.workspace), 'a later provisioned workspace still resolves');
});

test('crash after HQ enqueue retries the same work order and persists the actual launch, without waiting for provision', async t => {
  const f = fixture(t);
  const calls = [];
  let crash = true;
  const execFileImpl = async (_command, args, options) => {
    calls.push({ args, env: options.env });
    assert.equal(args[0], 'dispatch');
    assert.notEqual(args[1], 'status', 'receipt must survive a still-provisioning workspace');
    if (crash) { crash = false; throw new Error('connection lost after enqueue'); }
    return { stdout: JSON.stringify({ launchRequestId: 'lrq_fixture', dispatchId: 'dispatch_fixture',
      workerClass: 'codex' }) };
  };
  await assert.rejects(dispatchRemediationViaHq({ ...f.request, execFileImpl }), /connection lost/);
  // A retry may regenerate the prompt at another path. The explicit work-order
  // key, not prompt bytes or the reply storage key, selects the existing LRQ.
  const worker = await dispatchRemediationViaHq({ ...f.request,
    workerClass: 'claude-code', promptPath: join(f.root, 'retry-prompt.md'), execFileImpl });
  for (const { args, env } of calls) {
    const key = args[args.indexOf('--idempotency-key') + 1];
    assert.equal(key, `ffa-${createHash('sha256').update(job.jobId).digest('hex')}`);
    assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.equal(args[args.indexOf('--pr') + 1], '7');
    assert.equal(args[args.indexOf('--branch') + 1], 'fixture/branch');
    assert.equal(args[args.indexOf('--root') + 1], f.root);
    assert.equal(env.HQ_ROOT, f.root);
  }
  const firstKey = calls[0].args[calls[0].args.indexOf('--idempotency-key') + 1];
  await dispatchRemediationViaHq({ ...f.request, priorLaunchRequestId: 'lrq_settled', execFileImpl });
  const retryKey = calls.at(-1).args[calls.at(-1).args.indexOf('--idempotency-key') + 1];
  assert.notEqual(retryKey, firstKey, 'a settled worker retry must not replay its terminal launch');
  assert.equal(worker.launchRequestId, 'lrq_fixture');
  assert.equal(worker.workerClass, 'codex');
  assert.equal(worker.workspaceDir, null);
  assert.equal(worker.requiresProducedAttestation, true);
  await assert.rejects(resolveHqWorkerWorkspace({ worker: { ...worker, dispatchId: null } }),
    /missing dispatch handle/);
  const execStatus = async () => ({ stdout: JSON.stringify({ status: 'succeeded', workspacePath: f.workspace }) });
  assert.equal(await resolveHqWorkerWorkspace({ worker, execFileImpl: execStatus }), realpathSync(f.workspace));
  const persisted = { ...worker, workspaceDir: f.workspace };
  assert.equal(await resolveHqWorkerWorkspace({ worker: persisted }), realpathSync(f.workspace));
  for (const field of ['launchRequestId', 'workerClass', 'ownerUser', 'ticketRef', 'repo', 'branch', 'hqRoot']) {
    f.save({ ...f.manifest, [field]: 'wrong' });
    await assert.rejects(resolveHqWorkerWorkspace({ worker: persisted }), /custody unavailable or mismatched/, field);
  }
  f.save(f.manifest);
  const bytes = readFileSync(f.path, 'utf8');
  rmSync(f.path);
  await assert.rejects(resolveHqWorkerWorkspace({ worker: persisted }), /custody unavailable/);
  assert.throws(() => readFileSync(f.path), /ENOENT/, 'missing identity is never reconstructed');
  writeFileSync(f.path, bytes);
  const wrong = join(f.root, 'local', 'repo');
  mkdirSync(join(wrong, '.git'), { recursive: true });
  writeFileSync(join(f.root, 'local', 'workspace.json'), bytes);
  await assert.rejects(resolveHqWorkerWorkspace({ worker: { ...worker, workspaceDir: wrong } }), /custody unavailable/);
});

test('wrong HQ owner refuses before enqueue', async t => {
  const f = fixture(t);
  // Use a separate root because successful host identity reads are cached.
  const wrongRoot = join(f.root, 'wrong-owner');
  mkdirSync(join(wrongRoot, '.hq'), { recursive: true });
  writeFileSync(join(wrongRoot, '.hq/config.json'), JSON.stringify({ ownerUser: 'fixture-other-user' }));
  let called = false;
  await assert.rejects(dispatchRemediationViaHq({ ...f.request, hqRoot: wrongRoot,
    execFileImpl: async () => { called = true; } }), /HQ owner mismatch/);
  assert.equal(called, false);
});
