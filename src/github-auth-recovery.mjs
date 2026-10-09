import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { applyMergeAgentBrokerEnv } from './adapters/agent-runtime/local/remediation.mjs';
import { isWorkflowPath, isWorkflowPushEscalationEnabled, tryEscalateWorkflowPushCapability } from './remediation-workflow-push-capability.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GITHUB_AUTH_PUSH_RETRY_DELAYS_MS = [250, 750];
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const GITHUB_ADAPTER_FILES = Object.freeze([
  'modules/worker-pool/lib/hq-gh.sh',
  'modules/worker-pool/lib/shims/gh',
  'modules/worker-pool/bin/git-safe',
]);

const LOCAL_GIT_OPTIONS = Object.freeze({ timeout: 15000, maxBuffer: 5 * 1024 * 1024 });

// HQ supplies the trusted workspace. Scope cross-UID trust to that repository
// for this invocation, overriding inherited wildcard trust without global edits.
// Replacement refs must not alter preserved objects or outgoing history.
function recoveryGitArgs(workspaceDir, args) {
  return ['--no-replace-objects', '-c', 'safe.directory=', '-c',
    'safe.directory=' + resolve(workspaceDir), '-C', workspaceDir, ...args];
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function githubAuthRecoveryErrorDetail(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

function redactGithubAuthRecoveryDetail(value) {
  return String(value || '')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(https?:\/\/)([^/\s:@]+:)?[^/\s:@]+@/gi, '$1[REDACTED_CREDENTIAL]@')
    .replace(/(?:\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|\/Volumes\/)[^\s'")]+/g, '[REDACTED_PATH]');
}

function isTransientGitPushError(err) {
  const detail = githubAuthRecoveryErrorDetail(err);
  return /(?:unable to access|could not resolve host|failed to connect|connection (?:reset|timed out|closed)|connection refused|network is unreachable|operation timed out|timed out|timeout|TLS|SSL|HTTP 5\d\d|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|early EOF|RPC failed|temporary failure|temporarily unavailable|service unavailable|bad gateway|gateway timeout)/i.test(detail);
}

function nearestExistingPath(pathValue, { existsSyncImpl = existsSync } = {}) {
  let candidate = pathValue;
  while (candidate && candidate !== dirname(candidate)) {
    if (existsSyncImpl(candidate)) return candidate;
    candidate = dirname(candidate);
  }
  return candidate && existsSyncImpl(candidate) ? candidate : null;
}

function assertHqRescueWriteOwner({
  targetDir,
  statSyncImpl = statSync,
  existsSyncImpl = existsSync,
  getuidImpl = () => (typeof process.getuid === 'function' ? process.getuid() : null),
}) {
  const uid = getuidImpl();
  if (uid == null) return;
  const ownerPath = nearestExistingPath(targetDir, { existsSyncImpl });
  if (!ownerPath) return;
  const stat = statSyncImpl(ownerPath);
  if (stat.uid !== uid) {
    const err = new Error(`refusing to write GitHub-auth rescue artifact under ${ownerPath}: owner uid ${stat.uid} does not match process uid ${uid}`);
    err.code = 'hq-rescue-owner-mismatch';
    err.ownerPath = ownerPath;
    err.ownerUid = stat.uid;
    err.processUid = uid;
    throw err;
  }
}

function normalizeOperationalBlockerCategory(blocker) {
  const raw = blocker && typeof blocker === 'object' && !Array.isArray(blocker)
    ? (blocker.category || blocker.title || blocker.code || blocker.finding)
    : blocker;
  const normalized = String(raw || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'unknown';
  if (normalized.includes('github-auth') || normalized === 'auth-failure' || normalized === 'missing-auth') {
    return 'github-auth';
  }
  return normalized;
}

function operationalBlockerText(blocker) {
  if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) return String(blocker || '');
  return [
    blocker.title,
    blocker.category,
    blocker.code,
    blocker.finding,
    blocker.reasoning,
    blocker.needsHumanInput,
    blocker.detail,
    blocker.message,
  ].map((value) => String(value || '')).join('\n');
}

function classifyGithubAuthOperationalBlocker(blocker) {
  const text = operationalBlockerText(blocker).toLocaleLowerCase('en-US');
  if (normalizeOperationalBlockerCategory(blocker) !== 'github-auth') return null;
  // A workflow added by remediation is invisible to the review's changed-file
  // snapshot. It is a candidate only: the publisher must prove outgoing paths
  // and the scoped transport before attempting recovery. Revocation and other
  // authorization failures never become workflow escalation.
  const otherAuthorizationFailure = /\brevok(?:ed|ation)\b|entitlement revoked|missing app installation|installation (?:not found|missing)|resource not accessible by integration|contents permission/.test(text);
  // A suggested human action is not evidence of the actual GitHub denial.
  const evidence = blocker && typeof blocker === 'object'
    ? [blocker.finding, blocker.reasoning, blocker.detail, blocker.message].filter(Boolean).join('\n').toLowerCase()
    : text;
  if (!otherAuthorizationFailure && !/\b401\b/.test(evidence) && /(?:without|missing|requires?|lacks?|lacking|grant|no)[^\n]{0,80}\bworkflows?['"`]?\s+(?:scope|permission)|\bworkflows?['"`]?\s+(?:scope|permission)[^\n]{0,80}(?:missing|denied|not granted|required)/.test(evidence)) {
    return { kind: 'workflow-push-candidate', reason: 'workflow-push-capability-drift' };
  }
  if (
    otherAuthorizationFailure || /permission denied|403|forbidden/.test(text)
  ) {
    return { kind: 'terminal', reason: 'terminal-github-auth' };
  }
  if (
    /expired|invalid|bad credentials|no usable|missing non-interactive|could not fetch|could not push|authentication failed|credential|token|oauth/.test(text)
  ) {
    return { kind: 'recoverable', reason: 'recoverable-github-auth' };
  }
  return { kind: 'terminal', reason: 'unclassified-github-auth' };
}

function findGithubAuthOperationalBlocker(reply) {
  const blockers = Array.isArray(reply?.operationalBlockers) ? reply.operationalBlockers : [];
  for (const blocker of blockers) {
    const classification = classifyGithubAuthOperationalBlocker(blocker);
    if (classification) return { blocker, classification };
  }
  return null;
}

function extractCommitShaFromOperationalBlocker(blocker) {
  const candidates = [
    blocker?.commitSha,
    blocker?.commit,
    blocker?.headSha,
    blocker?.unpushedSha,
    blocker?.validatedCommit,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(value)) return value;
  }
  // A reply commonly mentions the remote lease before the preserved commit.
  // Never bundle/retry the lease as if it were the unpushed work. Multiple
  // remaining hashes are ambiguous and require an explicit structured field.
  const lease = String(blocker?.expectedRemoteSha || '').toLowerCase();
  const matches = operationalBlockerText(blocker).match(/\b[0-9a-f]{7,40}\b/ig) || [];
  const shas = [...new Set(matches.filter((sha) => !lease || !lease.startsWith(sha.toLowerCase())))];
  return shas.length === 1 ? shas[0] : null;
}

async function preserveUnpushedCommit({
  hqRoot,
  workspaceDir,
  repo,
  prNumber,
  jobId,
  commitSha,
  observedAt,
  execFileImpl = execFileAsync,
  statSyncImpl = statSync,
  existsSyncImpl = existsSync,
  getuidImpl = () => (typeof process.getuid === 'function' ? process.getuid() : null),
}) {
  const sha = String(commitSha || '').trim();
  if (!sha) return { preserved: false, reason: 'missing-commit-sha' };
  await execFileImpl('git', recoveryGitArgs(workspaceDir, ['cat-file', '-e', `${sha}^{commit}`]), LOCAL_GIT_OPTIONS);
  const safeRepo = String(repo || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const safeJob = String(jobId || `pr-${prNumber}`).replace(/[^A-Za-z0-9_.-]+/g, '_');
  const stamp = String(observedAt || new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, '-');
  const rescueDir = join(hqRoot, 'rescues', 'adversarial-review', 'github-auth', safeRepo, `pr-${prNumber}`);
  assertHqRescueWriteOwner({ targetDir: rescueDir, statSyncImpl, existsSyncImpl, getuidImpl });
  mkdirSync(rescueDir, { recursive: true });
  const bundlePath = join(rescueDir, `${stamp}-${safeJob}-${sha.slice(0, 12)}.bundle`);
  const rescueRef = `refs/adversarial-review/rescues/${safeJob}/${sha}`;
  try {
    await execFileImpl('git', recoveryGitArgs(workspaceDir, ['update-ref', rescueRef, sha]), LOCAL_GIT_OPTIONS);
    await execFileImpl('git', recoveryGitArgs(workspaceDir, ['bundle', 'create', bundlePath, rescueRef]), {
      ...LOCAL_GIT_OPTIONS, timeout: 60000,
    });
    await execFileImpl('git', recoveryGitArgs(workspaceDir, ['bundle', 'verify', bundlePath]), LOCAL_GIT_OPTIONS);
  } finally {
    try {
      await execFileImpl('git', recoveryGitArgs(workspaceDir, ['update-ref', '-d', rescueRef]), LOCAL_GIT_OPTIONS);
    } catch {
      // Best-effort cleanup; the durable artifact is the verified bundle.
    }
  }
  return {
    preserved: true,
    kind: 'git-bundle',
    path: bundlePath,
    ref: rescueRef,
    commitSha: sha,
    repo,
    prNumber,
    createdAt: observedAt,
  };
}

// WFDRIFT-01: read the actual outgoing commits, including an intermediate
// workflow edit later reverted in the tip tree. No fetch/reset, job snapshot,
// assumed permission or ambient human credential can substitute for evidence.
async function prepareWorkflowRecoveryPush({
  workspaceDir, commitSha, expectedHead, workerClass, env, execFileImpl,
  fetchImpl, readFileImpl, retryDelaysMs, log,
}) {
  if (!isWorkflowPushEscalationEnabled(env)) {
    return { ok: false, reason: 'workflow-push-escalation-disabled' };
  }
  if (!FULL_SHA_PATTERN.test(String(commitSha || ''))) {
    return { ok: false, reason: 'workflow-push-commit-unproven' };
  }
  try {
    const { stdout } = await execFileImpl('git', recoveryGitArgs(workspaceDir, [
      'log', '--format=', '--name-only', '-z', '--no-renames',
      expectedHead + '..' + commitSha, '--', '.github/workflows/']), LOCAL_GIT_OPTIONS);
    const raw = String(stdout || '');
    if (!raw || !raw.endsWith('\0')) {
      return { ok: false, reason: 'workflow-push-paths-unproven' };
    }
    const paths = [...new Set(raw.split('\0').filter(Boolean))];
    if (!paths.some(isWorkflowPath) || paths.some((path) => !path.startsWith('.github/workflows/'))) {
      return { ok: false, reason: 'workflow-push-paths-unproven' };
    }
    const escalation = await tryEscalateWorkflowPushCapability({
      env: { ...env }, execFileImpl, fetchImpl, readFileImpl, retryDelaysMs, log,
    });
    if (!escalation.ok || !escalation.pushEnv) {
      return { ok: false, reason: 'workflow-push-capability-unavailable' };
    }
    // Use the same provider/pin wiring as a workflow-aware remediation spawn.
    // Stale harness transport or expiry fields must not replace this fresh App
    // token. The bounded publisher cannot fall back to operator/PAT credentials.
    const scopedEnv = { ...escalation.pushEnv, WORKER_CLASS: 'merge-agent',
      HQ_ENTITLEMENT_GH_TOKEN_VAR: 'MERGE_AGENT_GH_TOKEN', WORKFLOW_PUSH_SCOPED: '1',
      MERGE_AGENT_GH_TOKEN: escalation.pushEnv.GH_TOKEN,
      MERGE_AGENT_BROKER_REQUIRED: '1', MERGE_AGENT_DISABLE_OP_TOKEN_FALLBACK: '1',
      HQ_WORKER_TOKEN_MINTED_AT: new Date().toISOString() };
    applyMergeAgentBrokerEnv(scopedEnv, env, { workerClass, requiresWorkflowPush: true, log });
    delete scopedEnv.GH_TOKEN_EXPIRES_AT;
    delete scopedEnv.MERGE_AGENT_GH_TOKEN_EXPIRES_AT;
    return {
      ok: true,
      // This value is consumed only by the push subprocess and never returned
      // in durable recovery metadata. Commit/trailer provenance is unchanged.
      env: scopedEnv,
      evidence: { source: 'workspace-commits', paths, provider: 'github-app-merge-agent',
        identity: escalation.capability.identity, expectedRemoteSha: expectedHead, commitSha },
    };
  } catch (err) {
    return { ok: false, reason: 'workflow-push-evidence-unavailable',
      error: redactGithubAuthRecoveryDetail(githubAuthRecoveryErrorDetail(err)).slice(0, 600) };
  }
}

async function readRecoveryPrHead({ repo, prNumber, execFileImpl, env, retryDelaysMs,
  sleepImpl, expectedHead = null }) {
  if (!repo || !Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error('workflow recovery requires the PR identity');
  }
  const attempts = [0, ...retryDelaysMs];
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    if (attempts[attempt] > 0) await sleepImpl(attempts[attempt]);
    try {
      const { stdout } = await execFileImpl('gh', ['pr', 'view', String(prNumber),
        '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
      { env, timeout: 15000, maxBuffer: 1024 * 1024 });
      const head = String(stdout || '').trim();
      if (!FULL_SHA_PATTERN.test(head)) throw new Error('workflow recovery PR head is unreadable');
      // GitHub's PR projection can lag behind the successful ref update.
      if (!expectedHead || head === expectedHead || attempt === attempts.length - 1) return head;
    } catch (err) {
      if (!isTransientGitPushError(err) || attempt === attempts.length - 1) throw err;
    }
  }
}

function nativeWorkflowUpdateProof({ result, expectedHead, commitSha, targetBranch, jobId, repo, prNumber }) {
  const detail = [result?.stdout, result?.stderr].filter(Boolean).join('\n');
  const updated = detail.split(/\r?\n/).some((line) => {
    const match = /^\s*\+?\s*([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)(?:\s+\(forced update\))?\s*$/i.exec(line);
    return match && expectedHead.startsWith(match[1]) && commitSha.startsWith(match[2])
      && [targetBranch, 'refs/heads/' + targetBranch].includes(match[3]);
  });
  if (!updated) return null;
  return { schemaVersion: 1, source: 'native-workflow-publisher', method: 'git-update',
    jobId, repo, prNumber: Number(prNumber), branch: targetBranch,
    expectedRemoteSha: expectedHead, headSha: commitSha, observedAt: new Date().toISOString() };
}

async function retryGithubAuthPushOnce({
  workspaceDir,
  workerClass,
  branch,
  repo,
  prNumber,
  commitSha,
  expectedRemoteSha,
  fallbackRemoteSha = null,
  env = process.env,
  execFileImpl = execFileAsync,
  retryDelaysMs = GITHUB_AUTH_PUSH_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  requiresWorkflowPush = false,
  jobId = null,
  fetchImpl = globalThis.fetch,
  readFileImpl,
  log = console,
  pendingNativePublication = null,
  recordNativePublicationImpl = () => {},
}) {
  // An explicit HQ_REPO_ROOT is authoritative, matching the spawn adapter.
  // Recovery sources hq-gh.sh and execs both shims, so a checkout missing any
  // of them is a missing adapter, not a credential failure.
  const rootCandidate = String(env.HQ_REPO_ROOT || '').trim() || join(ROOT, '../..');
  const missingAdapterFiles = GITHUB_ADAPTER_FILES.filter((file) => !existsSync(join(rootCandidate, file)));
  if (missingAdapterFiles.length > 0) {
    return { retried: false, pushed: false, reason: 'missing-gh-adapter', agentOsRoot: rootCandidate, missingAdapterFiles };
  }
  const agentOsRoot = rootCandidate;
  const publicationDeadline = requiresWorkflowPush ? Date.now() + 600000 : null;
  let targetBranch = String(branch || '').trim();
  if (!targetBranch) {
    try {
      const checkedOut = await execFileImpl('git', recoveryGitArgs(workspaceDir, ['rev-parse', '--abbrev-ref', 'HEAD']), LOCAL_GIT_OPTIONS);
      targetBranch = String(checkedOut.stdout || '').trim();
      if (targetBranch === 'HEAD') targetBranch = '';
    } catch { /* Detached or unavailable workspace. */ }
  }
  if (!targetBranch && repo && prNumber) {
    const viewScript = `set -euo pipefail
source "$AGENT_OS_ROOT/modules/worker-pool/lib/hq-gh.sh"
unset GH_TOKEN GITHUB_TOKEN HQ_ENTITLEMENT_GH_TOKEN
hq_resolve_worker_class_gh_token "$WORKER_CLASS"
export GH_TOKEN="$HQ_ENTITLEMENT_GH_TOKEN" GITHUB_TOKEN="$HQ_ENTITLEMENT_GH_TOKEN"
"$AGENT_OS_ROOT/modules/worker-pool/lib/shims/gh" pr view "$PR_NUMBER" --repo "$PR_REPO" --json headRefName --jq .headRefName`;
    const viewOptions = {
      ...(requiresWorkflowPush ? { timeout: 15000 } : {}),
      env: { ...env, AGENT_OS_ROOT: agentOsRoot, WORKER_CLASS: workerClass, PR_NUMBER: String(prNumber), PR_REPO: repo },
    };
    const attempts = [0, ...retryDelaysMs];
    for (let attempt = 0; attempt < attempts.length; attempt += 1) {
      if (attempts[attempt] > 0) await sleepImpl(attempts[attempt]);
      try {
        const viewed = await execFileImpl('bash', ['-c', viewScript], viewOptions);
        targetBranch = String(viewed.stdout || '').trim();
        if (targetBranch === 'null') targetBranch = '';
        break;
      } catch (err) {
        const detail = githubAuthRecoveryErrorDetail(err);
        if (/(?:HTTP\s*404|not found \(HTTP 404\))/i.test(detail)) {
          // GitHub also answers 404 when the minted token cannot see a private
          // repo (App not installed, wrong entitlement class). That is not
          // proof the branch is gone, so keep it apart from missing-pr-branch.
          return {
            retried: true,
            pushed: false,
            reason: 'pr-lookup-not-found',
            attempts: attempt + 1,
            workerClass: workerClass || null,
            error: redactGithubAuthRecoveryDetail(detail).slice(0, 1200),
          };
        }
        const transient = isTransientGitPushError(err);
        if (transient && attempt < attempts.length - 1) continue;
        return {
          retried: true,
          pushed: false,
          reason: 'branch-lookup-failed',
          attempts: attempt + 1,
          transient,
          error: redactGithubAuthRecoveryDetail(detail).slice(0, 1200),
        };
      }
    }
  }
  if (!targetBranch) {
    return { retried: false, pushed: false, reason: 'missing-pr-branch' };
  }
  let expectedHead = String(expectedRemoteSha || '').trim();
  if (!FULL_SHA_PATTERN.test(expectedHead)) {
    // The worker's own last fetch of the PR branch, recorded in its checkout,
    // is the head it built on. Prefer it over the reviewed revision, which is
    // stale whenever the head moved between review and spawn.
    try {
      const tracked = await execFileImpl('git', recoveryGitArgs(workspaceDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${targetBranch}^{commit}`]), LOCAL_GIT_OPTIONS);
      expectedHead = String(tracked.stdout || '').trim();
    } catch { /* No tracking ref in this workspace. */ }
  }
  if (!FULL_SHA_PATTERN.test(expectedHead)) expectedHead = String(fallbackRemoteSha || '').trim();
  if (!FULL_SHA_PATTERN.test(expectedHead)) {
    return { retried: false, pushed: false, reason: 'missing-expected-remote-head' };
  }
  let pushEnv = env;
  let workflowPush = null;
  let publicationProof = null;
  const readHead = (expectedHead = null) => readRecoveryPrHead({
    repo, prNumber, execFileImpl, env: pushEnv, retryDelaysMs, sleepImpl, expectedHead,
  });
  const verifyPublication = async () => {
    let error = null;
    try {
      if (await readHead(commitSha) === commitSha) {
        return { retried: true, pushed: true, reason: 'push-succeeded-remote-confirmed',
          workflowPush, pendingNativePublication: publicationProof,
          nativePublicationReceipt: { ...publicationProof, method: 'git-update-and-live-pr-head',
            observedAt: new Date().toISOString() } };
      }
    } catch (err) {
      error = err;
    }
    return { retried: true, pushed: false, reason: 'workflow-push-publication-unproven',
      workflowPush, pendingNativePublication: publicationProof,
      // Keep reconcile active for a bounded window, without launching a worker
      // or pushing again. Retain the proof even after that window expires.
      retryLater: (!error || isTransientGitPushError(error))
        && Date.now() - Date.parse(publicationProof.observedAt) < 600000,
      ...(error ? { error: redactGithubAuthRecoveryDetail(githubAuthRecoveryErrorDetail(error)).slice(0, 600) } : {}) };
  };
  if (requiresWorkflowPush) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))
      || String(repo).split('/').some((part) => ['.', '..'].includes(part))) {
      return { retried: false, pushed: false, reason: 'workflow-push-pr-identity-unproven' };
    }
    const prepared = await prepareWorkflowRecoveryPush({
      workspaceDir, commitSha, expectedHead, workerClass, env, execFileImpl,
      fetchImpl, readFileImpl, retryDelaysMs, log,
    });
    if (!prepared.ok) return { retried: false, pushed: false, ...prepared };
    pushEnv = prepared.env;
    workflowPush = prepared.evidence;
    if (pendingNativePublication?.schemaVersion === 1
      && pendingNativePublication.source === 'native-workflow-publisher'
      && pendingNativePublication.method === 'git-update'
      && pendingNativePublication.jobId === jobId && pendingNativePublication.repo === repo
      && pendingNativePublication.prNumber === Number(prNumber)
      && pendingNativePublication.branch === targetBranch
      && pendingNativePublication.expectedRemoteSha === expectedHead
      && pendingNativePublication.headSha === commitSha
      && Number.isFinite(Date.parse(pendingNativePublication.observedAt))) {
      publicationProof = pendingNativePublication;
      return verifyPublication();
    }
    try {
      const remoteHead = await readHead();
      if (remoteHead === commitSha) {
        // Someone already published this commit. Do not fabricate a new
        // recovery push or worker completion from that observation.
        return { retried: false, pushed: false, alreadyPublished: true,
          reason: 'already-published', workflowPush };
      }
      if (remoteHead !== expectedHead) {
        return { retried: false, pushed: false, reason: 'pr-head-moved', workflowPush };
      }
    } catch (err) {
      return { retried: false, pushed: false, reason: 'workflow-push-remote-head-unproven',
        workflowPush, error: redactGithubAuthRecoveryDetail(githubAuthRecoveryErrorDetail(err)).slice(0, 600) };
    }
  }
  const script = `
set -euo pipefail
if [[ "\${WORKFLOW_PUSH_SCOPED:-0}" != 1 ]]; then
source "$AGENT_OS_ROOT/modules/worker-pool/lib/hq-gh.sh"
unset GH_TOKEN GITHUB_TOKEN HQ_ENTITLEMENT_GH_TOKEN
hq_resolve_worker_class_gh_token "$WORKER_CLASS"
token="$HQ_ENTITLEMENT_GH_TOKEN"
if [[ -z "$token" && -n "\${HQ_ENTITLEMENT_GH_TOKEN_VAR:-}" ]]; then
  token="\${!HQ_ENTITLEMENT_GH_TOKEN_VAR:-}"
fi
[[ -n "$token" ]]
export GH_TOKEN="$token" GITHUB_TOKEN="$token"
fi
export GIT_TERMINAL_PROMPT=0
"$AGENT_OS_ROOT/modules/worker-pool/bin/git-safe" -C "$WORKSPACE_DIR" push "--force-with-lease=refs/heads/$TARGET_BRANCH:$EXPECTED_REMOTE_SHA" "$PUSH_REMOTE" "$COMMIT_SHA:refs/heads/$TARGET_BRANCH"
`;
  const options = {
    env: {
      ...pushEnv,
      // The strict publication transcript parser requires deterministic Git
      // messages; isolate this locale from the daemon and physical worker.
      ...(workflowPush ? { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' } : {}),
      AGENT_OS_ROOT: agentOsRoot,
      WORKER_CLASS: workflowPush ? 'merge-agent' : (workerClass || 'codex'),
      WORKFLOW_PUSH_SCOPED: workflowPush ? '1' : '0',
      WORKSPACE_DIR: workspaceDir,
      COMMIT_SHA: commitSha,
      TARGET_BRANCH: targetBranch,
      // One explicit HTTPS destination prevents a worker's SSH pushurl or a
      // second remote pushurl from using ambient credentials for this scope.
      PUSH_REMOTE: workflowPush ? ('https://github.com/' + repo + '.git') : 'origin',
      EXPECTED_REMOTE_SHA: expectedHead,
    },
    maxBuffer: 5 * 1024 * 1024,
    ...(workflowPush ? { timeout: 600000 } : {}),
  };
  const attempts = [0, ...retryDelaysMs];
  let lastError = null;
  let lastTransient = false;
  let attemptsMade = 0;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    if (attempts[attempt] > 0) await sleepImpl(attempts[attempt]);
    attemptsMade = attempt + 1;
    let published = null;
    let pushError = null;
    try {
      const remaining = publicationDeadline == null ? null : publicationDeadline - Date.now();
      if (remaining != null && remaining <= 0) {
        return { retried: attemptsMade > 1, pushed: false, reason: 'workflow-publication-deadline', workflowPush };
      }
      published = await execFileImpl('bash', ['-c', script],
        remaining == null ? options : { ...options, timeout: remaining });
    } catch (err) {
      pushError = err;
    }
    if (workflowPush) {
      publicationProof = nativeWorkflowUpdateProof({
        result: published || pushError, expectedHead, commitSha, targetBranch, jobId, repo, prNumber });
      if (publicationProof) {
        // Persist the native update before the fallible live-head verification.
        // A later reconcile can finish verification without losing attribution.
        await recordNativePublicationImpl(publicationProof, workflowPush);
        return { ...await verifyPublication(), attempts: attemptsMade };
      }
    }
    if (!pushError) {
      if (workflowPush) {
        try {
          if (await readHead(commitSha) === commitSha) {
            return { retried: true, pushed: false, alreadyPublished: true,
              reason: 'publication-observed-without-native-update-proof', attempts: attemptsMade, workflowPush };
          }
        } catch { /* A successful exit alone proves neither attribution nor the live head. */ }
        return { retried: true, pushed: false, reason: 'workflow-push-publication-unproven',
          attempts: attemptsMade, workflowPush };
      }
      return { retried: true, pushed: true, reason: 'push-succeeded', attempts: attemptsMade };
    }
    const err = pushError;
    if (workflowPush) {
      // A multi-transport push can publish once and then fail its second
      // lease. Prove the exact remote target before considering a retry.
      try {
        if (await readHead(commitSha) === commitSha) {
          return { retried: true, pushed: false, alreadyPublished: true,
            reason: 'publication-observed-without-native-update-proof', attempts: attemptsMade, workflowPush };
        }
      } catch { /* Uncertain evidence never proves publication. */ }
    }
    if (/non-fast-forward|fetch first|stale info/i.test(githubAuthRecoveryErrorDetail(err))) {
      return {
        retried: true,
        pushed: false,
        reason: 'pr-head-moved',
        attempts: attemptsMade,
        transient: false,
        error: redactGithubAuthRecoveryDetail(githubAuthRecoveryErrorDetail(err)).slice(0, 1200),
      };
    }
    lastError = err;
    lastTransient = isTransientGitPushError(err);
    if (!lastTransient || attempt === attempts.length - 1) break;
  }
  const detail = redactGithubAuthRecoveryDetail(githubAuthRecoveryErrorDetail(lastError)).slice(0, 1200);
  return {
    retried: true,
    pushed: false,
    reason: 'push-failed-after-remint',
    error: detail,
    attempts: attemptsMade,
    transient: lastTransient,
  };
}

async function recoverGithubAuthOperationalBlocker({
  reply,
  hqRoot,
  workspaceDir,
  job,
  worker,
  completedAt,
  rootDir,
  resolveWorkerClass,
  buildRereviewResult,
  requestReviewRereviewImpl,
  retryGithubAuthPushOnceImpl = retryGithubAuthPushOnce,
  execFileImpl = execFileAsync,
  env = process.env,
  recordRecoveryImpl = () => {},
}) {
  const authBlocker = findGithubAuthOperationalBlocker(reply);
  if (!authBlocker) return { operationalBlockerRecovery: null, rereview: null, job: null };
  const commitSha = extractCommitShaFromOperationalBlocker(authBlocker.blocker);
  const expectedRemoteSha = authBlocker.blocker?.expectedRemoteSha || null;
  let rescue = null;
  try {
    rescue = await preserveUnpushedCommit({
      hqRoot,
      workspaceDir,
      repo: job.repo,
      prNumber: job.prNumber,
      jobId: job.jobId,
      commitSha,
      observedAt: completedAt,
      execFileImpl,
    });
  } catch (err) {
    rescue = {
      preserved: false,
      reason: 'preserve-failed',
      commitSha,
      error: redactGithubAuthRecoveryDetail(String(err?.message || err)).slice(0, 600),
    };
  }

  let retry = { retried: false, pushed: false, reason: authBlocker.classification.reason };
  let rereview = null;
  if (['recoverable', 'workflow-push-candidate'].includes(authBlocker.classification.kind) && rescue?.preserved) {
    retry = await retryGithubAuthPushOnceImpl({
      workspaceDir,
      workerClass: worker?.startupEvidence?.mergeAgentBroker?.requiresWorkflowPush
        ? 'merge-agent'
        : resolveWorkerClass(job, worker),
      branch: job.branch,
      repo: job.repo,
      prNumber: job.prNumber,
      commitSha: rescue.commitSha,
      expectedRemoteSha,
      fallbackRemoteSha: job?.revisionRef || null,
      requiresWorkflowPush: authBlocker.classification.kind === 'workflow-push-candidate',
      jobId: job.jobId,
      pendingNativePublication: job.operationalBlockerRecovery?.retry?.pendingNativePublication,
      recordNativePublicationImpl: async (pendingNativePublication, workflowPush) => {
        const recovery = { category: 'github-auth', classification: authBlocker.classification,
          rescue, retry: { retried: true, pushed: false, reason: 'workflow-push-publication-unproven',
            pendingNativePublication, workflowPush }, recordedAt: completedAt };
        await recordRecoveryImpl({ ...job, operationalBlockerRecovery: recovery });
      },
      env,
      execFileImpl,
    });
    if (retry.pushed && job?.finalRound !== 'comment-only') {
      const requestedAt = completedAt;
      const reason = 'Recovered a remediated commit after refreshing the worker GitHub credential.';
      const outcome = requestReviewRereviewImpl({
        rootDir,
        repo: job.repo,
        prNumber: job.prNumber,
        requestedAt,
        reason,
        targetRevisionRef: rescue.commitSha,
      });
      rereview = buildRereviewResult({
        requested: true,
        reason,
        outcome: {
          ...outcome,
          requestedAt,
        },
      });
    }
  }

  // A failed capability refresh must not erase an earlier native ref update.
  if (!retry.pendingNativePublication && job.operationalBlockerRecovery?.retry?.pendingNativePublication) {
    retry = { ...retry, pendingNativePublication: job.operationalBlockerRecovery.retry.pendingNativePublication };
  }
  const operationalBlockerRecovery = {
    category: 'github-auth',
    classification: authBlocker.classification,
    rescue,
    retry,
    recordedAt: completedAt,
  };
  return {
    operationalBlockerRecovery,
    rereview,
    job: {
      ...job,
      operationalBlockerRecovery,
    },
  };
}

export {
  classifyGithubAuthOperationalBlocker,
  extractCommitShaFromOperationalBlocker,
  findGithubAuthOperationalBlocker,
  preserveUnpushedCommit,
  redactGithubAuthRecoveryDetail,
  recoverGithubAuthOperationalBlocker,
  retryGithubAuthPushOnce,
};
