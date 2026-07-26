import { publishAdversarialGateStatus } from '../../../adversarial-gate-status.mjs';

function subjectRef(subject) {
  return subject?.ref && typeof subject.ref === 'object' ? subject.ref : subject;
}

function parseGithubPrSubject(subject) {
  const ref = subjectRef(subject);
  const repo = subject?.repo ?? ref?.repo;
  const prNumber = subject?.prNumber ?? subject?.pr_number ?? ref?.prNumber ?? ref?.pr_number;
  return { repo, prNumber };
}

/**
 * GitHub SoR provider preserving the existing commit-status projection behind
 * the generic `gate(subject, revisionRef, decision)` method.
 */
export function createGithubCommitStatusGateProvider({ rootDir, execFileImpl, env } = {}) {
  if (!rootDir) {
    throw new TypeError('github-commit-status gate provider requires rootDir');
  }
  return {
    providerId: 'github-commit-status',

    async gate(subject, revisionRef, decision) {
      const { repo, prNumber } = parseGithubPrSubject(subject);
      const publish = await publishAdversarialGateStatus(rootDir, {
        repo,
        prNumber,
        headSha: revisionRef,
        decision,
        execFileImpl,
        env,
      });
      return {
        gated: publish.posted === true || publish.reason === 'unchanged',
        providerId: 'github-commit-status',
        revisionRef,
        publish,
      };
    },
  };
}

export default createGithubCommitStatusGateProvider;
