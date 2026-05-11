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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const DOMAIN_ID = 'research-finding';
const DEFAULT_SUBJECT_PATH = 'subject.md';

function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || new Date().toISOString());
}

function assertRootDir(rootDir) {
  if (!rootDir) throw new Error('markdown-file subject adapter requires rootDir');
  return resolve(rootDir);
}

function resolveSubjectPath(rootDir, subjectPath) {
  const root = assertRootDir(rootDir);
  const resolved = resolve(root, subjectPath || DEFAULT_SUBJECT_PATH);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`markdown-file subject path escapes rootDir: ${subjectPath}`);
  }
  if (!resolved.endsWith('.md')) {
    throw new Error(`markdown-file subject path must end with .md: ${subjectPath}`);
  }
  return resolved;
}

function hashMarkdownContent(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
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
  const stateBySubjectExternalId = new Map();

  function currentSnapshot() {
    const { filePath, content } = readMarkdownSubject(root, canonicalSubjectPath);
    const ref = refFromMarkdownFile(root, canonicalSubjectPath, content, { domainId, linearTicketId });
    const cached = stateBySubjectExternalId.get(ref.subjectExternalId) || {};
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
      const next = {
        revisionRef: commit?.revisionRef || snapshot.ref.revisionRef,
        completedRemediationRounds: snapshot.completedRemediationRounds + 1,
        terminal: false,
        latestRemediationReply: snapshot.latestRemediationReply,
      };
      stateBySubjectExternalId.set(snapshot.ref.subjectExternalId, next);
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
      stateBySubjectExternalId.set(snapshot.ref.subjectExternalId, {
        revisionRef: snapshot.ref.revisionRef,
        completedRemediationRounds: snapshot.completedRemediationRounds,
        terminal: true,
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
