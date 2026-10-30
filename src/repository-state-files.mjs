import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const repositoryStateDigest = value => createHash('sha256').update(value).digest('hex');
export function canonicalRepositoryJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRepositoryJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalRepositoryJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Only identity values are rewritten. Review bodies, signed attestations,
// evidence digests, worker IDs, job IDs and workspace paths remain evidence.
export function rekeyRepositoryValue(value, oldName, newName) {
  if (typeof value === 'string') {
    const lower = value.toLowerCase(), oldLower = oldName.toLowerCase();
    if (lower === oldLower) return newName;
    const prUrlPrefix = `https://github.com/${oldLower}/pull/`;
    if (lower.startsWith(prUrlPrefix) && /^\d+$/.test(value.slice(prUrlPrefix.length))) {
      return `https://github.com/${newName}/pull/${value.slice(prUrlPrefix.length)}`;
    }
    if ([`${oldLower}#`, `${oldLower}::`, `${oldLower}|`,
      `page:${oldName.toLowerCase()}:`, `rerun:${oldName.toLowerCase()}:`,
      `workflow-rerun:${oldName.toLowerCase()}:`].some(prefix => lower.startsWith(prefix))) {
      if (lower.startsWith('page:') || lower.startsWith('rerun:') || lower.startsWith('workflow-rerun:')) {
        const offset = value.indexOf(':') + 1;
        return value.slice(0, offset) + newName.toLowerCase() + value.slice(offset + oldName.length);
      }
      return newName + value.slice(oldName.length);
    }
    // Some dedupe keys serialize an identity tuple rather than naming columns.
    if (/^[{[]/.test(value)) {
      try {
        const parsed = JSON.parse(value), next = rekeyRepositoryValue(parsed, oldName, newName);
        if (JSON.stringify(parsed) !== JSON.stringify(next)) return JSON.stringify(next);
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rekeyRepositoryValue(item, oldName, newName));
  if (!value || typeof value !== 'object') return value;
  if (value.signature || value.signedEnvelope || value.signedPayload) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    rekeyRepositoryValue(key, oldName, newName),
    ['signature', 'signedEnvelope', 'signedPayload', 'attestation'].includes(key)
      ? item : rekeyRepositoryValue(item, oldName, newName),
  ]));
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Repository migration refuses symlink: ${path}`);
    if (entry.isDirectory()) {
      if (['repository-renames', 'api-cache', 'finalization-git', 'workspaces', 'node_modules', '.git'].includes(entry.name)) return [];
      return filesUnder(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

function addHashPair(pairs, before, after) {
  if (before === after) return;
  pairs.set(repositoryStateDigest(before), repositoryStateDigest(after));
  pairs.set('sha256:' + repositoryStateDigest(before), 'sha256:' + repositoryStateDigest(after));
}

export function rekeyRepositoryDigests(value, hashes) {
  if (typeof value === 'string') return hashes.get(value) || value;
  if (Array.isArray(value)) return value.map(item => rekeyRepositoryDigests(item, hashes));
  if (!value || typeof value !== 'object' || value.signature || value.signedEnvelope || value.signedPayload) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'attestation' ? item : rekeyRepositoryDigests(item, hashes)]));
}

export function collectRepositoryIdentityHashes(pairs, records, oldName, newName) {
  // A receipt can checksum a decision which references a handoff checksum.
  // Resolve that finite dependency chain before writing any participant.
  for (let iteration = 0; iteration < 16; iteration++) {
    const before = JSON.stringify([...pairs]);
    for (const record of records) identityHashes(pairs, record, oldName, newName);
    if (JSON.stringify([...pairs]) === before) return;
  }
  throw new Error('Repository identity digest dependencies did not converge');
}

// Filename recipes audited against the owners in docs/data-model/catalog.json.
// Opaque IDs stay opaque even when they contain a historical repo slug.
export function identityHashes(pairs, record, oldName, newName) {
  if (!record || typeof record !== 'object') return;
  if (record.signature || record.signedEnvelope || record.signedPayload) return;
  for (const [key, item] of Object.entries(record)) {
    if (key !== 'attestation') identityHashes(pairs, item, oldName, newName);
  }
  const rewritten = rekeyRepositoryDigests(rekeyRepositoryValue(record, oldName, newName), pairs);
  // Queue merge receipts checksum their unsigned body without the digest
  // member. Keep that checksum and outbox references bound to the moved lane.
  if (typeof record.digest === 'string') {
    const { digest: priorDigest, ...body } = record;
    const nextBody = { ...rewritten };
    delete nextBody.digest;
    if (priorDigest === repositoryStateDigest(canonicalRepositoryJson(body))) {
      pairs.set(priorDigest, repositoryStateDigest(canonicalRepositoryJson(nextBody)));
    }
  }
  if (typeof record.id === 'string' && record.id.startsWith('decision:')) {
    const { id, ...body } = record;
    const nextBody = { ...rewritten };
    delete nextBody.id;
    if (id === `decision:${repositoryStateDigest(canonicalRepositoryJson(body))}`) {
      pairs.set(id, `decision:${repositoryStateDigest(canonicalRepositoryJson(nextBody))}`);
    }
  }
  if (typeof record.identity === 'string') {
    addHashPair(pairs, record.identity, rekeyRepositoryValue(record.identity, oldName, newName));
  }
  addHashPair(pairs, JSON.stringify(record), JSON.stringify(rewritten));
  addHashPair(pairs, canonicalRepositoryJson(record), canonicalRepositoryJson(rewritten));
  if (Array.isArray(record)) {
    return;
  }
  const repo = record.repo || record.repository || record.repoPath;
  const pr = record.prNumber ?? record.pr_number ?? record.pr;
  const head = record.headSha ?? record.head_sha ?? record.head;
  if (typeof repo === 'string' && repo.toLowerCase() === oldName.toLowerCase()) {
    const prNumber = Number(pr);
    if (Number.isSafeInteger(prNumber) && prNumber > 0) {
      const before = `${repo}#${prNumber}`, after = `${newName}#${prNumber}`;
      addHashPair(pairs, before, after);
      addHashPair(pairs, before.toLowerCase(), after.toLowerCase());
      addHashPair(pairs, JSON.stringify([repo, prNumber, head]), JSON.stringify([newName, prNumber, head]));
      if (record.eventId) addHashPair(pairs, JSON.stringify([repo, prNumber, record.eventId]),
        JSON.stringify([newName, prNumber, record.eventId]));
      addHashPair(pairs, `${before}@${head || 'unknown'}`, `${after}@${head || 'unknown'}`);
      for (const reason of [record.reason, record.eligibilityReason].filter(Boolean)) {
        const suffix = `@${head || '-'}:${reason}`;
        addHashPair(pairs, before + suffix, after + suffix);
        if (record.wakeAttemptKey) addHashPair(pairs,
          `${before}${suffix}:attempt:${record.wakeAttemptKey}`, `${after}${suffix}:attempt:${record.wakeAttemptKey}`);
      }
      if (record.primaryHead) {
        const fields = ['repo', 'prNumber', 'primaryHead', 'headSha', 'mergeBase', 'path', 'primaryBlob', 'blob'];
        addHashPair(pairs, JSON.stringify(fields.map(key => record[key])),
          JSON.stringify(fields.map(key => rewritten[key])));
      }
      if (record.reasons && record.missingEvidence) {
        const hold = { repo, prNumber, headSha: head, reasons: record.reasons, missingEvidence: record.missingEvidence,
          ...(record.awaitedInputs?.length ? { awaitedInputs: record.awaitedInputs } : {}) };
        addHashPair(pairs, JSON.stringify(hold), JSON.stringify({ ...hold, repo: newName }));
      }
    }
  }
}

export function planRepositoryStateFiles(rootDir, { oldName, newName, subjects = [], additionalStateDir }) {
  const hashes = new Map();
  addHashPair(hashes, oldName.toLowerCase(), newName.toLowerCase());
  const files = [...new Set([...filesUnder(join(rootDir, 'data')),
    ...(additionalStateDir && resolve(additionalStateDir) !== resolve(rootDir, 'data') ? filesUnder(additionalStateDir) : [])])];
  const parsed = new Map();
  for (const path of files) {
    if (!/\.(json|jsonl)$/.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    const records = path.endsWith('.jsonl') ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [JSON.parse(text)];
    parsed.set(path, { text, records });
  }
  collectRepositoryIdentityHashes(hashes, [...subjects, ...[...parsed.values()].flatMap(entry => entry.records)], oldName, newName);
  const encodings = [
    [encodeURIComponent(oldName), encodeURIComponent(newName)],
    [oldName.replaceAll('/', '__'), newName.replaceAll('/', '__')],
    [oldName.replaceAll('/', '--'), newName.replaceAll('/', '--')],
    [oldName.replaceAll('/', '-'), newName.replaceAll('/', '-')],
  ];
  const jobNames = [...parsed].flatMap(([path, entry]) =>
    entry.records.some(record => record?.jobId && basename(path) === `${record.jobId}.json`) ? [basename(path)] : []);
  const plan = [];
  for (const path of files) {
    let name = basename(path);
    // Job IDs are referenced by telemetry and worker launches. Retain the
    // filename; readers use repository history to find these original IDs.
    const opaqueJob = jobNames.some(jobName => name === jobName || name.startsWith(`${jobName}.`));
    for (const [before, after] of opaqueJob ? [] : encodings) {
      if (name === before || name.startsWith(before) && /[-_.]/.test(name[before.length] || '')) {
        name = after + name.slice(before.length);
        break;
      }
    }
    for (const [before, after] of hashes) {
      if (name.startsWith(before)) name = after + name.slice(before.length);
    }
    const target = join(dirname(path), name);
    const entry = parsed.get(path);
    let after = entry?.text;
    if (entry) {
      const rewritten = entry.records.map(record => rekeyRepositoryValue(record, oldName, newName));
      if (JSON.stringify(rewritten) !== JSON.stringify(entry.records)) {
        after = path.endsWith('.jsonl') ? rewritten.map(record => JSON.stringify(record)).join('\n') + '\n'
          : JSON.stringify(rewritten[0], null, 2) + '\n';
      }
    }
    if (target === path && (!entry || after === entry.text)) continue;
    if (existsSync(target) && target !== path) throw new Error(`Repository state destination already exists: ${target}`);
    if (/\.(db|db-wal|db-shm)$/.test(path)) {
      // Per-subject stores have no repo columns. SQLite handles their journal;
      // moving a live WAL independently would lose committed observations.
      if (existsSync(`${path}-wal`) && lstatSync(`${path}-wal`).size > 0) {
        throw new Error(`Repository state database is busy: ${path}`);
      }
    }
    plan.push({ source: relative(rootDir, path), target: relative(rootDir, target),
      beforeHash: repositoryStateDigest(readFileSync(path)), after,
      mode: lstatSync(path).mode & 0o777 });
  }
  // Update exact file references after planning all destinations. Workspace
  // paths, URLs and embedded prose are not identities and are left intact.
  const paths = new Map(plan.filter(entry => entry.source !== entry.target)
    .map(entry => [join(rootDir, entry.source), join(rootDir, entry.target)]));
  const rewritePaths = value => {
    if (typeof value === 'string') return paths.get(value) || hashes.get(value) || value;
    if (Array.isArray(value)) return value.map(rewritePaths);
    if (!value || typeof value !== 'object' || value.signature || value.signedEnvelope || value.signedPayload) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === 'attestation' ? item : rewritePaths(item)]));
  };
  for (const [path, original] of parsed) {
    let entry = plan.find(item => join(rootDir, item.source) === path);
    const values = entry?.after
      ? path.endsWith('.jsonl') ? entry.after.trim().split('\n').map(line => JSON.parse(line)) : [JSON.parse(entry.after)]
      : original.records;
    const rewritten = values.map(rewritePaths);
    if (JSON.stringify(values) === JSON.stringify(rewritten)) continue;
    if (!entry) {
      entry = { source: relative(rootDir, path), target: relative(rootDir, path),
        beforeHash: repositoryStateDigest(readFileSync(path)), mode: lstatSync(path).mode & 0o777 };
      plan.push(entry);
    }
    entry.after = path.endsWith('.jsonl') ? rewritten.map(value => JSON.stringify(value)).join('\n') + '\n'
      : JSON.stringify(rewritten[0], null, 2) + '\n';
  }
  return plan;
}

// Replay accepts exactly the recorded before or after image. An unexpected
// concurrent write stops recovery instead of overwriting another owner's data.
export function applyRepositoryStateFiles(rootDir, plan, afterFile = () => {}) {
  for (const [index, entry] of plan.entries()) {
    const source = join(rootDir, entry.source), target = join(rootDir, entry.target);
    const afterHash = entry.after === undefined ? entry.beforeHash : repositoryStateDigest(entry.after);
    const sourceExists = existsSync(source), targetExists = existsSync(target);
    if (!sourceExists) {
      if (!targetExists || repositoryStateDigest(readFileSync(target)) !== afterHash) {
        throw new Error(`Repository rename recovery cannot verify ${entry.target}`);
      }
      continue;
    }
    const current = repositoryStateDigest(readFileSync(source));
    if (current !== entry.beforeHash && current !== afterHash) {
      throw new Error(`Repository rename source changed: ${entry.source}`);
    }
    if (source !== target && targetExists) {
      if (repositoryStateDigest(readFileSync(target)) !== afterHash) {
        throw new Error(`Repository rename destination changed: ${entry.target}`);
      }
      unlinkSync(source);
    } else {
      if (entry.after !== undefined && current !== afterHash) writeFileAtomic(source, entry.after, { mode: entry.mode });
      if (source !== target) renameSync(source, target);
    }
    if (source !== target) {
      const directory = openSync(dirname(source), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    afterFile(index);
  }
}
