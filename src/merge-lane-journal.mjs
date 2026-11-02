// Bounded observational journals. Contention drops a sample, never blocks a closer.
import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fsExt from 'fs-ext';

export const observationFingerprint = r => JSON.stringify([r.head, r.next?.action, r.next?.row, r.next?.reason, r.next?.deadline?.anchorSource === 'observed' ? null : r.next?.deadline?.anchoredAt]);

export const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
export function appendShadowRecord(rootDir, name, record, { maxBytes = JOURNAL_MAX_BYTES } = {}) {
  if (!['disagreements.jsonl', 'observations.jsonl'].includes(name)) throw new Error('unknown shadow journal');
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > Math.min(maxBytes, 256 * 1024)) throw new Error('shadow record too large');
  const dir = join(rootDir, 'data/next-action-shadow');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${name}.lock`), 'a', 0o600);
  try {
    try { fsExt.flockSync(fd, 'exnb'); }
    catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return false; throw error; }
    if (name === 'observations.jsonl') {
      // Compact episode cursors survive journal rotation. The same kernel lock
      // serializes cursors and samples; a dropped sample never advances a pager.
      const cursorFile = join(dir, 'episodes.json');
      let cursors = {};
      try {
        if (statSync(cursorFile).size > 8 * 1024 * 1024) throw new Error('episode cursors too large');
        cursors = JSON.parse(readFileSync(cursorFile, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const now = Date.parse(record.observedAt);
      if (!Number.isFinite(now)) throw new Error('invalid observation time');
      const key = createHash('sha256').update(record.subjectKey || `${record.repo}#${record.prNumber}`).digest('hex');
      const fingerprint = observationFingerprint(record);
      const previous = cursors[key];
      // Older async reads must not rewind the cursor or re-arm an episode.
      if (previous && Date.parse(previous.seen) > now) return false;
      record = { ...record, episodeStartedAt: previous?.fingerprint === fingerprint ? previous.started : record.observedAt };
      cursors[key] = { fingerprint, started: record.episodeStartedAt, seen: record.observedAt };
      const data = JSON.stringify(cursors);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('episode cursors too large');
      writeFileSync(`${cursorFile}.tmp`, data, { mode: 0o600 });
      renameSync(`${cursorFile}.tmp`, cursorFile);
      line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > Math.min(maxBytes, 256 * 1024)) throw new Error('shadow record too large');
    }
    const file = join(dir, name);
    let size = 0;
    try { size = statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, line, { mode: 0o600 });
    return true;
  } finally { closeSync(fd); }
}
