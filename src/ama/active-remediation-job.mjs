import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read the two durable active-job buckets without coupling AMA to the daemon module. */
export function findActiveRemediationJob(rootDir, { repo, prNumber }) {
  for (const bucket of ['pending', 'in-progress']) {
    const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      let job;
      try {
        job = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (String(job?.repo || '').toLowerCase() === String(repo).toLowerCase()
        && Number(job?.prNumber) === Number(prNumber)) {
        return job;
      }
    }
  }
  return null;
}
