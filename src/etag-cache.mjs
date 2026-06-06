import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const ETAG_CACHE_DIR_PARTS = ['data', 'api-cache', 'etags'];

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
  return join(resolveEtagCacheDir(rootDir), `${normalizedCallKey}.json`);
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

function putCachedEtag(rootDir, callKey, etag, body, {
  now = () => new Date().toISOString(),
} = {}) {
  const normalizedEtag = String(etag || '').trim();
  if (!normalizedEtag) return null;
  const path = getEtagCachePath(rootDir, callKey);
  mkdirSync(resolveEtagCacheDir(rootDir), { recursive: true });
  const tmpPath = `${path}.tmp`;
  const payload = `${JSON.stringify({
    etag: normalizedEtag,
    cached_at: now(),
    body,
  }, null, 2)}\n`;
  const tmpFd = openSync(tmpPath, 'w');
  try {
    writeFileSync(tmpFd, payload, 'utf8');
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmpPath, path);
  return {
    etag: normalizedEtag,
    body,
  };
}

export {
  buildEtagCallKey,
  getCachedEtag,
  getEtagCachePath,
  putCachedEtag,
  resolveEtagCacheDir,
};
