import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ETAG_CACHE_DIR_PARTS = ['data', 'api-cache', 'etags'];
const DEFAULT_ETAG_CACHE_MAX_AGE_DAYS = 7;
const DEFAULT_ETAG_CACHE_MAX_BODY_BYTES = 256 * 1024;

function resolveEtagCacheDir(rootDir) {
  if (!rootDir) throw new TypeError('rootDir is required for ETag cache');
  return join(rootDir, ...ETAG_CACHE_DIR_PARTS);
}

function normalizeRequiredText(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${fieldName} is required for ETag cache key`);
  return text;
}

function normalizePrNumber(prNumber) {
  const parsed = Number(prNumber);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`Invalid PR number for ETag cache key: ${prNumber}`);
  }
  return parsed;
}

function canonicalizeParamValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeParamValue(entry));
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalizeParamValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

function buildEtagCallKey({
  repo,
  prNumber,
  category,
  endpoint,
  params = {},
} = {}) {
  const normalizedRepo = normalizeRequiredText(repo, 'repo');
  const normalizedCategory = normalizeRequiredText(category, 'category');
  const normalizedEndpoint = normalizeRequiredText(endpoint, 'endpoint');
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const normalizedParams = Object.keys(params || {})
    .sort()
    .map((key) => (
      `${encodeURIComponent(key)}-${encodeURIComponent(JSON.stringify(canonicalizeParamValue(params[key])))}`
    ));
  return [
    encodeURIComponent(normalizedRepo),
    normalizedPrNumber,
    encodeURIComponent(normalizedCategory),
    encodeURIComponent(normalizedEndpoint),
    ...normalizedParams,
  ].join('__');
}

function getEtagCachePath(rootDir, callKey) {
  const normalizedCallKey = normalizeRequiredText(callKey, 'callKey');
  const digest = createHash('sha256').update(normalizedCallKey).digest('hex');
  return join(resolveEtagCacheDir(rootDir), `${digest}.json`);
}

function getCachedEtag(rootDir, callKey) {
  const path = getEtagCachePath(rootDir, callKey);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const etag = String(raw?.etag || '').trim();
    if (!etag) return null;
    return {
      etag,
      body: raw?.body ?? null,
    };
  } catch {
    return null;
  }
}

function resolveEtagCacheMaxAgeDays(env = process.env) {
  const parsed = Number.parseInt(String(env.WATCHER_ETAG_CACHE_MAX_AGE_DAYS || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ETAG_CACHE_MAX_AGE_DAYS;
}

function resolveEtagCacheMaxBodyBytes(env = process.env) {
  const parsed = Number.parseInt(String(env.WATCHER_ETAG_CACHE_MAX_BODY_BYTES || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ETAG_CACHE_MAX_BODY_BYTES;
}

function shouldDropCachedBody(body, { maxBodyBytes = resolveEtagCacheMaxBodyBytes() } = {}) {
  const serialized = JSON.stringify(body ?? null);
  return Buffer.byteLength(serialized, 'utf8') > maxBodyBytes;
}

function putCachedEtag(rootDir, callKey, etag, body, {
  now = () => new Date().toISOString(),
  maxBodyBytes = resolveEtagCacheMaxBodyBytes(),
} = {}) {
  const normalizedEtag = String(etag || '').trim();
  if (!normalizedEtag) return null;
  const path = getEtagCachePath(rootDir, callKey);
  mkdirSync(resolveEtagCacheDir(rootDir), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const cachedBody = shouldDropCachedBody(body, { maxBodyBytes }) ? null : body;
  const payload = `${JSON.stringify({
    call_key: callKey,
    etag: normalizedEtag,
    cached_at: now(),
    body: cachedBody,
  }, null, 2)}\n`;
  const tmpFd = openSync(tmpPath, 'w');
  let shouldCleanupTmp = true;
  try {
    writeFileSync(tmpFd, payload, 'utf8');
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  try {
    renameSync(tmpPath, path);
    shouldCleanupTmp = false;
  } finally {
    if (shouldCleanupTmp) rmSync(tmpPath, { force: true });
  }
  return {
    etag: normalizedEtag,
    body: cachedBody,
  };
}

function sweepEtagCache(rootDir, {
  nowMs = Date.now(),
  maxAgeDays = resolveEtagCacheMaxAgeDays(),
  existsSyncImpl = existsSync,
  readdirSyncImpl = readdirSync,
  readFileSyncImpl = readFileSync,
  rmSyncImpl = rmSync,
} = {}) {
  const cacheDir = resolveEtagCacheDir(rootDir);
  if (!existsSyncImpl(cacheDir)) return [];
  const cutoffMs = nowMs - (Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000);
  const deleted = [];
  for (const name of readdirSyncImpl(cacheDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(cacheDir, name);
    try {
      const raw = JSON.parse(readFileSyncImpl(filePath, 'utf8'));
      const cachedAtMs = Date.parse(String(raw?.cached_at || ''));
      if (!Number.isFinite(cachedAtMs) || cachedAtMs >= cutoffMs) continue;
      rmSyncImpl(filePath, { force: true });
      deleted.push(filePath);
    } catch {
      continue;
    }
  }
  return deleted;
}

export {
  buildEtagCallKey,
  getCachedEtag,
  getEtagCachePath,
  putCachedEtag,
  resolveEtagCacheMaxAgeDays,
  resolveEtagCacheMaxBodyBytes,
  resolveEtagCacheDir,
  sweepEtagCache,
};
