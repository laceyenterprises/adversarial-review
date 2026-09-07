import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attemptDaemonCleanMerge,
  DAEMON_MERGE_DISPOSITION,
  DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
} from './ama/daemon-merge.mjs';
import { acquireMergeLease, releaseMergeLease } from './ama/merge-lease.mjs';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { completeArgusJob, findArgusJob } from './argus-security-queue.mjs';
import { isUnroutableBotAuthor } from './bot-author.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { fetchPullRequestRollup } from './github-api.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEPENDABOT_AUTO_ADJUDICATOR = 'dependabot-auto-adjudicator';
export const DEPENDABOT_AUTO_MERGE_CLOSURE_AUTHORITY = 'dependabot-auto-merge';

const NATIVE_DEPENDENCY_NAMES = new Set([
  'better-sqlite3',
  'sqlite3',
  'fs-ext',
  'node-gyp',
  'node-pre-gyp',
  'prebuild-install',
  'sharp',
  'canvas',
  'esbuild',
  '@swc/core',
  'lmdb',
  'keytar',
]);

const SECURITY_SURFACE_DEPENDENCY_NAMES = new Set([
  '@octokit/rest',
  '@octokit/graphql',
  '@octokit/auth-app',
  '@octokit/auth-token',
  'jsonwebtoken',
  'jose',
  'passport',
  'bcrypt',
  'argon2',
  'sodium-native',
  'libsodium-wrappers',
]);

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function parseVersion(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function semverUpdateType(fromVersion, toVersion, explicitUpdateType = '') {
  const explicit = String(explicitUpdateType || '').trim().toLowerCase();
  if (explicit.includes('semver-major')) return 'major';
  if (explicit.includes('semver-minor')) return 'minor';
  if (explicit.includes('semver-patch')) return 'patch';

  const from = parseVersion(fromVersion);
  const to = parseVersion(toVersion);
  if (!from || !to) return 'unknown';
  if (to.major !== from.major) return 'major';
  if (to.minor !== from.minor) return 'minor';
  if (to.patch !== from.patch) return 'patch';
  return 'none';
}

function dependencyScope(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized.includes('development')) return 'development';
  if (normalized.includes('production') || normalized.includes('runtime')) return 'runtime';
  return normalized || 'unknown';
}

function parseUpdatedDependenciesFromText(text) {
  const body = String(text || '');
  const blockStart = body.indexOf('updated-dependencies:');
  if (blockStart < 0) return [];
  const block = body.slice(blockStart).split(/\n\.\.\./u)[0];
  const records = [];
  let current = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    const depMatch = line.match(/^-\s+dependency-name:\s*"?([^"]+?)"?\s*$/u);
    if (depMatch) {
      if (current) records.push(current);
      current = { name: depMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^(dependency-version|dependency-type|update-type):\s*"?([^"]+?)"?\s*$/u);
    if (!field) continue;
    current[field[1]] = field[2].trim();
  }
  if (current) records.push(current);
  return records;
}

function titleVersionHints(title, name) {
  const escapedName = String(name || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const specific = escapedName
    ? new RegExp(`bump\\s+${escapedName}\\s+from\\s+([^\\s]+)\\s+to\\s+([^\\s]+)`, 'iu')
    : null;
  const match = (specific && String(title || '').match(specific))
    || String(title || '').match(/bump\s+\S+\s+from\s+([^\s]+)\s+to\s+([^\s]+)/iu);
  return match ? { fromVersion: match[1], toVersion: match[2] } : {};
}

function dependenciesFromMetadata({ title = '', commits = [] } = {}) {
  const records = [];
  for (const commit of Array.isArray(commits) ? commits : []) {
    records.push(...parseUpdatedDependenciesFromText(commit?.messageBody || commit?.body || commit?.message || ''));
  }
  return records.map((record) => {
    const hints = titleVersionHints(title, record.name);
    const toVersion = record['dependency-version'] || hints.toVersion || '';
    return {
      name: record.name || '',
      fromVersion: hints.fromVersion || '',
      toVersion,
      dependencyType: record['dependency-type'] || '',
      scope: dependencyScope(record['dependency-type']),
      updateType: semverUpdateType(hints.fromVersion, toVersion, record['update-type']),
      rawUpdateType: record['update-type'] || '',
    };
  });
}

export function adjudicateDependabotDependencyPr({
  author,
  title = '',
  commits = [],
} = {}) {
  const dependencies = dependenciesFromMetadata({ title, commits });
  const reasons = [];
  if (!isUnroutableBotAuthor(author)) reasons.push('author-not-dependabot');
  if (dependencies.length === 0) reasons.push('dependabot-metadata-missing');

  const classified = dependencies.map((dep) => {
    const name = normalizeName(dep.name);
    return {
      ...dep,
      nativeDriver: NATIVE_DEPENDENCY_NAMES.has(name),
      securitySurface: SECURITY_SURFACE_DEPENDENCY_NAMES.has(name),
    };
  });

  for (const dep of classified) {
    if (dep.scope === 'unknown') reasons.push(`dependency-scope-unknown:${dep.name || 'unknown'}`);
    if (dep.updateType === 'unknown') reasons.push(`dependency-update-type-unknown:${dep.name || 'unknown'}`);
    if (dep.nativeDriver) reasons.push(`native-driver:${dep.name}`);
    if (dep.securitySurface) reasons.push(`security-surface:${dep.name}`);
    if (dep.scope === 'runtime' && dep.updateType === 'major') {
      reasons.push(`runtime-major:${dep.name}`);
    }
  }

  const approved = reasons.length === 0;
  return {
    approved,
    verdict: approved ? 'approve' : 'needs_verification',
    dependencies: classified,
    reasons,
    summary: approved
      ? 'Dependabot dependency bump is eligible for auto-merge after exact-head CI confirmation.'
      : `Dependabot dependency bump requires review/operator handling: ${reasons.join(', ')}`,
  };
}

function requiredChecksFromRollup(rollup) {
  if (Array.isArray(rollup?.checks)) return rollup.checks;
  if (Array.isArray(rollup?.statusCheckRollup)) return rollup.statusCheckRollup;
  return [];
}

function buildArgusResult(adjudication, { source = DEPENDABOT_AUTO_ADJUDICATOR } = {}) {
  return {
    schemaVersion: 1,
    verdict: adjudication.verdict,
    blocksMerge: false,
    isApproval: adjudication.approved,
    highestSeverity: adjudication.approved ? null : 'medium',
    riskDirection: 'unchanged',
    triggerReasons: ['bot-author', 'dependency-manifest'],
    adjudicator: source,
    dependencyAdjudication: {
      approved: adjudication.approved,
      reasons: adjudication.reasons,
      dependencies: adjudication.dependencies,
    },
    findings: adjudication.approved
      ? []
      : adjudication.reasons.map((reason) => ({
          severity: 'medium',
          category: 'dependency_auto_merge_ineligible',
          title: reason,
        })),
  };
}

async function fetchDependabotMetadataWithGh({
  repoPath,
  prNumber,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const { stdout } = await execFileImpl('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repoPath,
    '--json',
    'author,title,commits,headRefOid,baseRefName',
  ], {
    maxBuffer: 1024 * 1024 * 10,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env,
  });
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    author: parsed?.author?.login || null,
    title: parsed?.title || '',
    commits: Array.isArray(parsed?.commits) ? parsed.commits : [],
    headSha: parsed?.headRefOid || null,
    baseBranch: parsed?.baseRefName || null,
  };
}

function normalizeMergeConfig(configLoader = loadConfigCached()) {
  if (typeof configLoader?.getMergeAuthorityConfig === 'function') {
    return configLoader.getMergeAuthorityConfig();
  }
  return {
    enabled: true,
    mergeMethod: 'squash',
    autonomousMergeExecutionEnabled: true,
    mergeCapabilityEnforcement: 'observe',
    strictMode: true,
    branchProtection: { required: true },
    requiredCheckContexts: [],
  };
}

export async function attemptDependabotAutoAdjudicateMerge({
  rootDir = ROOT,
  repoPath,
  prNumber,
  headSha,
  baseBranch = 'main',
  author,
  title = '',
  commits = [],
  branchProtectionRequiredContexts = [],
  mergeConfig = null,
  env = process.env,
  logger = console,
  execFileImpl = execFileAsync,
  fetchRollupImpl = fetchPullRequestRollup,
  findArgusJobImpl = findArgusJob,
  completeArgusJobImpl = completeArgusJob,
  attemptDaemonCleanMergeImpl = attemptDaemonCleanMerge,
  acquireMergeLeaseImpl = acquireMergeLease,
  releaseMergeLeaseImpl = releaseMergeLease,
  execGhWithRetryImpl = execGhWithRetry,
  fetchDependabotMetadataImpl = fetchDependabotMetadataWithGh,
  now = () => new Date().toISOString(),
} = {}) {
  const adjudicatedHead = String(headSha || '').trim();
  if (!repoPath || !prNumber || !adjudicatedHead) {
    return { attempted: false, merged: false, reason: 'inputs-missing' };
  }

  const locatedJob = findArgusJobImpl(rootDir, { repo: repoPath, prNumber, headSha: adjudicatedHead });
  if (!locatedJob?.jobPath) {
    return { attempted: false, merged: false, reason: 'argus-job-missing' };
  }
  if (locatedJob.bucket === 'completed') {
    const source = locatedJob.job?.result?.adjudicator || locatedJob.job?.result?.dependencyAdjudication?.adjudicator;
    if (source !== DEPENDABOT_AUTO_ADJUDICATOR) {
      return { attempted: false, merged: false, reason: 'argus-job-already-completed' };
    }
  }

  const cfg = mergeConfig || normalizeMergeConfig();
  if (cfg.enabled === false || cfg.autonomousMergeExecutionEnabled === false) {
    return { attempted: false, merged: false, reason: 'merge-authority-disabled' };
  }

  let metadata = { author, title, commits, headSha: adjudicatedHead, baseBranch };
  if (!Array.isArray(commits) || commits.length === 0) {
    try {
      metadata = {
        ...metadata,
        ...await fetchDependabotMetadataImpl({ repoPath, prNumber, execFileImpl, env }),
      };
    } catch (err) {
      logger.warn?.(
        `[dependabot-auto-adjudicate] Dependabot metadata read failed for ` +
          `${repoPath}#${prNumber}: ${err?.message || err}`,
      );
    }
  }

  const metadataHead = String(metadata.headSha || '').trim();
  if (metadataHead && metadataHead !== adjudicatedHead) {
    logger.warn?.(
      `[dependabot-auto-adjudicate] head moved before metadata adjudication for ${repoPath}#${prNumber}: ` +
        `queued=${adjudicatedHead.slice(0, 12)} metadata=${metadataHead.slice(0, 12)}; not merging`,
    );
    return { attempted: true, merged: false, reason: 'head-moved-before-adjudication', liveHead: metadataHead };
  }

  const adjudication = adjudicateDependabotDependencyPr({
    author: metadata.author || author,
    title: metadata.title || title,
    commits: metadata.commits || commits,
  });
  logger.log?.(JSON.stringify({
    schemaVersion: 1,
    event: 'dependabot.auto_adjudicate.decision',
    repo: repoPath,
    pr: prNumber,
    headSha: adjudicatedHead,
    approved: adjudication.approved,
    reasons: adjudication.reasons,
    dependencies: adjudication.dependencies,
  }));

  if (!adjudication.approved && locatedJob.bucket !== 'completed') {
    completeArgusJobImpl({
      rootDir,
      jobPath: locatedJob.jobPath,
      completedAt: now(),
      result: buildArgusResult(adjudication),
      job: locatedJob.job || null,
    });
  }

  if (!adjudication.approved) {
    return { attempted: true, merged: false, reason: 'adjudication-not-approved', adjudication };
  }

  let liveRollup;
  try {
    liveRollup = await fetchRollupImpl(repoPath, prNumber, { execFileImpl, env });
  } catch (err) {
    logger.warn?.(
      `[dependabot-auto-adjudicate] live CI/head read failed for ${repoPath}#${prNumber}: ${err?.message || err}`,
    );
    return { attempted: true, merged: false, reason: 'live-gate-read-failed', adjudication };
  }

  const liveHead = String(liveRollup?.headRefOid || liveRollup?.headSha || '').trim();
  if (!liveHead || liveHead !== adjudicatedHead) {
    logger.warn?.(
      `[dependabot-auto-adjudicate] head moved for ${repoPath}#${prNumber}: ` +
        `adjudicated=${adjudicatedHead.slice(0, 12)} live=${liveHead.slice(0, 12) || 'missing'}; not merging`,
    );
    if (locatedJob.bucket !== 'completed') {
      completeArgusJobImpl({
        rootDir,
        jobPath: locatedJob.jobPath,
        completedAt: now(),
        result: buildArgusResult({
          ...adjudication,
          approved: false,
          verdict: 'needs_verification',
          reasons: ['head-moved-before-merge'],
        }),
        job: locatedJob.job || null,
      });
    }
    return { attempted: true, merged: false, reason: 'head-moved-before-merge', adjudication, liveHead };
  }

  const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  const mergeBaseBranch = metadata.baseBranch || baseBranch;
  const mergeMethod = cfg.mergeMethod === 'merge' ? 'merge' : 'squash';
  const branchProtectionRequired = cfg.branchProtection?.required !== false;
  const requiredGateContext = resolveGateStatusContext(env);
  const requiredCheckContexts = resolveRequiredCheckContextsFromCfg(cfg);
  const mergeResult = await attemptDaemonCleanMergeImpl({
    repo: repoPath,
    prNumber,
    base: mergeBaseBranch,
    validatedHead: adjudicatedHead,
    verdict: 'settled-success',
    reviewState: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    branchProtectionRequired,
    requiredGateContext,
    branchProtectionRequiredContexts,
    requiredCheckContexts,
    liveGate: {
      candidateHead: liveHead,
      requiredChecks: requiredChecksFromRollup(liveRollup),
      mergeable: liveRollup?.mergeable,
      mergeStateStatus: liveRollup?.mergeStateStatus,
      prState: String(liveRollup?.state || '').trim().toUpperCase(),
      branchProtectionRequiredContexts,
    },
    mergeMethod,
    hqRoot,
    auditMetadata: {
      closureAuthority: DEPENDABOT_AUTO_MERGE_CLOSURE_AUTHORITY,
      reviewer: DEPENDABOT_AUTO_ADJUDICATOR,
      riskClass: 'low',
      mergeAccountability: 'dependabot-auto-adjudication',
      dependencyAdjudication: {
        approved: adjudication.approved,
        reasons: adjudication.reasons,
        dependencies: adjudication.dependencies,
      },
    },
    flags: {
      autonomousMergeExecutionEnabled: cfg.autonomousMergeExecutionEnabled !== false,
      strictMode: cfg.strictMode !== false,
      mergeCapabilityEnforcement: cfg.mergeCapabilityEnforcement || 'observe',
    },
    mergeCapabilityEnforcement: cfg.mergeCapabilityEnforcement || 'observe',
    mergeEnv: env,
    fetchLiveGateImpl: async () => {
      const rollup = await fetchRollupImpl(repoPath, prNumber, { execFileImpl, env });
      const state = String(rollup?.state || '');
      return {
        candidateHead: rollup?.headRefOid || rollup?.headSha || '',
        requiredChecks: requiredChecksFromRollup(rollup),
        mergeable: rollup?.mergeable,
        mergeStateStatus: rollup?.mergeStateStatus,
        prState: state,
        merged: state.toUpperCase() === 'MERGED',
        branchProtectionRequiredContexts,
      };
    },
    acquireLeaseImpl: () => {
      const res = acquireMergeLeaseImpl({
        rootDir,
        repo: repoPath,
        base: mergeBaseBranch,
        holderPr: prNumber,
        holderHead: adjudicatedHead,
        holderPid: process.pid,
        holderHost: hostname(),
        now: now(),
      });
      return { acquired: Boolean(res?.acquired), lease: res?.lease, existingLease: res?.existingLease };
    },
    releaseLeaseImpl: (lease) => {
      releaseMergeLeaseImpl({
        rootDir,
        repo: lease.repo,
        base: lease.base,
        leaseId: lease.leaseId,
        holderPr: lease.holderPr,
        holderHead: lease.holderHead,
        acquiredAt: lease.acquiredAt,
      });
    },
    runMergeImpl: async ({ repo, prNumber: pr, head, mergeMethod: method }) => {
      const methodFlag = method === 'merge' ? '--merge' : '--squash';
      try {
        const { stdout, stderr } = await execGhWithRetryImpl({
          execFileImpl,
          args: ['pr', 'merge', String(pr), '--repo', repo, methodFlag, '--match-head-commit', head],
          timeoutMs: DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
        });
        return { exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      } catch (err) {
        return {
          exitCode: Number.isInteger(err?.code) ? err.code : 1,
          stdout: String(err?.stdout || ''),
          stderr: String(err?.stderr || err?.message || ''),
        };
      }
    },
    logger,
  });

  if (locatedJob.bucket !== 'completed') {
    const merged = mergeResult?.disposition === DAEMON_MERGE_DISPOSITION.MERGED;
    completeArgusJobImpl({
      rootDir,
      jobPath: locatedJob.jobPath,
      completedAt: now(),
      result: buildArgusResult(merged
        ? adjudication
        : {
            ...adjudication,
            approved: false,
            verdict: 'needs_verification',
            reasons: [
              `merge-not-completed:${mergeResult?.reason || mergeResult?.disposition || 'unknown'}`,
              ...(Array.isArray(mergeResult?.reasons) ? mergeResult.reasons : []),
            ],
          }),
      job: locatedJob.job || null,
    });
  }

  return {
    attempted: true,
    merged: mergeResult?.disposition === DAEMON_MERGE_DISPOSITION.MERGED,
    reason: `daemon-${mergeResult?.disposition || 'unknown'}`,
    adjudication,
    mergeResult,
  };
}
