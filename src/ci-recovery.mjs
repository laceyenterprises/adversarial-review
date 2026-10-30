import { withRepositoryStateCycle } from './repository-state-lock.mjs';
import { canonicalRepositoryArguments, repositoryNames, resolveRepositoryName } from './repository-names.mjs';
import { rekeyRepositoryValue } from './repository-state-files.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { readHostObservationSync } from './dispatch-files-client.mjs';
import { checkInfrastructureReason, infrastructureOnlyFailures } from './ci-infrastructure.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { meteredExecFile } from './metered-gh.mjs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execGhWithRetry } from './gh-cli.mjs';
import { maybeFireOperatorDecisionRequiredAlert } from './watcher-no-progress-lane.mjs';
import { deliverAlert } from './alert-delivery.mjs';
import { checkItemState, latestCheckRollupItems } from './checks-summary.mjs';

const execFileAsync = promisify(execFile);

// Budgets are durable runtime state, so they live under the gitignored `data/`
// tree beside reviews.db. The watcher root is the adversarial-review checkout,
// which production deploys as an agent-os submodule: anything written outside
// `data/` is an untracked file that makes main-catchup refuse to deploy
// (CIRECOVERDIRT-01). The legacy `dispatch/` directory is only ever read.
export function ciRecoveryStateDir(rootDir) {
  return join(rootDir, 'data', 'ci-recovery');
}

function legacyCiRecoveryStateDir(rootDir) {
  return join(rootDir, 'dispatch', 'ci-recovery');
}

// Carry a pre-CIRECOVERDIRT reservation forward once so its once-per-head
// budget is not reset by the move. Linking never replaces a reservation that
// already exists at the new path, and the legacy file is then removed so it
// no longer dirties the checkout.
function migrateLegacyReservation(rootDir, name, path) {
  const legacyPath = join(legacyCiRecoveryStateDir(rootDir), name);
  let contents;
  try { contents = readFileSync(legacyPath); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.migrating`;
  writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temporaryPath, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally { unlinkSync(temporaryPath); }
  try { unlinkSync(legacyPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Exclusive creation makes recovery budgets durable across ticks and processes.
function reserve(rootDir, identity, record) {
  const dir = ciRecoveryStateDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const name = `${createHash('sha256').update(identity).digest('hex')}.json`;
  const path = join(dir, name);
  migrateLegacyReservation(rootDir, name, path);
  // Early versions stored only the digest, so their identity cannot be
  // reconstructed during bulk migration. Resolve the exact historical key
  // on access before spending another CI recovery budget.
  const repo = /^(?:page|rerun|workflow-rerun):([^:]+):/.exec(identity)?.[1];
  if (repo && !existsSync(path)) {
    for (const alias of repositoryNames(rootDir, repo)) {
      if (alias.toLowerCase() === repo.toLowerCase()) continue;
      const oldIdentity = identity.replace(`:${repo}:`, `:${alias.toLowerCase()}:`);
      const oldName = `${createHash('sha256').update(oldIdentity).digest('hex')}.json`;
      if (resolveRepositoryName(rootDir, alias).toLowerCase() !== repo.toLowerCase()
        && (existsSync(join(dir, oldName)) || existsSync(join(legacyCiRecoveryStateDir(rootDir), oldName)))) {
        throw new Error(`Ambiguous legacy CI reservation for reused repository name: ${alias}`);
      }
      migrateLegacyReservation(rootDir, oldName, join(dir, oldName));
      const oldPath = join(dir, oldName);
      if (!existsSync(oldPath)) continue;
      let prior;
      try { prior = rekeyRepositoryValue(JSON.parse(readFileSync(oldPath, 'utf8')), alias, repo); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { writeFileAtomic(path, JSON.stringify({ ...prior, identity }), { overwrite: false, mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      try { unlinkSync(oldPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      break;
    }
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const stamped = { ...record, identity, reservedAt: new Date().toISOString() };
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

async function pageCiOnceWithinRepositoryState({ rootDir, repo, prNumber, headSha, reason,
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

// Only capacity-annotated zero-step failures authorize infrastructure reruns.
// Pending/missing contexts never rerun; the existing per-head budget applies.
async function recoverInfrastructureChecksWithinRepositoryState(options) {
  const { repo, headSha, failedChecks, pendingChecks = [], rootDir,
    execFileImpl = execFileAsync, env = process.env, signal } = options;
  if (!rootDir || !headSha || pendingChecks.length || !infrastructureOnlyFailures(failedChecks)) return false;
  const targets = failedChecks.map(check => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:\?.*)?$/.exec(check.detailsUrl || ''));
  if (targets.some(match => !match || match[1].toLowerCase() !== repo.toLowerCase())) return false;
  // Re-read latest jobs before any side effect: old rollups/cached zero-step
  // evidence cannot authorize rerunning a newer attempt that actually executed.
  for (const runId of new Set(targets.map(match => match[2]))) {
    const { stdout } = await execGhWithRetry({ execFileImpl, env, signal,
      args: ['api', `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`] });
    const payload = JSON.parse(stdout);
    const jobs = payload.jobs;
    if (!Array.isArray(jobs)) return false;
    const total = payload.total_count;
    if (Number.isInteger(total) && total > jobs.length) return false;
    const required = targets.filter(match => match[2] === runId);
    if (!required.every(match => jobs.some(job => String(job.id) === match[3]
      && job.head_sha === headSha && infrastructureOnlyFailures([job])))) return false;
    // rerun-failed-jobs affects every failed job in the workflow, including
    // optional jobs. A sibling code failure must never borrow capacity proof.
    const failures = jobs.filter(job => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(checkItemState(job)));
    for (const job of failures) {
      if (job.head_sha !== headSha || !infrastructureOnlyFailures([job])) return false;
      if (checkInfrastructureReason(job) !== 'actions-billing-quota') {
        const match = /^https:\/\/api\.github\.com\/(repos\/[^/]+\/[^/]+\/check-runs\/\d+)$/.exec(job.check_run_url || '');
        if (!match || !match[1].toLowerCase().startsWith(`repos/${repo.toLowerCase()}/check-runs/`)) return false;
        const { stdout: annotations } = await execGhWithRetry({ execFileImpl, env, signal,
          args: ['api', `${match[1]}/annotations?per_page=100`] });
        if (checkInfrastructureReason({ ...job, annotations: JSON.parse(annotations) }) !== 'actions-billing-quota') return false;
      }
    }
  }
  return recoverFailedChecks({ ...options, infrastructure: true });
}

async function recoverCancelledChecksWithinRepositoryState(options) {
  return recoverFailedChecks(options);
}

async function recoverFailedChecks({ rootDir, repo, prNumber, headSha,
  failedChecks = [], pendingChecks = [], infrastructure = false, execFileImpl = execFileAsync, env = process.env, signal, deliverAlertImpl = deliverAlert }) {
  if (!headSha || !rootDir || !failedChecks.length || pendingChecks.length
    || (infrastructure ? !infrastructureOnlyFailures(failedChecks)
      : failedChecks.some(check => check.state !== 'CANCELLED'))) return false;
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
  const settledConclusion = run => infrastructure
    ? ['failure', 'timed_out', 'action_required', 'stale', 'startup_failure', 'cancelled'].includes(run.conclusion)
    : run.conclusion === 'cancelled';
  for (const run of runs.values()) {
    if (run.head_sha !== headSha || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) return false;
    if (!settledConclusion(run)
      && !['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return false;
  }
  if ([...runs.values()].some(run => !settledConclusion(run))) return true;
  for (const check of failedChecks) {
    const runId = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl)[1];
    const run = runs.get(runId);
    const claim = reserve(rootDir, `rerun:${repo.toLowerCase()}:${headSha}:${runId}:${check.name.trim().toLowerCase()}`, {
      runId, attempt: run.run_attempt, headSha, check: check.name, requestedAt: new Date().toISOString(),
    });
    if (claim.record.runId !== runId || run.run_attempt > claim.record.attempt) {
      await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: `required check ${infrastructure ? 'infrastructure-blocked' : 'cancelled'} again: ${check.name}`,
        dedupeKey: infrastructure ? 'required-checks-infrastructure-again' : 'required-checks-cancelled-again', env, signal, deliverAlertImpl });
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
      await postReservation(workflow, () => meteredExecFile(execFileImpl, 'gh', ['api', '--method', 'POST',
        `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`], { env, signal, timeout: loadAwareTimeoutMs(30_000) }));
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

export function readGreenManagedCi({ repo, headSha, env = process.env,
  readProofImpl = readHostObservationSync }) {
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return false;
  try {
    const reply = readProofImpl('managed_ci', {env, parameters: {repo, head_sha: headSha}});
    return reply.ok === true && reply.data?.verified === true
      && reply.data.repo?.toLowerCase() === repo.toLowerCase() && reply.data.headSha === headSha;
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

export async function pageCiOnce(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    pageCiOnceWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}

export async function recoverInfrastructureChecks(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    recoverInfrastructureChecksWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}

export async function recoverCancelledChecks(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    recoverCancelledChecksWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}
