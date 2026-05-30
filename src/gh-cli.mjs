import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_LOOKUP_TIMEOUT_MS = 30_000;
const GH_LOOKUP_MAX_BUFFER = 25 * 1024 * 1024;
const DEFAULT_PATH_FALLBACK = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

function buildAllowlistedGhEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
  const allowlisted = {
    PATH: env.PATH ?? DEFAULT_PATH_FALLBACK,
    HOME: env.HOME ?? '',
  };
  if (token) allowlisted.GH_TOKEN = token;
  return allowlisted;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isTransientGhError(err) {
  if (!err) return false;
  if (err.killed === true && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL')) return true;
  const code = String(err.code || '');
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') return true;
  const stderr = String(err.stderr || err.message || '');
  if (/timeout/i.test(stderr)) return true;
  if (/TLS handshake/i.test(stderr)) return true;
  if (/HTTP\s+5\d\d/i.test(stderr)) return true;
  return false;
}

async function execGhWithRetry({
  execFileImpl = execFileAsync,
  args,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
  retries = 2,
  backoffMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      return await execFileImpl(
        'gh',
        args,
        {
          env: buildAllowlistedGhEnv(env),
          maxBuffer: GH_LOOKUP_MAX_BUFFER,
          timeout: timeoutMs,
          killSignal: 'SIGTERM',
        }
      );
    } catch (err) {
      lastErr = err;
      if (!isTransientGhError(err) || attempt === retries) throw err;
      await sleep(backoffMs * (2 ** attempt));
      attempt += 1;
    }
  }
  throw lastErr;
}

export {
  GH_LOOKUP_MAX_BUFFER,
  GH_LOOKUP_TIMEOUT_MS,
  buildAllowlistedGhEnv,
  execGhWithRetry,
  isTransientGhError,
  parseDate,
  parseJsonLines,
};
