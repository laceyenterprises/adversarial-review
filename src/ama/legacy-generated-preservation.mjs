import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadConfigCached } from '../config-loader.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { runDerivedGenerator, withDerivedCheckout } from './derived-artifacts.mjs';

const REPOSITORY = 'laceyenterprises/agent-os';
const PATHS = new Set([
  'scripts/ledger-sql-baseline.json',
  'platform/app-sdk/state-machines.json',
  'modules/worker-pool/failure-classes.json',
]);
const SHA = /^[0-9a-f]{40}$/;
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function evidenceTuple(repository, { headSha, mergeBase, primaryHead, completeFileLists }, path) {
  if (repository !== REPOSITORY || !PATHS.has(path) || completeFileLists !== true) return null;
  const anchors = [mergeBase, primaryHead, headSha];
  if (!anchors.every(sha => SHA.test(sha || '')) || new Set(anchors).size !== 3) return null;
  return { version: 1, repository, base: mergeBase, author: primaryHead, head: headSha, path };
}

function modifiedBlob(files, path) {
  const matches = files?.filter(file => file.filename === path || file.previous_filename === path);
  if (matches?.length !== 1) return null;
  const [file] = matches;
  return file.status === 'modified' && !file.previous_filename
    && typeof file.patch === 'string' && file.patch.startsWith('@@ ')
    && SHA.test(file.sha || '') ? file.sha : null;
}

export function verifiedLegacyGeneratedPreservation(evidence, path) {
  if (!evidence.legacyGeneratedProofs?.length) return null;
  const tuple = evidenceTuple(evidence.repository, evidence, path);
  if (!tuple) return null;
  const primaryBlob = modifiedBlob(evidence.primaryFiles, path);
  const headBlob = modifiedBlob(evidence.finalFiles, path);
  if (!primaryBlob || !headBlob || primaryBlob === headBlob) return null;
  return evidence.legacyGeneratedProofs.find(proof => isDeepStrictEqual(proof, { tuple, primaryBlob, headBlob }));
}

function matchesOutput(output, tuple) {
  const text = output.toString('utf8');
  // The tuple is flat. Count JSON member names before parsing so duplicate
  // keys cannot collapse into an otherwise matching object.
  const members = text.match(/"(?:[^"\\]|\\.)*"[ \t\r\n]*:/g);
  return members?.length === Object.keys(tuple).length && isDeepStrictEqual(JSON.parse(text), tuple);
}

export async function proveLegacyGeneratedPreservation(args, evidence, refusal, {
  runGeneratorImpl = runDerivedGenerator,
} = {}) {
  if (refusal.reason !== 'primary-change-reverted' || refusal.missingEvidence?.evidence !== 'reversal-authorization'
    || !refusal.missingEvidence.regions?.length || refusal.missingEvidence.path !== refusal.path) return null;
  const tuple = evidenceTuple(args.repo, evidence, refusal.path);
  if (!tuple || args.headSha !== tuple.head || !args.get.regularDataFile) return null;
  const primaryBlob = modifiedBlob(evidence.primaryFiles, tuple.path);
  const headBlob = modifiedBlob(evidence.finalFiles, tuple.path);
  if (!primaryBlob || !headBlob || primaryBlob === headBlob) return null;

  try {
    const deadline = AbortSignal.timeout(loadAwareTimeoutMs(30000));
    const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const env = args.env || process.env;
    const deployRoot = env.AGENT_OS_DEPLOY_CHECKOUT || loadConfigCached({ env }).get('roots.deploy');
    if (!deployRoot || !isAbsolute(deployRoot)) return null;
    const owner = await realpath(deployRoot);
    const verifier = join(owner, 'scripts', 'verify-legacy-generated-preservation.py');
    if (!(await lstat(verifier)).isFile() || await realpath(verifier) !== verifier) return null;

    return await withDerivedCheckout({ ...args, signal, registeredOnly: true,
      mergeBase: tuple.base, primaryHead: tuple.author, headSha: tuple.head },
    async ({ scratch, source, show, requireAncestor }) => {
      await requireAncestor(tuple.base, tuple.author);
      await requireAncestor(tuple.author, tuple.head);
      for (const [ref, expectedBlob] of [[tuple.base, null], [tuple.author, primaryBlob], [tuple.head, headBlob]]) {
        signal.throwIfAborted();
        const bytes = await args.get.regularDataFile(tuple.repository, ref, tuple.path, { asBuffer: true });
        const local = await show(ref, tuple.path, { dataFile: true });
        if (!Buffer.isBuffer(bytes) || !local.equals(bytes) || (expectedBlob && blobSha(bytes) !== expectedBlob)) return null;
      }
      const gitDir = join(source, '.git');
      const metadata = await lstat(gitDir).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (metadata && !metadata.isDirectory()) return null;
      const output = await runGeneratorImpl({ scratch, cwd: '.', signal, captureStdout: true,
        readOnly: [metadata ? gitDir : source, join(owner, 'scripts'),
          join(owner, 'modules', 'worker-pool', 'lib', 'python')],
        command: ['python3', '-I', verifier, '--repo', source, '--repository', tuple.repository,
          '--base', tuple.base, '--author', tuple.author, '--head', tuple.head, '--path', tuple.path] });
      signal.throwIfAborted();
      return matchesOutput(output, tuple) ? { tuple, primaryBlob, headBlob } : null;
    });
  } catch {
    args.signal?.throwIfAborted();
    return null;
  }
}
