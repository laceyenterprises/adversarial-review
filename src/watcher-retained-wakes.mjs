import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

// Only the watcher writes this record. Wake producers keep using the one-shot
// wake file; capacity deferral transfers its priority here without a TTL.
export function createRetainedWatcherWakes({ rootDir } = {}) {
  const filePath = join(rootDir, 'data', 'watcher-wake-retained.json');
  const key = ({ repoPath, prNumber }) => `${repoPath}#${prNumber}`;
  const read = () => {
    try {
      const payload = JSON.parse(readFileSync(filePath, 'utf8'));
      return (Array.isArray(payload.subjects) ? payload.subjects : []).filter((entry) =>
        typeof entry?.repoPath === 'string' && entry.repoPath
        && Number.isInteger(entry.prNumber) && entry.prNumber > 0
        && typeof entry.headSha === 'string' && entry.headSha);
    } catch {
      return [];
    }
  };
  const write = (subjects) => {
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ schema_version: 1, subjects })}\n`);
      return true;
    } catch {
      // Priority bookkeeping must never become a new admission refusal.
      return false;
    }
  };
  const drop = (identity) => {
    const subjects = read();
    const next = subjects.filter((entry) => key(entry) !== key(identity)
      || (identity.headSha && entry.headSha !== identity.headSha));
    if (next.length !== subjects.length) write(next);
  };
  return {
    subjects: read,
    matches(identity) {
      return read().some((entry) => key(entry) === key(identity) && entry.headSha === identity.headSha);
    },
    retain({ repoPath, prNumber, headSha }) {
      if (!repoPath || !Number.isInteger(prNumber) || prNumber < 1 || !headSha) return false;
      const subjects = read();
      if (subjects.some((entry) => key(entry) === key({ repoPath, prNumber }) && entry.headSha === headSha)) return true;
      return write([...subjects.filter((entry) => key(entry) !== key({ repoPath, prNumber })),
        { repoPath, prNumber, headSha }]);
    },
    drop,
    observe({ repoPath, prNumber, headSha, terminal = false }) {
      const subjects = read();
      const next = subjects.filter((entry) => key(entry) !== key({ repoPath, prNumber })
        || (!terminal && (!headSha || entry.headSha === headSha)));
      if (next.length !== subjects.length) write(next);
    },
    async reconcileMissing({ repoPath, discoveredPrNumbers, readLive }) {
      for (const entry of read()) {
        if (entry.repoPath !== repoPath || discoveredPrNumbers.has(entry.prNumber)) continue;
        try {
          const live = await readLive(entry.prNumber);
          const state = String(live.state || '').toLowerCase();
          this.observe({ ...entry, headSha: live.headRefOid || live.headSha,
            terminal: Boolean(live.mergedAt) || state === 'closed' || state === 'merged' });
        } catch {
          // Absence from discovery or a failed read is not proof of closure.
        }
      }
    },
  };
}
