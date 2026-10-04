// Serialize terminal-job mutation with writers and the archive sweep.
import { openSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fsExt from 'fs-ext';
import { writeFileAtomic } from './atomic-write.mjs';

const held = new Set();
export function withFollowUpJobLock(root, action) {
  if (held.has(root)) return action();
  mkdirSync(root, { recursive: true });
  const fd = openSync(join(root, '.write.lock'), 'a');
  try {
    // Contention defers to the next tick rather than blocking a daemon.
    fsExt.flockSync(fd, 'exnb');
    held.add(root);
    try { return action(); } finally { held.delete(root); fsExt.flockSync(fd, 'un'); }
  } finally { closeSync(fd); }
}

function jobRoot(path) {
  let root = dirname(path);
  if (/^\d{4}-\d{2}$/u.test(root.split('/').at(-1))) root = dirname(root);
  return dirname(root);
}

export function writeFollowUpJob(jobPath, job) {
  return withFollowUpJobLock(jobRoot(jobPath), () => {
    let current;
    try { current = JSON.parse(readFileSync(jobPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const intent = current?.completion?.withheldHeadReReview;
    const next = intent ? { ...job, completion: { ...job.completion, withheldHeadReReview: intent } } : job;
    writeFileAtomic(jobPath, `${JSON.stringify(next, null, 2)}\n`);
  });
}
