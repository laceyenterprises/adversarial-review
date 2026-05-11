/**
 * Markdown-file implementation of the subject-channel adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectChannelAdapter} SubjectChannelAdapter
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectContent} SubjectContent
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationWorkspace} RemediationWorkspace
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationCommitMetadata} RemediationCommitMetadata
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../../../atomic-write.mjs';

const DOMAIN_ID = 'research-finding';
const DEFAULT_SUBJECT_PATH = 'subject.md';
const STATE_DIR = '.markdown-file-state';
const STATE_FILE = 'state.json';

function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || new Date().toISOString());
}

function assertRootDir(rootDir) {
  if (!rootDir) throw new Error('markdown-file subject adapter requires rootDir');
  const resolved = resolve(rootDir);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function resolveSubjectPath(rootDir, subjectPath) {
  const root = assertRootDir(rootDir);
  const resolved = resolve(root, subjectPath || DEFAULT_SUBJECT_PATH);
  const candidate = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`markdown-file subject path escapes rootDir: ${subjectPath}`);
  }
  if (!candidate.endsWith('.md')) {
    throw new Error(`markdown-file subject path must end with .md: ${subjectPath}`);
  }
  return candidate;
}

function hashMarkdownContent(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function titleFromMarkdown(content, subjectPath) {
  const heading = String(content || '').match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : basename(subjectPath);
}

function makeSubjectExternalId(rootDir, subjectPath) {
  return relative(assertRootDir(rootDir), resolveSubjectPath(rootDir, subjectPath)).replaceAll('\\', '/');
}

function refFromMarkdownFile(rootDir, subjectPath, content, { domainId = DOMAIN_ID, linearTicketId = null } = {}) {
  return {
    domainId,
    subjectExternalId: makeSubjectExternalId(rootDir, subjectPath),
    revisionRef: hashMarkdownContent(content),
    ...(linearTicketId ? { linearTicketId } : {}),
  };
}

function readMarkdownSubject(rootDir, subjectPath) {
  const filePath = resolveSubjectPath(rootDir, subjectPath);
  return {
    filePath,
    content: readFileSync(filePath, 'utf8'),
  };
}

function statePathForSubject(rootDir, subjectExternalId) {
  const root = assertRootDir(rootDir);
  const relativeSubjectPath = String(subjectExternalId || '').replaceAll('\\', '/');
  const resolved = resolve(root, STATE_DIR, relativeSubjectPath, STATE_FILE);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`markdown-file state path escapes rootDir: ${subjectExternalId}`);
  }
  return resolved;
}

function readPersistedState(rootDir, subjectExternalId) {
  const statePath = statePathForSubject(rootDir, subjectExternalId);
  if (!existsSync(statePath)) {
    return {};
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writePersistedState(rootDir, subjectExternalId, state) {
  const statePath = statePathForSubject(rootDir, subjectExternalId);
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

/**
 * @param {{
 *   rootDir?: string,
 *   subjectPath?: string,
 *   domainId?: string,
 *   authorRef?: string,
 *   builderClass?: string,
 *   riskClass?: import('../../../kernel/contracts.d.ts').RiskClass,
 *   maxRemediationRounds?: number,
 *   linearTicketId?: string | null,
 *   now?: () => Date | string,
 * }} options
 * @returns {SubjectChannelAdapter}
 */
function createMarkdownFileSubjectAdapter({
  rootDir,
  subjectPath = DEFAULT_SUBJECT_PATH,
  domainId = DOMAIN_ID,
  authorRef = 'fixture-researcher',
  builderClass = 'researcher',
  riskClass = 'medium',
  maxRemediationRounds = 2,
  linearTicketId = null,
  now = () => new Date(),
} = {}) {
  const root = assertRootDir(rootDir);
  const canonicalSubjectPath = subjectPath;

  function currentSnapshot() {
    const { filePath, content } = readMarkdownSubject(root, canonicalSubjectPath);
    const ref = refFromMarkdownFile(root, canonicalSubjectPath, content, { domainId, linearTicketId });
    const cached = readPersistedState(root, ref.subjectExternalId);
    return {
      filePath,
      content,
      ref: {
        ...ref,
        revisionRef: cached.revisionRef || ref.revisionRef,
      },
      title: titleFromMarkdown(content, canonicalSubjectPath),
      completedRemediationRounds: Number(cached.completedRemediationRounds || 0),
      terminal: Boolean(cached.terminal),
      latestVerdict: cached.latestVerdict,
      latestRemediationReply: cached.latestRemediationReply,
    };
  }

  function stateFromSnapshot(snapshot, lifecycle = null) {
    const completed = snapshot.completedRemediationRounds;
    return {
      ref: snapshot.ref,
      lifecycle: lifecycle || (snapshot.terminal ? 'terminal' : 'pending-review'),
      title: snapshot.title,
      authorRef,
      builderClass,
      riskClass,
      labels: [],
      currentRound: completed,
      completedRemediationRounds: completed,
      maxRemediationRounds,
      ...(snapshot.latestVerdict ? { latestVerdict: snapshot.latestVerdict } : {}),
      ...(snapshot.latestRemediationReply ? { latestRemediationReply: snapshot.latestRemediationReply } : {}),
      terminal: snapshot.terminal,
      observedAt: isoString(now()),
    };
  }

  return {
    async discoverSubjects() {
      const filePath = resolveSubjectPath(root, canonicalSubjectPath);
      if (!existsSync(filePath)) return [];
      return [currentSnapshot().ref];
    },

    async fetchState(ref) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      return stateFromSnapshot(snapshot);
    },

    async fetchContent(ref) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      return {
        ref: snapshot.ref,
        representation: snapshot.content,
        contextFiles: [snapshot.filePath],
        observedAt: isoString(now()),
      };
    },

    async prepareRemediationWorkspace(ref, jobId) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      const workspacePath = join(root, 'workspaces', String(jobId || 'remediation'));
      mkdirSync(dirname(workspacePath), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      return {
        ref: snapshot.ref,
        workspacePath,
        instructions: [
          `Edit ${snapshot.filePath}.`,
          'Record the resulting markdown-file revision in the remediation commit metadata.',
        ],
        preparedAt: isoString(now()),
      };
    },

    async recordRemediationCommit(ref, commit) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      if (snapshot.terminal) {
        throw new Error(`Cannot record remediation commit for terminal markdown-file subject: ${snapshot.ref.subjectExternalId}`);
      }
      const nextRevisionRef = hashMarkdownContent(snapshot.content);
      if (commit?.revisionRef && commit.revisionRef !== nextRevisionRef) {
        throw new Error(`markdown-file remediation revisionRef mismatch: expected ${nextRevisionRef}, received ${commit.revisionRef}`);
      }
      const next = {
        revisionRef: nextRevisionRef,
        completedRemediationRounds: snapshot.completedRemediationRounds + 1,
        terminal: false,
        latestVerdict: snapshot.latestVerdict,
        latestRemediationReply: snapshot.latestRemediationReply,
      };
      writePersistedState(root, snapshot.ref.subjectExternalId, next);
      return stateFromSnapshot({
        ...snapshot,
        ref: {
          ...snapshot.ref,
          revisionRef: next.revisionRef,
        },
        completedRemediationRounds: next.completedRemediationRounds,
        terminal: false,
      }, 'awaiting-rereview');
    },

    async finalizeSubject(ref) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      if (snapshot.terminal) {
        return stateFromSnapshot(snapshot, 'terminal');
      }
      writePersistedState(root, snapshot.ref.subjectExternalId, {
        revisionRef: snapshot.ref.revisionRef,
        completedRemediationRounds: snapshot.completedRemediationRounds,
        terminal: true,
        latestVerdict: snapshot.latestVerdict,
        latestRemediationReply: snapshot.latestRemediationReply,
      });
      return stateFromSnapshot({ ...snapshot, terminal: true }, 'terminal');
    },

    async isTerminal(ref) {
      const snapshot = currentSnapshot();
      if (ref?.subjectExternalId && ref.subjectExternalId !== snapshot.ref.subjectExternalId) {
        throw new Error(`Unknown markdown-file subject: ${ref.subjectExternalId}`);
      }
      return snapshot.terminal;
    },
  };
}

export {
  DEFAULT_SUBJECT_PATH,
  DOMAIN_ID,
  createMarkdownFileSubjectAdapter,
  hashMarkdownContent,
  makeSubjectExternalId,
  refFromMarkdownFile,
};
