import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync, unlinkSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execGhWithRetry } from './gh-cli.mjs';
import { maybeFireOperatorDecisionRequiredAlert } from './watcher-no-progress-lane.mjs';
import { deliverAlert } from './alert-delivery.mjs';
import { checkItemState, latestCheckRollupItems } from './checks-summary.mjs';

const execFileAsync = promisify(execFile);

// Exclusive creation makes recovery budgets durable across ticks and processes.
function reserve(rootDir, identity, record) {
  const dir = join(rootDir, 'dispatch', 'ci-recovery');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${createHash('sha256').update(identity).digest('hex')}.json`);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const stamped = { ...record, reservedAt: new Date().toISOString() };
  try {
    writeFileSync(temporaryPath, JSON.stringify(stamped), { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporaryPath, path);
      return { created: true, record: stamped, path };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(readFileSync(path, 'utf8')); }
      catch { existing = { ...record, state: 'reserved', reservedAt: statSync(path).mtime.toISOString() }; }
      return { created: false, record: existing, path };
    }
  } finally { unlinkSync(temporaryPath); }
}

// A stale action is retried only after fresh remote evidence allows it. Each
// minute has an exclusive recovery claim, including after another process crash.
function resumeReservation(rootDir, identity, claim) {
  if (claim.created || claim.record.state !== 'reserved') return claim;
  const age = Date.now() - Date.parse(claim.record.reservedAt || 0);
  if (Number.isFinite(age) && age < 60_000) return claim;
  const retry = reserve(rootDir, `${identity}:resume:${Math.floor(Date.now() / 60_000)}`, claim.record);
  if (retry.created) {
    const temporaryPath = `${claim.path}.${randomUUID()}.reserved`;
    writeFileSync(temporaryPath, JSON.stringify(retry.record), { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, claim.path);
  }
  return { ...retry, path: claim.path };
}

// Keep the exclusive claim during delivery. A rejected action releases it so a
// later tick can retry; only a successful action becomes a consumed budget.
async function postReservation(claim, action) {
  let result;
  try {
    result = await action();
  } catch (error) {
    unlinkSync(claim.path);
    throw error;
  }
  // Preserve the reservation if persistence fails after the accepted action.
  const temporaryPath = `${claim.path}.${randomUUID()}.posted`;
  writeFileSync(temporaryPath, JSON.stringify({ ...claim.record, state: 'posted' }), { mode: 0o600 });
  renameSync(temporaryPath, claim.path);
  return result;
}

export async function pageCiOnce({ rootDir, repo, prNumber, headSha, reason,
  dedupeKey = reason, env = process.env, signal,
  deliverAlertImpl = deliverAlert }) {
  if (!rootDir) return false;
  signal?.throwIfAborted();
  const identity = `page:${repo.toLowerCase()}:${prNumber}:${headSha}:${dedupeKey}`;
  const claim = resumeReservation(rootDir, identity, reserve(rootDir, identity,
    { reason, state: 'reserved' }));
  if (!claim.created) return false;
  return postReservation(claim, () => maybeFireOperatorDecisionRequiredAlert({
    rootDir, identity: { repo, prNumber }, headSha, fingerprint: `ci:${dedupeKey}`,
    noProgressTicks: 1, thresholdTicks: 1,
    deliverAlertFn: (_text, metadata) => deliverAlertImpl(
      `${repo}#${prNumber}@${headSha}: ${reason}`, { ...metadata, env,
        payload: { ...metadata.payload, reason } }),
  }));
}

// Only an all-cancelled non-green set is recoverable. Missing contexts, pending
// jobs and real failures remain with their existing admission/repair paths.
export async function recoverCancelledChecks({ rootDir, repo, prNumber, headSha,
  failedChecks = [], pendingChecks = [], execFileImpl = execFileAsync, env = process.env, signal, deliverAlertImpl = deliverAlert }) {
  if (!headSha || !rootDir || !failedChecks.length || pendingChecks.length
    || failedChecks.some(check => check.state !== 'CANCELLED')) return false;
  for (const check of failedChecks) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(check.detailsUrl || '');
    if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return false;
  }
  const { stdout: prJson } = await execGhWithRetry({ execFileImpl, args: ['pr', 'view', String(prNumber),
    '--repo', repo, '--json', 'state,headRefOid'], env, signal });
  const pr = JSON.parse(prJson);
  if (pr.state !== 'OPEN' || pr.headRefOid !== headSha) return false;
  // Snapshot each workflow before any POST. Multiple cancelled checks can belong
  // to one run, and the POST can immediately move that run back to queued.
  const runIds = [...new Set(failedChecks.map(check => /\/actions\/runs\/(\d+)/.exec(check.detailsUrl)[1]))];
  const snapshots = await Promise.allSettled(runIds.map(async runId => {
    const { stdout } = await execGhWithRetry({ execFileImpl, args: ['api', `repos/${repo}/actions/runs/${runId}`], env, signal });
    return [runId, JSON.parse(stdout)];
  }));
  const errors = snapshots.filter(snapshot => snapshot.status === 'rejected');
  if (errors.length) throw errors[0].reason;
  const runs = new Map(snapshots.map(snapshot => snapshot.value));
  for (const run of runs.values()) {
    if (run.head_sha !== headSha || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) return false;
    if (run.conclusion !== 'cancelled'
      && !['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return false;
  }
  if ([...runs.values()].some(run => run.conclusion !== 'cancelled')) return true;
  for (const check of failedChecks) {
    const runId = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl)[1];
    const run = runs.get(runId);
    const claim = reserve(rootDir, `rerun:${repo.toLowerCase()}:${headSha}:${runId}:${check.name.trim().toLowerCase()}`, {
      runId, attempt: run.run_attempt, headSha, check: check.name, requestedAt: new Date().toISOString(),
    });
    if (claim.record.runId !== runId || run.run_attempt > claim.record.attempt) {
      await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: `required check cancelled again: ${check.name}`,
        dedupeKey: 'required-checks-cancelled-again', env, signal, deliverAlertImpl });
      continue;
    }
    // The workflow claim controls the side effect, even when a check identity
    // was recorded on an earlier failed tick or by another caller.
    const identity = `workflow-rerun:${repo.toLowerCase()}:${headSha}:${runId}`;
    const workflow = resumeReservation(rootDir, identity, reserve(rootDir, identity, {
      runId, attempt: run.run_attempt, state: 'reserved',
    }));
    if (workflow.created) {
      // Do not retry this POST in-call: a lost response may hide an accepted
      // rerun. The next tick reads the workflow snapshot before retrying.
      await postReservation(workflow, () => execFileImpl('gh', ['api', '--method', 'POST',
        `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`], { env, signal, timeout: 30_000 }));
    }
  }
  return true;
}

// Empty rollups alone never authorize bootstrap. Inspect repository workflows
// and BOTH classic branch protection and effective ruleset rules on the base.
export async function confirmNoCi({ repo, headSha, baseBranch, execFileImpl = execFileAsync, env = process.env, signal }) {
  if (!baseBranch || !/^[0-9a-f]{40}$/.test(headSha || '')) return false;
  const api = async path => JSON.parse((await execGhWithRetry({ execFileImpl, args: ['api', path], env, signal })).stdout);
  try {
    const workflows = await api(`repos/${repo}/actions/workflows?per_page=1`);
    if (workflows.total_count !== 0 || !Array.isArray(workflows.workflows) || workflows.workflows.length) return false;
    const branch = await api(`repos/${repo}/branches/${encodeURIComponent(baseBranch)}`);
    if (branch.name !== baseBranch || typeof branch.protected !== 'boolean') return false;
    // Protected branches require an explicit readable protection snapshot.
    if (branch.protected) {
      const protection = await api(`repos/${repo}/branches/${encodeURIComponent(baseBranch)}/protection`);
      if (protection.required_status_checks != null) return false;
    }
    const rules = await api(`repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`);
    if (!Array.isArray(rules) || rules.some(rule => !rule?.type || rule.type === 'required_status_checks' || rule.type === 'workflows')) return false;
    const statuses = await api(`repos/${repo}/commits/${headSha}/status`);
    const suites = await api(`repos/${repo}/commits/${headSha}/check-suites`);
    if (statuses.total_count !== 0 || !Array.isArray(statuses.statuses) || statuses.statuses.length
      || suites.total_count !== 0 || !Array.isArray(suites.check_suites) || suites.check_suites.length) return false;
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function compareCodePoints(a, b) {
  const left = Array.from(a, char => char.codePointAt(0));
  const right = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

// CI runner Ed25519 sidecars use Python json.dumps(sort_keys=True,
// separators=(',', ':')), including ASCII escaping and nested check records.
export function verifyManagedCiRecord(record, publicKey, { repo, headSha }) {
  if (record?.schemaVersion !== 1 || record.headSha !== headSha
    || record.verdict !== 'green' || record.repo?.toLowerCase() !== repo.toLowerCase()
    || !/^[0-9a-f]{128}$/i.test(record.signature || '')) return false;
  const payload = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !['signature', 'signatureAlgorithm'].includes(key)));
  const bytes = sortedJson(payload).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  try {
    const key = createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), publicKey,
    ]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(bytes), key, Buffer.from(record.signature, 'hex'));
  } catch { return false; }
}

export function readGreenManagedCi({ repo, headSha, env = process.env }) {
  if (!/^[0-9a-f]{40}$/.test(headSha || '') || !env.HQ_ROOT) return false;
  try {
    const root = realpathSync(env.HQ_ROOT);
    const owner = statSync(root).uid;
    let key = null;
    if (env.AGENT_OS_CI_ATTESTATION_PUBLIC_KEY_PATH) {
      const raw = readFileSync(env.AGENT_OS_CI_ATTESTATION_PUBLIC_KEY_PATH);
      key = raw.length === 32 ? raw : /^[0-9a-f]{64}$/i.test(raw.toString().trim())
        ? Buffer.from(raw.toString().trim(), 'hex') : Buffer.from(raw.toString().trim(), 'base64');
      if (key.length !== 32) return false;
    }
    return readdirSync(join(root, 'workers'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).some(entry => {
        try {
          const path = join(root, 'workers', entry.name, 'logs', 'ci-attestations', `${headSha}.json`);
          if (realpathSync(path) !== path || statSync(path).uid !== owner) return false;
          const record = JSON.parse(readFileSync(path, 'utf8'));
          if (record.signature) return key && verifyManagedCiRecord(record, key, { repo, headSha });
          return false;
        } catch { return false; }
      });
  } catch { return false; }
}

export async function inspectCiBootstrap({ rootDir, repo, prNumber, headSha,
  baseBranch, rollup, ownContext, requiredContexts = [], execFileImpl = execFileAsync,
  env = process.env, readAttestationImpl = readGreenManagedCi, signal,
  deliverAlertImpl = deliverAlert }) {
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return { mode: null };
  if (requiredContexts.length || !emptyExternalRollup(rollup, ownContext)) return { mode: null };
  if (!await confirmNoCi({ repo, headSha, baseBranch, execFileImpl, env, signal })) return { mode: null };
  if (!await readAttestationImpl({ repo, headSha, env })) {
    if (rootDir) await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: 'repo has no CI', env, signal, deliverAlertImpl });
    return { mode: null, noCi: true };
  }
  return { mode: 'no-ci-bootstrap', noCi: true, headSha };
}

export function emptyExternalRollup(rollup, ownContext) {
  return Array.isArray(rollup) && latestCheckRollupItems(rollup).every(item =>
    (!item.__typename || item.__typename === 'StatusContext')
    && String(item.context || '').toLowerCase() === ownContext.toLowerCase()
    && checkItemState(item) === 'SUCCESS');
}
