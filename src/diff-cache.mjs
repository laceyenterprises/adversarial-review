import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR_PARTS = ['data', 'api-cache', 'diffs'];
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const MIN_MAX_BYTES = 50 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168;
const CACHE_FILE_MODE = 0o640;
const CACHE_DIR_MODE = 0o750;

function resolveDefaultDiffCacheRootDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveDiffCacheDir(rootDir = resolveDefaultDiffCacheRootDir()) {
  return join(rootDir, ...CACHE_DIR_PARTS);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function resolveDiffCacheMaxBytes(env = process.env) {
  return clampNumber(env.GHO_DIFF_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);
}

function resolveDiffCacheTtlHours(env = process.env) {
  return clampNumber(env.GHO_DIFF_CACHE_TTL_HOURS, DEFAULT_TTL_HOURS, MIN_TTL_HOURS, MAX_TTL_HOURS);
}

function assertSafeCacheComponent(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${fieldName} is required for diff cache`);
  if (text.includes('/') || text.includes('\\') || text.includes('\0') || text.includes('..')) {
    throw new TypeError(`Unsafe ${fieldName} for diff cache: ${value}`);
  }
  return text;
}

function encodeRepo(repo) {
  const normalizedRepo = String(repo || '').trim();
  const parts = normalizedRepo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new TypeError(`Invalid repo slug for diff cache: ${repo}`);
  }
  const encoded = `${encodeURIComponent(parts[0])}%2F${encodeURIComponent(parts[1])}`;
  return assertSafeCacheComponent(encoded, 'repo slug');
}

function normalizePrNumber(prNumber) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError(`Invalid PR number for diff cache: ${prNumber}`);
  }
  return normalizedPrNumber;
}

function normalizeHeadSha(headSha) {
  const normalizedHeadSha = String(headSha || '').trim();
  return assertSafeCacheComponent(normalizedHeadSha, 'head SHA');
}

function buildCacheStem(repo, prNumber, headSha) {
  return assertSafeCacheComponent(
    `${encodeRepo(repo)}__${normalizePrNumber(prNumber)}__${normalizeHeadSha(headSha).slice(0, 12)}`,
    'cache stem',
  );
}

function getDiffCachePaths(rootDir, repo, prNumber, headSha) {
  const stem = buildCacheStem(repo, prNumber, headSha);
  const dir = resolveDiffCacheDir(rootDir);
  return {
    dir,
    patchPath: join(dir, `${stem}.patch`),
    metaPath: join(dir, `${stem}.meta.json`),
  };
}

function atomicWriteFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true, mode: CACHE_DIR_MODE });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, 'w', CACHE_FILE_MODE);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined && fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Keep the original write/rename error.
      }
    }
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function removeCacheEntry({ patchPath, metaPath }) {
  rmSync(patchPath, { force: true });
  rmSync(metaPath, { force: true });
}

function readMetadata(metaPath) {
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

function listCacheEntries(rootDir, { readdirSyncImpl = readdirSync } = {}) {
  const cacheDir = resolveDiffCacheDir(rootDir);
  if (!existsSync(cacheDir)) return [];
  const entries = [];
  for (const name of readdirSyncImpl(cacheDir)) {
    if (!name.endsWith('.meta.json')) continue;
    const metaPath = join(cacheDir, name);
    let meta;
    try {
      meta = readMetadata(metaPath);
    } catch {
      continue;
    }
    const patchPath = metaPath.slice(0, -'.meta.json'.length) + '.patch';
    let bytes;
    try {
      bytes = statSync(patchPath).size;
    } catch {
      continue;
    }
    entries.push({
      metaPath,
      patchPath,
      cachedAtMs: Number.isFinite(Date.parse(meta.cached_at)) ? Date.parse(meta.cached_at) : 0,
      bytes,
    });
  }
  return entries;
}

function evictExpiredEntries(rootDir, { env = process.env, now = Date.now() } = {}) {
  const nowMs = normalizeNowMs(now);
  const ttlMs = resolveDiffCacheTtlHours(env) * 60 * 60 * 1000;
  for (const entry of listCacheEntries(rootDir)) {
    if (!Number.isFinite(entry.cachedAtMs) || (nowMs - entry.cachedAtMs) > ttlMs) {
      removeCacheEntry(entry);
    }
  }
}

function evictIfNeeded(rootDir, { env = process.env } = {}) {
  const budgetBytes = resolveDiffCacheMaxBytes(env);
  const entries = listCacheEntries(rootDir);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= budgetBytes) return;
  entries.sort((left, right) => left.cachedAtMs - right.cachedAtMs);
  for (const entry of entries) {
    removeCacheEntry(entry);
    totalBytes -= entry.bytes;
    if (totalBytes <= budgetBytes) break;
  }
}

function normalizeNowMs(now) {
  if (now instanceof Date) return now.getTime();
  const parsed = Number(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function metadataPayload(now) {
  return `${JSON.stringify({
    cached_at: new Date(normalizeNowMs(now)).toISOString(),
  }, null, 2)}\n`;
}

function getCachedDiff(repo, prNumber, headSha, {
  rootDir = resolveDefaultDiffCacheRootDir(),
  now = Date.now(),
} = {}) {
  const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
  if (!existsSync(patchPath) || !existsSync(metaPath)) return null;

  try {
    readMetadata(metaPath);
  } catch {
    removeCacheEntry({ patchPath, metaPath });
    return null;
  }

  let bytes;
  try {
    bytes = readFileSync(patchPath);
  } catch {
    removeCacheEntry({ patchPath, metaPath });
    return null;
  }

  try {
    atomicWriteFile(metaPath, metadataPayload(now));
  } catch {
    // A cache-hit metadata refresh must not turn immutable fixed-head diff
    // bytes into a miss; the next put/eviction pass can repair the LRU stamp.
  }

  return {
    bytes,
    source: 'cache',
  };
}

function putCachedDiff(repo, prNumber, headSha, bytes, {
  rootDir = resolveDefaultDiffCacheRootDir(),
  env = process.env,
  now = Date.now(),
} = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
  atomicWriteFile(patchPath, payload);
  atomicWriteFile(metaPath, metadataPayload(now));
  evictExpiredEntries(rootDir, { env, now });
  evictIfNeeded(rootDir, { env });
}

export {
  buildCacheStem,
  getCachedDiff,
  getDiffCachePaths,
  putCachedDiff,
  resolveDefaultDiffCacheRootDir,
  resolveDiffCacheDir,
  resolveDiffCacheMaxBytes,
  resolveDiffCacheTtlHours,
};
