// LAC-2117: materialise exact immutable releases for the Python provenance owner.
// The PR's records are claims. Only live merged producer reads supply authority.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const ARTIFACT_RECORD_PATH = 'vendor/argus-artifacts.json';
// GitHub's contents JSON endpoint only supplies inline base64 up to 1 MiB.
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !posix.isAbsolute(value) && !value.split('/').includes('..') && posix.normalize(value) === value;
}

function records(text) {
  try {
    const doc = JSON.parse(text);
    return doc?.schemaVersion === 1 && doc.packages && typeof doc.packages === 'object' ? doc.packages : {};
  } catch { return {}; }
}

/** No extraction, installation, shell interpolation, or reads from live checkouts. */
export async function gatherArtifactEvidence({ job, pr, dir, treeRoot, files, io }) {
  const locks = {};
  try {
    for (const side of ['base', 'head']) locks[side] = JSON.parse(files[side].lock)?.packages || {};
  } catch { return {}; }
  const candidates = Object.entries(locks.head).filter(([path, entry]) => path.startsWith('node_modules/')
    && String(entry?.resolved || '').startsWith('file:') && locks.base[path]
    && JSON.stringify(entry) !== JSON.stringify(locks.base[path])).slice(0, 4);
  if (!candidates.length) return {};
  const recordPath = dir ? `${dir}/${ARTIFACT_RECORD_PATH}` : ARTIFACT_RECORD_PATH;
  const refs = { base: pr.baseSha, head: job.headSha };
  const claims = {};
  for (const side of ['base', 'head']) claims[side] = records(await io.fetchFileAtRef({ repo: job.repo, path: recordPath, ref: refs[side] }));
  const evidence = {};
  for (const [index, [path, entry]] of candidates.entries()) {
    const name = entry.name || path.slice('node_modules/'.length);
    const proof = {};
    for (const side of ['base', 'head']) {
      const record = claims[side][name];
      const local = String(locks[side][path]?.resolved || '').slice(5);
      // Invalid or unavailable claims yield no proof, hence the existing high.
      if (!record || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(record.producerRepo || '')
          || (side === 'head' && record.producerRepo !== claims.base[name]?.producerRepo)
          || !/^[a-f0-9]{40}$/u.test(record.producerCommit || '')
          || !Number.isSafeInteger(record.producerPr) || record.producerPr <= 0
          || !relativePath(record.producerPath) || !relativePath(local)
          || typeof io.fetchArtifactAtRef !== 'function' || typeof io.fetchProducerPullRequest !== 'function') continue;
      const producer = await io.fetchProducerPullRequest({ repo: record.producerRepo, prNumber: record.producerPr });
      if (producer?.merged !== true || producer.mergeCommit !== record.producerCommit
          || typeof producer.defaultBranch !== 'string' || !producer.defaultBranch
          || producer.baseRef !== producer.defaultBranch) continue;
      const consumer = await io.fetchArtifactAtRef({ repo: job.repo, path: dir ? `${dir}/${local}` : local, ref: refs[side] });
      const upstream = await io.fetchArtifactAtRef({ repo: record.producerRepo, path: record.producerPath, ref: record.producerCommit });
      if (!Buffer.isBuffer(consumer) || !Buffer.isBuffer(upstream)
          || consumer.length > MAX_ARTIFACT_BYTES || upstream.length > MAX_ARTIFACT_BYTES) continue;
      const outDir = join(treeRoot, 'artifacts');
      mkdirSync(outDir, { recursive: true });
      const consumerFile = `artifacts/${index}-${side}-consumer.tgz`;
      const producerFile = `artifacts/${index}-${side}-producer.tgz`;
      writeFileSync(join(treeRoot, consumerFile), consumer);
      writeFileSync(join(treeRoot, producerFile), upstream);
      proof[side] = { record, producer, consumerFile, producerFile,
        consumerSha256: createHash('sha256').update(consumer).digest('hex'),
        producerSha256: createHash('sha256').update(upstream).digest('hex') };
    }
    evidence[path] = proof;
  }
  return evidence;
}
