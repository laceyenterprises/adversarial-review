// Fake public producer for policy tests whose synthetic owner state lives in
// disposable directories. Production code never invokes these filesystem reads.
import { existsSync as exists, readFileSync as read, readdirSync as list, statSync, realpathSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import {tmpdir} from 'node:os';
import { join, basename, resolve, sep } from 'node:path';
import { fixtureWorkerClasses } from './registry-classes-fixture.mjs';
import { dispatchReadTransport } from '../../src/dispatch-read-client.mjs';

function disposable(path) {
  if (typeof path !== 'string') return false;
  const bases = [tmpdir(), process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT].filter(Boolean).map(path => resolve(path));
  const absolute = resolve(path);
  if (!bases.some(base => absolute === base || absolute.startsWith(base + sep))) return false;
  try {
    const real = realpathSync(absolute);
    return bases.some(base => { const owned = realpathSync(base); return real === owned || real.startsWith(owned + sep); });
  } catch { return false; }
}
function readdirSync(path, options) {
  if (!disposable(path)) throw new Error('fixture transport refuses non-disposable state');
  return list(path, options);
}
function existsSync(path) { return disposable(path) && exists(path); }
function readFileSync(path, encoding) {
  if (!disposable(path)) throw new Error('fixture transport refuses non-disposable state');
  return read(path, encoding);
}
function object(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function rootOf(args) { const root = args.hqRoot || args.env?.HAM_HQ_ROOT || args.env?.HQ_ROOT || args.env?.AGENT_OS_HQ_ROOT || process.env.HQ_ROOT; return disposable(root) ? root : null; }
// The fake ledger retains identities after the disposable owner removes files.
const canonicalWorkers = new Map();
function records(root, {canonical = false} = {}) {
  let names; try { names = readdirSync(join(root, 'workers')); } catch { names = []; }
  const known = canonicalWorkers.get(root) || new Map();
  canonicalWorkers.set(root, known);
  const live = names.filter(workerId => {try {return lstatSync(join(root, 'workers', workerId)).isDirectory();} catch {return false;}}).map(workerId => {
    const directory = join(root, 'workers', workerId);
    const workspace = object(join(directory, 'workspace.json'));
    const run = object(join(directory, 'run.json'));
    const provenance = object(join(directory, 'launch-provenance.json'));
    const prior = known.get(workerId);
    const row = {workerId, directory, workspace, run, provenance,
      launchRequestId: run?.launchRequestId || workspace?.launchRequestId || workspace?.lrq || provenance?.launchRequestId || provenance?.launch_request_id || prior?.launchRequestId,
      runId: run?.runId || workspace?.runId || prior?.runId || `run-${workerId}`};
    if (row.launchRequestId) known.set(workerId, row);
    return row;
  });
  if (!canonical) return live;
  const present = new Set(live.map(row => row.workerId));
  return [...live, ...[...known.values()].filter(row => !present.has(row.workerId))
    .map(row => ({...row, workspace: null, run: null, slotAbsent: true}))];
}

function reply(selector, args) {
  const root = rootOf(args);
  if (!root) return null;
  if (selector.observation === 'host_identity') {
    const config = object(join(root, '.hq/config.json'));
    return config?.ownerUser ? {schema_version: 1, status: 'found', ownerUser: config.ownerUser}
      : {schema_version: 1, status: 'unavailable'};
  }
  if (selector.observation === 'workspaces') {
    const allRows = records(root).filter(row => !selector.worker_id || row.workerId === selector.worker_id);
    const offset = selector.offset || 0;
    const rows = allRows.slice(offset, offset + 50);
    return {schema_version: 1, observation: 'workspaces', status: rows.length ? 'found' : 'not_found',
      items: rows.map(row => {
        const raw = row.workspace?.workspacePath || row.workspace?.worktreePath;
        let directoryName = raw ? basename(raw) : null;
        if (!raw) {
          const dirs = readdirSync(row.directory, {withFileTypes: true}).filter(e => e.isDirectory() && !e.name.startsWith('.'));
          if (dirs.length === 1) directoryName = dirs[0].name;
        }
        return {workspace_id: row.workerId, worker_id: row.workerId, launch_request_id: row.launchRequestId || null,
          branch: row.workspace?.branch || row.run?.launchProvenance?.branch || row.provenance?.branch || row.provenance?.headRefName, repo: row.workspace?.repo || row.provenance?.repo || row.run?.launchProvenance?.repoFullName || row.run?.launchProvenance?.repo,
          directory_name: directoryName, present: directoryName ? existsSync(join(row.directory, directoryName)) : null,
          manifest_state: row.workspace ? 'available' : existsSync(join(row.directory, 'workspace.json')) ? 'invalid' : 'missing'};
      }), complete: offset + 50 >= allRows.length, next_offset: offset + 50 < allRows.length ? offset + 50 : null, scope_complete: false, mutation_authority: false};
  }
  if (selector.observation === 'workers' && (selector.worker_id || selector.inventory)) {
    const rows = records(root, {canonical: true}).filter(row => row.launchRequestId && (!selector.worker_id || row.workerId === selector.worker_id));
    return {schema_version: 1, observation: 'workers', status: rows.length ? 'found' : 'not_found',
      items: rows.map(row => ({run_id: row.runId, launch_request_id: row.launchRequestId, worker_id: row.workerId,
        branch: row.workspace?.branch, status: row.run?.status || 'running'})), complete: true, next_offset: null,
      scope_complete: false, mutation_authority: false};
  }
  if (selector.observation !== 'dispatch_files') return null;
  const rows = records(root, {canonical: true});
  const row = rows.find(row => selector.launch_request_id === row.launchRequestId || selector.worker_run_id === row.runId);
  const lrq = selector.launch_request_id || row?.launchRequestId;
  const file = join(root, 'dispatch', lrq || 'missing', `${selector.stream || 'stdout'}.log`);
  const contract = object(join(root, 'dispatch', lrq || 'missing', 'env-contract.json'));
  let text; try { text = readFileSync(file, 'utf8'); } catch { text = null; }
  if (!row && text === null && !contract) return {schema_version: 1, status: 'not_found', metadata: null, log: null, scope_complete: false, mutation_authority: false};
  const runId = row?.runId || contract?.launchProvenance?.workerRunId || 'run-fixture';
  const workspace = row?.workspace || {};
  const raw = workspace.workspacePath || workspace.worktreePath;
  const directoryName = raw ? basename(raw) : null;
  const size = text === null ? 0 : Buffer.byteLength(text);
  return {schema_version: 1, status: 'found', launchRequestId: lrq, runId,
    metadata: {status: 'found', workerId: row?.workerId, launchRequestId: lrq, runId,
      run: {runId, launchRequestId: lrq}, workspace: {...workspace, directoryName,
        present: row?.slotAbsent ? false : raw ? existsSync(raw.startsWith('/') ? raw : join(row.directory, raw)) : undefined},
      fileStates: {run: row?.run ? 'available' : 'missing', workspace: row?.workspace ? 'available' : 'missing'},
      launchProvenance: row?.run?.launchProvenance || {}, complete: Boolean(row?.run && row?.workspace),
      ...(contract?.launchProvenance?.launchRequestId === lrq ? {launchEnvironment: {dispatchReadsEnabled: contract.ADVERSARIAL_DISPATCH_READS_ENABLED === '1'}} : {})},
    log: text === null ? {status: 'missing', text: '', redacted: true}
      : {status: 'found', text, redacted: true, offset: 0, nextOffset: size, size, generation: 'fixture', reset: false, truncated: false, complete: true},
    scope_complete: false, mutation_authority: false};
}

export function installDispatchFileProducerFixture() {
  const originalHost = dispatchReadTransport.hostServices;
  dispatchReadTransport.hostServices = async (request, args = {}) => rootOf(args)
    ? dispatchReadTransport.hostServicesSync(request, args) : originalHost(request, args);
  const originalHostSync = dispatchReadTransport.hostServicesSync;
  dispatchReadTransport.hostServicesSync = (request, args = {}) => {
    const root = rootOf(args);
    if (!root) return originalHostSync(request, args);
    let data;
    if (request.action === 'worker_registry') {
      const registry = object(join(root, 'registry/worker-classes.json'));
      data = {classes: registry?.classes || registry || (existsSync(join(root, 'registry/worker-classes.json')) ? {} : fixtureWorkerClasses)};
    } else if (request.action === 'deploy_status') {
      const statePath = join(root, 'main-catchup/.state.json');
      const state = object(statePath);
      data = state ? {availability: 'available', currentState: state.currentState,
        freezeClass: state.freezeClass || state.pendingFreeze?.freezeClass || state.pendingPgSchemaGateFreeze?.freezeClass || state.pendingRecovery?.freezeClass,
        schemaGatePending: Boolean(state.pendingPgSchemaGateFreeze), schemaHealPending: Boolean(state.pendingPgSchemaSelfHeal),
        recoveryFreezeClass: state.pendingRecovery?.classification?.freezeClass} : {availability: existsSync(statePath) ? 'unreadable' : 'missing'};
    } else if (request.action === 'dispatch_health') {
      const path = join(root, 'dispatch/_daemon/daemon.err.log');
      let log; try { const text = readFileSync(path, 'utf8'); log = {status: 'found', text, redacted: true, updatedAtEpochMs: statSync(path).mtimeMs}; }
      catch { log = {status: 'missing', text: '', redacted: true}; }
      data = {log};
    } else if (request.action === 'merge_backlog') {
      const owner = object(join(root, '.hq/config.json'))?.ownerUser || args.env?.AUTO_MERGE_OWNER_USER || args.env?.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_OWNER_USER;
      const state = owner && object(join(root, 'dispatch', `_auto_merge-${owner}`, 'daemon-state.json')) || object(join(root, 'dispatch/_auto_merge/daemon-state.json'));
      data = state ? {present: true, dirtyPrBacklog: state.dirtyPrBacklog} : {present: false};
    } else if (request.action === 'dispatch_audit') {
      const records = [];
      let days; try { days = readdirSync(join(root, 'dispatch/audit')); } catch { days = []; }
      for (const day of days) {
        let text; try { text = readFileSync(join(root, 'dispatch/audit', day, request.launch_request_id + '.jsonl'), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) { try { records.push({recordedAt: day + 'T00:00:00Z', ...JSON.parse(line)}); } catch {} }
      }
      data = {records};
    } else return originalHostSync(request, args);
    return {schema_version: 1, status: 'found', data};
  };
  const originalLookup = dispatchReadTransport.lookup;
  const originalSync = dispatchReadTransport.observationSync;
  dispatchReadTransport.lookup = async (selector, args = {}) => reply(selector, args) ?? originalLookup(selector, args);
  dispatchReadTransport.observationSync = (selector, args = {}) => reply(selector, args) ?? originalSync(selector, args);
}

export function seedWorkerRegistry(root, classes, {malformed = false} = {}) {
  if (!disposable(root)) throw new Error('fixture registry requires disposable root');
  const directory = join(root, 'registry');
  mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, 'worker-classes.json'), malformed ? '{ invalid json' : JSON.stringify({classes}));
}
