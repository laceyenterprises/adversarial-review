import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkItemState, latestCheckRollupItems } from './checks-summary.mjs';

const execFileAsync = promisify(execFile);

// Exclusive creation makes recovery budgets durable across ticks and processes.
function reserve(rootDir, identity, record) {
  const dir = join(rootDir, 'dispatch', 'ci-recovery');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${createHash('sha256').update(identity).digest('hex')}.json`);
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return { created: true, record };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { created: false, record: JSON.parse(readFileSync(path, 'utf8')) };
  }
}

export async function pageCiOnce({ rootDir, repo, prNumber, headSha, reason,
  dedupeKey = reason, execFileImpl = execFileAsync, env = process.env, signal }) {
  signal?.throwIfAborted();
  const claim = reserve(rootDir, `page:${repo}:${prNumber}:${headSha}:${dedupeKey}`, { reason });
  if (!claim.created) return false;
  await execFileImpl('hq', ['decision', 'raise', '--question',
    `${repo}#${prNumber}@${headSha}: ${reason}`, '--option', 'Investigate CI',
    '--option', 'Keep PR parked', '--recommended', 'Investigate CI'], { env, signal, timeout: 30_000 });
  return true;
}

// Only an all-cancelled non-green set is recoverable. Missing contexts, pending
// jobs and real failures remain with their existing admission/repair paths.
export async function recoverCancelledChecks({ rootDir, repo, prNumber, headSha,
  failedChecks = [], pendingChecks = [], execFileImpl = execFileAsync, env = process.env, signal }) {
  if (!headSha || !rootDir || !failedChecks.length || pendingChecks.length
    || failedChecks.some(check => check.state !== 'CANCELLED')) return false;
  for (const check of failedChecks) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(check.detailsUrl || '');
    if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return false;
  }
  const { stdout: prJson } = await execFileImpl('gh', ['pr', 'view', String(prNumber),
    '--repo', repo, '--json', 'state,headRefOid'], { env, signal, timeout: 30_000 });
  const pr = JSON.parse(prJson);
  if (pr.state !== 'OPEN' || pr.headRefOid !== headSha) return false;
  // Snapshot each workflow before any POST. Multiple cancelled checks can belong
  // to one run, and the POST can immediately move that run back to queued.
  const runIds = [...new Set(failedChecks.map(check => /\/actions\/runs\/(\d+)/.exec(check.detailsUrl)[1]))];
  const snapshots = await Promise.allSettled(runIds.map(async runId => {
    const { stdout } = await execFileImpl('gh', ['api', `repos/${repo}/actions/runs/${runId}`], { env, signal, timeout: 30_000 });
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
    const claim = reserve(rootDir, `rerun:${repo.toLowerCase()}:${headSha}:${check.name.trim().toLowerCase()}`, {
      runId, attempt: run.run_attempt, headSha, check: check.name, requestedAt: new Date().toISOString(),
    });
    if (claim.created && reserve(rootDir, `workflow-rerun:${repo.toLowerCase()}:${headSha}:${runId}`, {
      runId, attempt: run.run_attempt,
    }).created) {
      try {
        await execFileImpl('gh', ['api', '--method', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`], { env, signal, timeout: 30_000 });
      } catch (error) {
        if (signal?.aborted) throw error;
        await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: `cancelled check rerun failed: ${check.name}`, execFileImpl, env, signal });
        throw error;
      }
    } else if (claim.record.runId !== runId || run.run_attempt > claim.record.attempt) {
      await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: `required check cancelled again: ${check.name}`,
        dedupeKey: 'required-checks-cancelled-again', execFileImpl, env, signal });
    }
  }
  return true;
}

// Empty rollups alone never authorize bootstrap. Inspect repository workflows
// and BOTH classic branch protection and effective ruleset rules on the base.
export async function confirmNoCi({ repo, baseBranch, execFileImpl = execFileAsync, env = process.env, signal }) {
  if (!baseBranch) return false;
  const api = async path => JSON.parse((await execFileImpl('gh', ['api', path], { env, signal, timeout: 30_000 })).stdout);
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
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, sortedJson(item)]));
  return value;
}

// CI runner Ed25519 sidecars use Python json.dumps(sort_keys=True,
// separators=(',', ':')), including ASCII escaping and nested check records.
export function verifyManagedCiRecord(record, publicKey, { repo, headSha }) {
  if (record?.schemaVersion !== 1 || record.headSha !== headSha
    || record.verdict !== 'green' || record.repo?.toLowerCase() !== repo.toLowerCase()
    || !/^[0-9a-f]{128}$/i.test(record.signature || '')) return false;
  const payload = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !['signature', 'signatureAlgorithm'].includes(key)));
  const bytes = JSON.stringify(sortedJson(payload)).replace(/[\u007f-\uffff]/g,
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
          // Match the managed pre-push gate's cooperative GitHub hosting mode.
          // Full-mirror deployments always require the CI runner signature.
          return (env.AGENT_OS_CI_HOSTING_MODE || 'github') === 'github'
            && record.mode === 'github' && record.schemaVersion === 1
            && record.headSha === headSha && record.repo?.toLowerCase() === repo.toLowerCase()
            && record.verdict === 'green' && /^sha256:[0-9a-f]{64}$/.test(record.manifestHash || '');
        } catch { return false; }
      });
  } catch { return false; }
}

export async function inspectCiBootstrap({ rootDir, repo, prNumber, headSha,
  baseBranch, rollup, ownContext, requiredContexts = [], execFileImpl = execFileAsync,
  env = process.env, readAttestationImpl = readGreenManagedCi, signal }) {
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return { mode: null };
  if (requiredContexts.length || !emptyExternalRollup(rollup, ownContext)) return { mode: null };
  if (!await confirmNoCi({ repo, baseBranch, execFileImpl, env, signal })) return { mode: null };
  if (!await readAttestationImpl({ repo, headSha, env })) {
    if (rootDir) await pageCiOnce({ rootDir, repo, prNumber, headSha, reason: 'repo has no CI', execFileImpl, env, signal });
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
