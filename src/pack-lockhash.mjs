import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { execGhWithRetry } from './gh-cli.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';

const execFileAsync = promisify(execFile);
const PACKS_REPO_RE = /(^|\/)agent-os-packs$/;
const PACK_SPEC_RE = /^packs\/([^/]+)\/SPEC\.md$/;
const PACK_META_RE = /^packs\/([^/]+)\/SPEC\.meta\.json$/;

class PackLockhashInputError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PackLockhashInputError';
    this.code = 'PACK_LOCKHASH_INPUT';
  }
}

function isAgentOsPacksRepo(repo) {
  return PACKS_REPO_RE.test(String(repo || '').trim());
}

function isPackLockhashInputError(err) {
  return err instanceof PackLockhashInputError || err?.code === 'PACK_LOCKHASH_INPUT';
}

function isMissingRepoFileError(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  return /\bHTTP\s+404\b/i.test(text) || /\bnot found\b/i.test(text);
}

function isMalformedPackContentError(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  return /JSONDecodeError|json\s+decode|invalid\s+json|malformed\s+json|parse\s+error/i.test(text);
}

function discoverPackFromDiff(diffText) {
  const packIds = new Set();
  const paths = [];
  for (const file of parseDiffFiles(diffText)) {
    const path = file.path || file.newPath || file.oldPath || '';
    const specMatch = PACK_SPEC_RE.exec(path);
    const metaMatch = PACK_META_RE.exec(path);
    const packId = specMatch?.[1] || metaMatch?.[1] || null;
    if (!packId) continue;
    packIds.add(packId);
    paths.push(path);
  }
  if (packIds.size === 0) return null;
  if (packIds.size > 1) {
    throw new PackLockhashInputError(`pack PR touches multiple packs: ${[...packIds].sort().join(', ')}`);
  }
  const packId = [...packIds][0];
  return {
    packId,
    packPath: `packs/${packId}`,
    touchedPaths: paths.sort(),
  };
}

async function fetchRepoFileAtRef(repo, path, ref, {
  execGhWithRetryImpl = execGhWithRetry,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const encodedPath = String(path).split('/').map(encodeURIComponent).join('/');
  const encodedRef = encodeURIComponent(String(ref || ''));
  const { stdout } = await execGhWithRetryImpl({
    execFileImpl,
    args: [
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repo}/contents/${encodedPath}?ref=${encodedRef}`,
    ],
    env,
  });
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
}

async function computeCanonicalSpecLockhash(specText, metaText, {
  execFileImpl = execFileAsync,
  canonicalContentParent,
  env = process.env,
} = {}) {
  const parent = canonicalContentParent || join(import.meta.dirname, '..', '..', '..', 'platform');
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-os-pack-lockhash-'));
  try {
    const specPath = join(tempDir, 'SPEC.md');
    const metaPath = join(tempDir, 'SPEC.meta.json');
    await writeFile(specPath, specText, 'utf8');
    await writeFile(metaPath, metaText, 'utf8');
    const { stdout } = await execFileImpl(
      'python3',
      ['-m', 'canonical_content.lockhash', specPath, metaPath],
      {
        env: {
          ...env,
          PYTHONPATH: `${parent}${env.PYTHONPATH ? `:${env.PYTHONPATH}` : ''}`,
        },
        maxBuffer: 1024 * 1024,
      }
    );
    const lockhash = String(stdout || '').trim();
    if (!/^[0-9a-f]{12}$/.test(lockhash)) {
      throw new Error(`canonical lockhash command returned malformed hash: ${lockhash || '(empty)'}`);
    }
    return lockhash;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveReviewedPackLockhash({
  repo,
  headSha,
  diffText,
  fetchFileAtRefImpl = fetchRepoFileAtRef,
  computeLockhashImpl = computeCanonicalSpecLockhash,
  log = console,
} = {}) {
  if (!isAgentOsPacksRepo(repo)) return null;
  if (!String(headSha || '').trim()) return null;
  const pack = discoverPackFromDiff(diffText);
  if (!pack) return null;
  const specPath = `${pack.packPath}/SPEC.md`;
  const metaPath = `${pack.packPath}/SPEC.meta.json`;
  const fetchRequiredPackFile = async (path) => {
    try {
      return await fetchFileAtRefImpl(repo, path, headSha);
    } catch (err) {
      if (isMissingRepoFileError(err)) {
        throw new PackLockhashInputError(`pack PR is missing required file at ${path}`, { cause: err });
      }
      throw err;
    }
  };
  const [specText, metaText] = await Promise.all([
    fetchRequiredPackFile(specPath),
    fetchRequiredPackFile(metaPath),
  ]);
  let lockhash;
  try {
    lockhash = await computeLockhashImpl(specText, metaText);
  } catch (err) {
    if (isMalformedPackContentError(err)) {
      throw new PackLockhashInputError(`pack PR has malformed canonical lockhash input for ${pack.packPath}`, { cause: err });
    }
    throw err;
  }
  log?.log?.(
    `[reviewer] pack lockhash computed for ${repo}@${String(headSha || '').slice(0, 12)} ` +
      `${pack.packPath}=${lockhash}`
  );
  return {
    lockhash,
    packId: pack.packId,
    packPath: pack.packPath,
    source: 'canonical_content.lockhash',
  };
}

export {
  PackLockhashInputError,
  computeCanonicalSpecLockhash,
  discoverPackFromDiff,
  fetchRepoFileAtRef,
  isAgentOsPacksRepo,
  isPackLockhashInputError,
  resolveReviewedPackLockhash,
};
