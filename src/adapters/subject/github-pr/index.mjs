/**
 * GitHub Pull Request implementation of the subject-channel adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectChannelAdapter} SubjectChannelAdapter
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectContent} SubjectContent
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationWorkspace} RemediationWorkspace
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationCommitMetadata} RemediationCommitMetadata
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { builderClassFromTitle } from './title-tagging.mjs';
import { routeSubject } from './routing.mjs';

const execFileAsync = promisify(execFile);
const DOMAIN_ID = 'code-pr';

function makeSubjectExternalId(repo, prNumber) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPrNumber = Number(prNumber);
  if (!normalizedRepo || !Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError(`Invalid GitHub PR subject identity: ${repo}#${prNumber}`);
  }
  return `${normalizedRepo}#${normalizedPrNumber}`;
}

function parseSubjectExternalId(subjectExternalId) {
  const raw = String(subjectExternalId || '').trim();
  const match = /^(.+)#(\d+)$/.exec(raw);
  if (!match) {
    throw new TypeError(`Invalid GitHub PR subjectExternalId: ${subjectExternalId}`);
  }
  return {
    repo: match[1],
    prNumber: Number(match[2]),
  };
}

function splitRepo(repoPath) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo) {
    throw new TypeError(`Invalid GitHub repo slug: ${repoPath}`);
  }
  return { owner, repo };
}

function revisionRefFromPR(pr) {
  return String(pr?.head?.sha || pr?.head?.ref || `pr-${pr?.number || 'unknown'}`);
}

function refFromPR(repoPath, pr) {
  return {
    domainId: DOMAIN_ID,
    subjectExternalId: makeSubjectExternalId(repoPath, pr?.number),
    revisionRef: revisionRefFromPR(pr),
  };
}

function normalizePRSnapshot(repoPath, pr) {
  const ref = refFromPR(repoPath, pr);
  const builderClass = builderClassFromTitle(pr?.title);
  return {
    ...ref,
    repo: repoPath,
    prNumber: Number(pr.number),
    title: String(pr?.title || ''),
    state: String(pr?.state || '').trim().toLowerCase(),
    labels: Array.isArray(pr?.labels) ? pr.labels : [],
    authorRef: pr?.user?.login ? String(pr.user.login) : undefined,
    builderClass,
    pr,
  };
}

function stateFromSnapshot(snapshot, {
  currentRound = 0,
  completedRemediationRounds = 0,
  maxRemediationRounds = 0,
  observedAt = new Date().toISOString(),
} = {}) {
  const terminal = snapshot.state && snapshot.state !== 'open';
  return {
    ref: {
      domainId: snapshot.domainId,
      subjectExternalId: snapshot.subjectExternalId,
      revisionRef: snapshot.revisionRef,
    },
    lifecycle: terminal ? 'terminal' : 'pending-review',
    title: snapshot.title,
    authorRef: snapshot.authorRef,
    builderClass: snapshot.builderClass || undefined,
    currentRound,
    completedRemediationRounds,
    maxRemediationRounds,
    terminal,
    observedAt,
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    labels: snapshot.labels,
    pr: snapshot.pr,
    route: routeSubject(snapshot),
  };
}

/**
 * @param {{
 *   octokit?: any,
 *   repos?: readonly string[],
 *   rootDir?: string,
 *   execFileImpl?: typeof execFileAsync,
 *   prepareWorkspaceForJobImpl?: Function,
 *   now?: () => Date,
 * }} options
 * @returns {SubjectChannelAdapter}
 */
function createGitHubPRSubjectAdapter({
  octokit,
  repos = [],
  rootDir,
  execFileImpl = execFileAsync,
  prepareWorkspaceForJobImpl = null,
  now = () => new Date(),
} = {}) {
  const snapshotBySubjectExternalId = new Map();

  async function fetchPRSnapshot(ref) {
    const { repo, prNumber } = parseSubjectExternalId(ref.subjectExternalId);
    const cached = snapshotBySubjectExternalId.get(ref.subjectExternalId);
    if (cached && (!ref.revisionRef || cached.revisionRef === ref.revisionRef)) {
      return cached;
    }
    if (!octokit?.rest?.pulls?.get) {
      throw new Error(`No GitHub client available to fetch ${ref.subjectExternalId}`);
    }
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    const snapshot = normalizePRSnapshot(repo, data);
    snapshotBySubjectExternalId.set(snapshot.subjectExternalId, snapshot);
    return snapshot;
  }

  return {
    async discoverSubjects() {
      if (!octokit?.rest?.pulls?.list) {
        throw new Error('No GitHub client available to discover GitHub PR subjects');
      }

      const refs = [];
      for (const repoPath of repos) {
        const { owner, repo } = splitRepo(repoPath);
        const { data } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 50,
          sort: 'created',
          direction: 'desc',
        });
        for (const pr of data) {
          const snapshot = normalizePRSnapshot(repoPath, pr);
          snapshotBySubjectExternalId.set(snapshot.subjectExternalId, snapshot);
          refs.push({
            domainId: snapshot.domainId,
            subjectExternalId: snapshot.subjectExternalId,
            revisionRef: snapshot.revisionRef,
            repo: snapshot.repo,
            prNumber: snapshot.prNumber,
            pr: snapshot.pr,
          });
        }
      }
      return refs;
    },

    async fetchState(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return stateFromSnapshot(snapshot, { observedAt: now().toISOString() });
    },

    async fetchContent(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      const { stdout } = await execFileImpl('gh', [
        'pr',
        'diff',
        String(snapshot.prNumber),
        '--repo',
        snapshot.repo,
      ], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        ref: {
          domainId: snapshot.domainId,
          subjectExternalId: snapshot.subjectExternalId,
          revisionRef: snapshot.revisionRef,
        },
        representation: String(stdout || ''),
        contextFiles: [],
        observedAt: now().toISOString(),
      };
    },

    async prepareRemediationWorkspace(ref, jobId) {
      const snapshot = await fetchPRSnapshot(ref);
      const prepareWorkspace = prepareWorkspaceForJobImpl
        || (await import('../../../follow-up-remediation.mjs')).prepareWorkspaceForJob;
      const { workspaceDir } = await prepareWorkspace({
        rootDir,
        job: {
          jobId,
          repo: snapshot.repo,
          prNumber: snapshot.prNumber,
        },
        execFileImpl,
      });
      return {
        ref: {
          domainId: snapshot.domainId,
          subjectExternalId: snapshot.subjectExternalId,
          revisionRef: snapshot.revisionRef,
        },
        workspacePath: workspaceDir,
        instructions: [
          'Work on the PR branch checked out in this repository clone.',
          'Commit remediation changes and push the existing PR branch.',
        ],
        preparedAt: now().toISOString(),
      };
    },

    async recordRemediationCommit(ref, commit) {
      const snapshot = await fetchPRSnapshot({
        ...ref,
        revisionRef: commit?.revisionRef || ref.revisionRef,
      });
      return stateFromSnapshot({
        ...snapshot,
        revisionRef: commit?.revisionRef || snapshot.revisionRef,
      }, { observedAt: now().toISOString() });
    },

    async finalizeSubject(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return stateFromSnapshot({
        ...snapshot,
        state: snapshot.state || 'closed',
      }, { observedAt: now().toISOString() });
    },

    async isTerminal(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return Boolean(snapshot.state && snapshot.state !== 'open');
    },
  };
}

export {
  DOMAIN_ID,
  createGitHubPRSubjectAdapter,
  makeSubjectExternalId,
  normalizePRSnapshot,
  parseSubjectExternalId,
  refFromPR,
  revisionRefFromPR,
  stateFromSnapshot,
};
