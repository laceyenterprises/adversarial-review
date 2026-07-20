import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile as readFileAsync, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuildCompletionSignalForPr } from './session-ledger-read-adapter.mjs';
import { isTransientGhError } from './gh-cli.mjs';

const execFileAsync = promisify(execFile);

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HEAD_ATTESTATION_CHAIN_RETRY_DELAYS_MS = [250, 1000];

// Attestation-resolve failure reasons that mean the LHA layer is structurally
// UNABLE to function (infra down) rather than healthily refusing a head. Only
// these degrade daemon identity to the pr_opened path; every other reason (no
// valid produced row, malformed attestation) fails closed to preserve the
// head-binding security property. `head-attestation-chain-read-failed` is what
// an unprovisioned/short HMAC key produces (the `hq attest chain` subprocess
// raises HCPHeadAttestationConfigurationError) — the 2026-07-15 outage class.
const ATTESTATION_INFRA_FAILURE_REASONS = new Set(['head-attestation-chain-read-failed']);

export async function resolveDaemonWorkerIdentityForPr({
  repo,
  prNumber,
  currentHeadSha = '',
  currentBranch = '',
  hqRoot,
  rootDir,
  env = process.env,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
  readHeadAttestationChainForPrImpl = readHeadAttestationChainForPr,
  consumeHeadAttestations = null,
  logger = console,
} = {}) {
  const currentHead = String(currentHeadSha || '').trim();
  if (!currentHead) {
    return { ok: false, reason: 'missing-current-head-sha' };
  }
  // Set when attestation consumption is ON but the attestation layer could not
  // confirm identity and we degraded to the pr_opened path (see the block
  // below). Spread into every downstream return so the disposition/telemetry
  // records the degrade; null on the healthy path.
  let attestationDegrade = null;
  const stamp = (result) => (attestationDegrade ? { ...result, ...attestationDegrade } : result);
  // LHA-06 remediation (gemini blocking): consume ONLY when the caller resolved
  // the flag from the canonical AgentOSConfig (which layers YAML under env). The
  // removed env-only fallback returned `true` on an unset env var, silently
  // ignoring a YAML rollback (`consume_attestations: false`) on the default-param
  // path — a split-brain that would keep enforcing LHA even after an operator
  // disabled the cutover. Callers pass the resolved value; an unresolved value
  // fails safe to NOT consuming (legacy path), never to enforcing.
  if (consumeHeadAttestations === true) {
    const attested = await resolveDaemonWorkerIdentityFromHeadAttestation({
      repo,
      prNumber,
      currentHeadSha: currentHead,
      hqRoot,
      rootDir,
      env,
      readHeadAttestationChainForPrImpl,
    });
    if (attested.ok) {
      return attested;
    }
    // Durable degrade (2026-07-16, HAMMER-CLOSE-MODEL): degrade to the pr_opened
    // path ONLY when the attestation layer is structurally UNABLE to function —
    // an infra failure — never when it is healthy and actively refusing this
    // head. The discriminator is the reason:
    //   * `head-attestation-chain-read-failed` — `hq attest chain` errored. This
    //     is exactly what an unprovisioned/short LHA HMAC key produces:
    //     attest_verify -> _normalize_attestation_signing_key raises
    //     HCPHeadAttestationConfigurationError (re-raised past the generic
    //     catch), so the --json chain subprocess exits non-zero. It also covers
    //     a locked/broken ledger read. This is the class that zeroed autonomous
    //     merge fleet-wide on 2026-07-15 when the key went unprovisioned.
    //   * `missing-produced-head-attestation` / `missing-launch-request-id` /
    //     `missing-worker-class` — the chain READ fine but has no valid produced
    //     row at head (a worker that genuinely did not attest, an attacker
    //     suppressing one, or a signing-key MISMATCH that fails verification).
    //     That is the security signal LHA exists to enforce; degrading here would
    //     defeat the crypto, so we FAIL CLOSED (return the not-ok as before).
    // Attestation is a HEAD-BINDING enhancement layered on the pr_opened ledger
    // identity, not the sole identity authority — so on an infra failure we fall
    // through to pr_opened rather than parking. This can never manufacture an
    // identity absent from the ledger: if pr_opened ALSO fails to resolve, the
    // resolver still returns not-ok (fail closed). Head-binding security holds
    // downstream regardless — the verdict is pinned to commit_id===head, CI is
    // green at head, and the live head is re-read before the merge click.
    // Stamped + logged so a PERSISTENT degrade is an operator signal to
    // reprovision the key (GPR-01 Sentinel can aggregate on the reason).
    if (!ATTESTATION_INFRA_FAILURE_REASONS.has(attested.reason)) {
      return attested;
    }
    attestationDegrade = {
      attestationDegraded: true,
      attestationDegradeReason: attested.reason || 'attestation-unresolved',
    };
    logger?.warn?.(JSON.stringify({
      event: 'ama.identity.attestation_degraded_to_pr_opened',
      repo: String(repo || ''),
      pr: prNumber,
      head: currentHead,
      attestationReason: attestationDegrade.attestationDegradeReason,
    }));
  }
  // The daemon-clean-merge resolves the worker identity of a PR it is about to
  // merge (pre-merge). readBuildCompletionSignalForPr defaults signalKind to
  // 'merged', but the 'merged' signal is only recorded AFTER a PR merges — an
  // open PR only has the 'pr_opened' signal (2026-07-11 #565: #3473/#3476/#3478
  // all had a 'pr_opened' row but zero 'merged' rows).
  //
  // Identity is a STABLE property of PR origin — WHICH worker/launch opened the
  // PR — recorded once in the single 'pr_opened' row; it does not change when a
  // later commit is pushed. Pinning identity resolution to the CURRENT head
  // (#565 added `headSha: currentHead`) re-introduced the head-move deadlock the
  // resolver was meant to kill: the 'pr_opened' row stays pinned to the OPEN
  // head, so after any remediation/CI/rebase commit the current head no longer
  // matches → worker-identity-unresolved → BOTH merge routes fail-closed → every
  // remediated PR parks for manual merge (2026-07-14: 571 distinct PRs, ~0
  // autonomous merges). Fix: try the strict current-head row first (fast path,
  // unmoved PRs), then fall back to the head-independent 'pr_opened' row and flag
  // headMovedAfterBuildCompletion. Authorizing the moved head is NOT identity's
  // job — the verdict pinned to commit_id===head, CI-green-at-head, the live-head
  // re-read before merge, and the LHA attestation chain police it downstream.
  const strictArgs = {
    repo,
    prNumber,
    signalKind: 'pr_opened',
    headSha: currentHead,
    hqRoot,
    rootDir,
    env,
  };
  let resolved;
  try {
    resolved = await readBuildCompletionSignalForPrImpl(strictArgs);
  } catch (err) {
    return stamp({
      ok: false,
      reason: 'build-completion-read-failed',
      error: String(err?.message || err),
    });
  }
  let resolvedBy = 'current-head';
  if (!resolved?.ok) {
    // Head-independent retry: resolve the single 'pr_opened' row by PR, ignoring
    // head_sha (the reader matches any head when headSha is null/empty). Recovers
    // identity for PRs whose head moved after opening — the common case once a
    // PR is remediated. Kept distinct via resolvedBy so downstream sees it moved.
    let byPr;
    try {
      byPr = await readBuildCompletionSignalForPrImpl({ ...strictArgs, headSha: null });
    } catch (err) {
      return {
        ok: false,
        reason: 'build-completion-read-failed',
        error: String(err?.message || err),
      };
    }
    if (byPr?.ok) {
      resolved = byPr;
      resolvedBy = 'pr-opened-head-moved';
    }
  }
  if (!resolved?.ok) {
    const launchProvenance = await readDaemonWorkerLaunchProvenanceForPr({
      repo,
      prNumber,
      currentHeadSha: currentHead,
      currentBranch,
      hqRoot,
    });
    if (launchProvenance.ok) {
      return stamp({
        ok: true,
        launchRequestId: launchProvenance.launchRequestId,
        workerClass: launchProvenance.workerClass,
        rowHeadSha: launchProvenance.headSha || null,
        currentHeadSha: currentHead || null,
        resolvedBy: 'launch-provenance',
        headMovedAfterBuildCompletion: false,
        buildCompletionReason: resolved?.reason || 'missing-build-completion-signal',
        launchProvenancePath: launchProvenance.path,
      });
    }
    return stamp({
      ok: false,
      reason: resolved?.reason || 'missing-build-completion-signal',
      launchProvenanceReason: launchProvenance.reason,
    });
  }
  const launchRequestId = String(resolved.row?.launch_request_id ?? resolved.row?.launchRequestId ?? '').trim();
  const workerClass = String(resolved.row?.worker_class ?? resolved.row?.workerClass ?? '').trim();
  if (!launchRequestId || !workerClass) {
    return stamp({
      ok: false,
      reason: !launchRequestId ? 'missing-launch-request-id' : 'missing-worker-class',
      rowHeadSha: resolved.row?.head_sha ?? resolved.row?.headSha ?? null,
    });
  }
  const rowHeadSha = String(resolved.row?.head_sha ?? resolved.row?.headSha ?? '').trim();
  return stamp({
    ok: true,
    launchRequestId,
    workerClass,
    rowHeadSha: rowHeadSha || null,
    currentHeadSha: currentHead || null,
    resolvedBy,
    headMovedAfterBuildCompletion: Boolean(rowHeadSha && currentHead && rowHeadSha !== currentHead),
  });
}

export async function readHeadAttestationChainForPr({
  repo,
  prNumber,
  hqRoot,
  env = process.env,
  execFileImpl = execFileAsync,
  retryDelaysMs = HEAD_ATTESTATION_CHAIN_RETRY_DELAYS_MS,
  sleepImpl = sleepMs,
  logger = console,
} = {}) {
  const args = ['attest', 'chain', '--repo', String(repo || ''), '--pr', String(prNumber), '--json'];
  if (hqRoot) {
    args.splice(2, 0, '--root', String(hqRoot));
  }
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  let stdout = '';
  for (let attempt = 0; ; attempt += 1) {
    try {
      ({ stdout } = await execFileImpl('hq', args, {
        env,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      }));
      break;
    } catch (err) {
      if (!isTransientHeadAttestationReadError(err) || attempt >= delays.length) throw err;
      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      logger?.warn?.(
        `[watcher] hq attest chain transient failure for ${repo}#${prNumber}; ` +
        `retrying ${attempt + 1}/${delays.length} after ${delayMs}ms: ${err?.message || err}`
      );
      if (delayMs > 0) await sleepImpl(delayMs);
    }
  }
  const rows = JSON.parse(String(stdout || '[]'));
  return Array.isArray(rows) ? rows : [];
}

function isTransientHeadAttestationReadError(err) {
  if (isTransientGhError(err)) return true;
  const code = String(err?.code || '').toUpperCase();
  if (['EAGAIN', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)) return true;
  const detail = String(err?.stderr || err?.message || err || '');
  return /database is locked|resource temporarily unavailable|socket hang up/i.test(detail);
}

export async function resolveDaemonWorkerIdentityFromHeadAttestation({
  repo,
  prNumber,
  currentHeadSha,
  hqRoot,
  rootDir,
  env = process.env,
  readHeadAttestationChainForPrImpl = readHeadAttestationChainForPr,
} = {}) {
  const currentHead = String(currentHeadSha || '').trim();
  if (!currentHead) {
    return { ok: false, reason: 'missing-current-head-sha' };
  }
  let rows;
  try {
    rows = await readHeadAttestationChainForPrImpl({ repo, prNumber, hqRoot, rootDir, env });
  } catch (err) {
    return {
      ok: false,
      reason: 'head-attestation-chain-read-failed',
      error: String(err?.message || err),
    };
  }
  const produced = (Array.isArray(rows) ? rows : [])
    .filter((row) => (
      row?.kind === 'produced'
      && row?.valid === true
      && String(row?.head_sha || row?.headSha || '').trim() === currentHead
    ))
    .sort((a, b) => {
      const left = String(a?.ts || '');
      const right = String(b?.ts || '');
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .at(-1);
  if (!produced) {
    return { ok: false, reason: 'missing-produced-head-attestation' };
  }
  const payload = produced.payload && typeof produced.payload === 'object' ? produced.payload : {};
  const launchRequestId = String(
    payload.launch_request_id || payload.launchRequestId || produced.launch_request_id || produced.launchRequestId || '',
  ).trim();
  const workerClass = String(
    payload.worker_class || payload.workerClass || produced.worker_class || produced.workerClass || '',
  ).trim();
  if (!launchRequestId || !workerClass) {
    return {
      ok: false,
      reason: !launchRequestId ? 'missing-launch-request-id' : 'missing-worker-class',
      currentHeadSha: currentHead || null,
      attestationId: produced.attestation_id || produced.attestationId || null,
    };
  }
  return {
    ok: true,
    launchRequestId,
    workerClass,
    rowHeadSha: String(produced.head_sha || produced.headSha || '').trim() || null,
    currentHeadSha: currentHead || null,
    resolvedBy: 'head-attestation',
    headMovedAfterBuildCompletion: Boolean(produced.parent_head_sha || produced.parentHeadSha),
    attestationId: produced.attestation_id || produced.attestationId || null,
    producerIdentity: produced.producer_identity || produced.producerIdentity || null,
  };
}

function daemonLaunchProvenanceRepoMatches(recordRepo, expectedRepo) {
  const record = String(recordRepo || '').trim().toLowerCase();
  const expected = String(expectedRepo || '').trim().toLowerCase();
  if (!record || !expected) return false;
  // Launch provenance is merge-authority identity, so the repo string must carry
  // the same owner/name identity GitHub reports for the PR. A short `<name>`
  // record is ambiguous across forks and must fail closed until the producer
  // writes canonical `<owner>/<name>` provenance.
  return record === expected;
}

function daemonLaunchProvenancePayload(doc) {
  return doc?.launchProvenance && typeof doc.launchProvenance === 'object'
    ? doc.launchProvenance
    : doc;
}

async function readJsonFileBestEffort(path) {
  try {
    return JSON.parse(await readFileAsync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function listDaemonWorkerLaunchProvenanceCandidates(hqRoot) {
  const workersDir = join(String(hqRoot || ''), 'workers');
  let entries;
  try {
    entries = await readdir(workersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      join(workersDir, entry.name, 'launch-provenance.json'),
      join(workersDir, entry.name, 'run.json'),
      join(workersDir, entry.name, 'workspace.json'),
    ]);
  const candidates = await mapWithConcurrency(paths, 32, async (path) => {
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs };
    } catch {
      return null;
    }
  });
  return candidates.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readDaemonWorkerLaunchProvenanceForPr({
  repo,
  prNumber,
  currentHeadSha = '',
  currentBranch = '',
  hqRoot,
} = {}) {
  const expectedRepo = String(repo || '').trim();
  const expectedBranch = String(currentBranch || '').trim();
  const expectedHead = String(currentHeadSha || '').trim();
  const numericPrNumber = Number(prNumber);
  if (!expectedRepo || !Number.isInteger(numericPrNumber) || numericPrNumber <= 0) {
    return { ok: false, reason: 'missing-pr-identity' };
  }
  if (!expectedBranch) {
    return { ok: false, reason: 'missing-pr-branch' };
  }
  const candidates = (await listDaemonWorkerLaunchProvenanceCandidates(hqRoot)).slice(0, 2000);
  for (const candidate of candidates) {
    const doc = await readJsonFileBestEffort(candidate.path);
    const payload = daemonLaunchProvenancePayload(doc);
    if (!payload || typeof payload !== 'object') continue;
    const recordRepo = payload.prRepo || payload.repo;
    const recordBranch = String(payload.branch || payload.headBranch || payload.prBranch || '').trim();
    const recordPrNumberRaw = payload.prNumber ?? payload.pr_number ?? payload.pr;
    const recordPrNumber = Number(recordPrNumberRaw);
    const recordHasPrNumber = recordPrNumberRaw != null
      && recordPrNumberRaw !== ''
      && Number.isInteger(recordPrNumber)
      && recordPrNumber > 0;
    if (!daemonLaunchProvenanceRepoMatches(recordRepo, expectedRepo)) continue;
    // Identity is anchored on repo + the PR's LIVE head branch: the branch hq
    // dispatched this worker to build is the same branch GitHub reports as the PR
    // head, so a repo-scoped exact branch match attributes the merge to the
    // launching worker exactly as the pr_opened ledger row would. PR number is an
    // OPTIONAL secondary check — hq's canonical launch-provenance seed omits it for
    // the overwhelming majority of records (only ~5% on this host carry one), so
    // REQUIRING it fail-closed the fallback for every normal worker. When a record
    // DOES carry a PR number we still enforce it, so a record explicitly tagged to
    // a different PR can never be misattributed to this one.
    if (recordHasPrNumber && recordPrNumber !== numericPrNumber) continue;
    if (recordBranch !== expectedBranch) continue;
    const launchRequestId = String(
      payload.launchRequestId || payload.launch_request_id || doc?.launchRequestId || doc?.launch_request_id || '',
    ).trim();
    const workerClass = String(
      payload.workerClass || payload.worker_class || payload.workerSpec?.workerClass || doc?.workerClass || '',
    ).trim();
    if (!launchRequestId || !workerClass) continue;
    return {
      ok: true,
      launchRequestId,
      workerClass,
      headSha: String(payload.prHeadSha || payload.headSha || payload.head_sha || expectedHead || '').trim() || null,
      branch: recordBranch,
      path: candidate.path,
    };
  }
  return { ok: false, reason: 'missing-launch-provenance' };
}
