import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { followUpJobFileFilter } from '../follow-up-job-names.mjs';
import { readHeadAttestationChainForPr, resolveDaemonWorkerIdentityFromHeadAttestation } from '../daemon-worker-identity.mjs';
import { remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import { canonicalWorkerClass } from '../worker-class-aliases.mjs';
import { parseCommitTrailers, parseCommitTrailerValues } from './ham-provenance.mjs';

export function isRemediationCommit(commit) {
  return /^(?:codex|claude-code|gemini)-remediation$/.test(
    parseCommitTrailers(commit?.commit?.message)['worker-class'] || '');
}

// Read the existing queue's durable custody, including terminal/archived jobs.
// This is authorization history, not a claim that a completed worker is live.
export function readLaneReversalOwners(rootDir, repo, prNumber) {
  const base = join(rootDir, 'data', 'follow-up-jobs');
  const list = (path, options) => {
    try { return readdirSync(path, options); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const directories = ['pending', 'in-progress', 'completed', 'failed', 'stopped'].map(name => join(base, name));
  const archive = join(base, 'stopped-archived');
  directories.push(...list(archive, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => join(archive, entry.name)));
  const matches = followUpJobFileFilter({ rootDir, repo, prNumber, caseInsensitiveRepo: true });
  return directories.flatMap(directory => list(directory).filter(matches).map(name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch {
      // A disappearing, unreadable or partially written record supplies no
      // authority; it must not hide valid custody in the remaining records.
      return null;
    }
  })).filter(job => job?.closureHandoff?.reason === 'final-fix-all'
    && job.repo?.toLowerCase() === repo.toLowerCase() && Number(job.prNumber) === Number(prNumber));
}

export function laneReversalOwner(commit, owners) {
  const values = parseCommitTrailerValues(commit?.commit?.message);
  // Duplicate/ambiguous job or identity claims cannot select an owner.
  if (['worker-class', 'worker-job-id'].some(key =>
    new Set(values[key] || []).size !== 1)) return null;
  const trailers = parseCommitTrailers(commit?.commit?.message);
  const jobs = owners.filter(job => job.jobId === trailers['worker-job-id']);
  return jobs.length === 1 ? jobs[0] : null;
}

export function laneReversalIdentityMatches({ commit, laneOwner, laneIdentity }) {
  if (!isRemediationCommit(commit) || !laneOwner || !laneIdentity?.ok
    || laneIdentity.resolvedBy !== 'head-attestation'
    || laneIdentity.rowHeadSha !== commit.sha) return false;
  const trailers = parseCommitTrailers(commit.commit.message);
  const reviewedHeads = parseCommitTrailerValues(commit.commit.message)['reviewed-head'] || [];
  if (new Set(reviewedHeads).size !== 1) return false;
  const worker = laneOwner.remediationWorker;
  return laneOwner.closureHandoff?.reason === 'final-fix-all'
    && laneOwner.jobId === trailers['worker-job-id']
    && laneOwner.revisionRef === trailers['reviewed-head']
    && laneOwner.closureHandoff.headSha === trailers['reviewed-head']
    && Boolean(worker?.launchRequestId && worker?.workerClass)
    && ['codex', 'remediator-codex', 'claude-code', 'remediator-claude', 'gemini', 'remediator-gemini']
      .includes(canonicalWorkerClass(worker.workerClass))
    && worker.launchRequestId === laneIdentity.launchRequestId
    && worker.workerClass === laneIdentity.workerClass
    && remediationWorkerTrailerClass(worker.workerClass) === trailers['worker-class'];
}

export function laneReversalIdentityFailureDetail(identity) {
  if (identity?.ok || !identity?.reason) return undefined;
  return `${identity.reason}; transient=${identity.transient === true}`
    + (identity.ledgerTarget ? `; ledgerTarget=${identity.ledgerTarget}` : '');
}

export async function readLaneReversalIdentity({ env = process.env,
  readHeadAttestationChainForPrImpl = readHeadAttestationChainForPr, ...args }) {
  // HQ's legacy runtime selector wins over BACKEND when both are present.
  // Require an explicit Postgres selection; leave config-only resolution to HQ.
  const runtime = env.AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME?.trim().toLowerCase();
  const postgres = runtime ? runtime === 'on'
    : env.AGENT_OS_SESSION_LEDGER_BACKEND?.trim().toLowerCase() === 'postgres';
  const canonicalDsn = env.AGENT_OS_SESSION_LEDGER_CANONICAL_DSN?.trim();
  const canonical = postgres && Boolean(canonicalDsn);
  const chainEnv = canonical ? { ...env, AGENT_OS_SESSION_LEDGER_DSN: canonicalDsn } : env;
  if (canonical) {
    for (const key of ['AGENT_OS_SESSION_LEDGER_DSN_DIRECT', 'AGENT_OS_SESSION_LEDGER_VDB',
      'AGENT_OS_SESSION_LEDGER_VDB_DIRECT_DSN', 'AGENT_OS_SESSION_LEDGER_DB_PATH']) delete chainEnv[key];
  }
  const identity = await resolveDaemonWorkerIdentityFromHeadAttestation({ ...args, env: chainEnv,
    requireExactSubject: true,
    readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPrImpl({
      ...options, useDeployVerifier: true,
    }),
  });
  // Report the routing mode, never the DSN (which can contain credentials).
  return identity.ok ? identity : { ...identity, ledgerTarget: canonical ? 'canonical-postgres' : 'runtime' };
}
