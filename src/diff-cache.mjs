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

function encodeRepo(repo) {
  const normalizedRepo = String(repo || '').trim();
  if (!normalizedRepo) throw new TypeError('Repo slug is required for diff cache');
  return normalizedRepo.replace('/', '%2F');
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
  if (!normalizedHeadSha) {
    throw new TypeError('Head SHA is required for diff cache');
  }
  return normalizedHeadSha;
}

function buildCacheStem(repo, prNumber, headSha) {
  return `${encodeRepo(repo)}__${normalizePrNumber(prNumber)}__${normalizeHeadSha(headSha).slice(0, 12)}`;
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
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = openSync(tmpPath, 'w');
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
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
    entries.push({
      metaPath,
      patchPath,
      cachedAtMs: Number.isFinite(Date.parse(meta.cached_at)) ? Date.parse(meta.cached_at) : 0,
      bytes: Number(meta.bytes) > 0 ? Number(meta.bytes) : 0,
    });
  }
  return entries;
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

function getCachedDiff(repo, prNumber, headSha, {
  rootDir = resolveDefaultDiffCacheRootDir(),
  env = process.env,
  now = Date.now(),
} = {}) {
  const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
  if (!existsSync(patchPath) || !existsSync(metaPath)) return null;

  let metadata;
  try {
    metadata = readMetadata(metaPath);
  } catch {
    removeCacheEntry({ patchPath, metaPath });
    return null;
  }

  const cachedAtMs = Date.parse(metadata.cached_at);
  const ttlMs = resolveDiffCacheTtlHours(env) * 60 * 60 * 1000;
  if (!Number.isFinite(cachedAtMs) || (now - cachedAtMs) > ttlMs) {
    removeCacheEntry({ patchPath, metaPath });
    return null;
  }

  try {
    return {
      bytes: readFileSync(patchPath),
      source: 'cache',
    };
  } catch {
    removeCacheEntry({ patchPath, metaPath });
    return null;
  }
}

function putCachedDiff(repo, prNumber, headSha, bytes, {
  rootDir = resolveDefaultDiffCacheRootDir(),
  env = process.env,
  now = new Date(),
  etag,
} = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
  atomicWriteFile(patchPath, payload);
  atomicWriteFile(metaPath, `${JSON.stringify({
    cached_at: now.toISOString(),
    bytes: payload.byteLength,
    ...(etag ? { etag } : {}),
  }, null, 2)}\n`);
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
