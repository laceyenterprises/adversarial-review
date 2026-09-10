import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfigCached } from './config-loader.mjs';

const execFileAsync = promisify(execFile);

const ID_BIN = '/usr/bin/id';
const DEFAULT_UID_LOOKUP_TIMEOUT_MS = 2_000;
const DEFAULT_UID_LOOKUP_RETRY_DELAYS_MS = [250, 750];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveUid(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = typeof value === 'number' ? value : Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeLocalUsername(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function isRetryableUidLookupError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['EAGAIN', 'EBUSY', 'EIO', 'ETIMEDOUT'].includes(code)) return true;
  const text = String(`${err?.message || ''}\n${err?.stderr || ''}`).toLowerCase();
  return /temporar|timed out|timeout|resource busy|opendirectory|input\/output/.test(text);
}

async function execFileWithUidLookupRetry(execFileImpl, args, options, {
  adminUser,
  logger,
  retryDelaysMs,
  sleepImpl,
}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await execFileImpl(ID_BIN, args, options);
    } catch (err) {
      if (!isRetryableUidLookupError(err) || attempt >= retryDelaysMs.length) throw err;
      const delay = retryDelaysMs[attempt];
      logger?.warn?.(
        `[reviewer] Claude launchctl UID lookup for ${adminUser} failed transiently; ` +
          `retrying in ${delay}ms (${err?.message || err})`
      );
      await sleepImpl(delay);
    }
  }
}

export async function resolveClaudeLaunchctlUidFromConfig({
  loadConfigImpl = loadConfigCached,
  execFileImpl = execFileAsync,
  env = process.env,
  logger = console,
  lookupTimeoutMs = DEFAULT_UID_LOOKUP_TIMEOUT_MS,
  lookupRetryDelaysMs = DEFAULT_UID_LOOKUP_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  let cfg = null;
  try {
    cfg = typeof loadConfigImpl === 'function' ? loadConfigImpl({ env }) : null;
  } catch (err) {
    logger?.warn?.(
      `[reviewer] Claude launchctl UID config load failed; admin ownership unavailable ` +
        `(${err?.message || err})`
    );
  }

  const explicitUid = env?.AGENT_OS_ROOTS_ADMIN_UID ?? cfg?.get?.('roots.admin_uid', null);
  if (explicitUid !== undefined && explicitUid !== null && String(explicitUid).trim() !== '') {
    const uid = normalizePositiveUid(explicitUid);
    if (uid !== null) return uid;
    logger?.warn?.(
      `[reviewer] Claude launchctl UID is invalid (${explicitUid}); admin ownership unavailable`
    );
    return null;
  }

  const adminUser = normalizeLocalUsername(
    env?.AGENT_OS_ROOTS_ADMIN_USER ?? cfg?.get?.('roots.admin_user', null)
  );
  if (!adminUser || typeof execFileImpl !== 'function') return null;
  try {
    const result = await execFileWithUidLookupRetry(
      execFileImpl,
      ['-u', adminUser],
      {
        env,
        encoding: 'utf8',
        maxBuffer: 1024,
        timeout: lookupTimeoutMs,
      },
      {
        adminUser,
        logger,
        retryDelaysMs: lookupRetryDelaysMs,
        sleepImpl,
      }
    );
    const uid = normalizePositiveUid(result?.stdout ?? result);
    if (uid !== null) return uid;
    logger?.warn?.(
      `[reviewer] Claude launchctl UID lookup for ${adminUser} returned ` +
        `an invalid UID (${String(result?.stdout ?? result).trim()}); admin ownership unavailable`
    );
  } catch (err) {
    logger?.warn?.(
      `[reviewer] Claude launchctl UID lookup for ${adminUser} failed; ` +
        `admin ownership unavailable (${err?.message || err})`
    );
  }
  return null;
}

export const __test__ = {
  ID_BIN,
  DEFAULT_UID_LOOKUP_TIMEOUT_MS,
  DEFAULT_UID_LOOKUP_RETRY_DELAYS_MS,
  execFileWithUidLookupRetry,
  isRetryableUidLookupError,
  normalizePositiveUid,
  normalizeLocalUsername,
};
