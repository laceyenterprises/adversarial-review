import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from './adapters/comms/github-pr-comments/redaction.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPLIES_ROOT = join(ROOT, 'data', 'replies');
const VALID_REPLY_STORAGE_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_FINAL_MESSAGE_DIGEST_PREVIEW_BYTES = 4 * 1024 * 1024;
const HQ_REMEDIATION_DISPATCH_TRIGGER =
  'remediation dispatches via hq (orchestration_mode=agentos or --with-hq-integration)';

function validateReplyStorageKey(key, label = 'replyStorageKey') {
  const value = String(key ?? '').trim();
  if (!value) {
    throw new Error(`Cannot resolve remediation reply storage key: missing ${label}`);
  }
  if (!VALID_REPLY_STORAGE_KEY.test(value)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(value)} must match ${VALID_REPLY_STORAGE_KEY} ` +
      'and cannot contain path separators or traversal segments'
    );
  }
  return value;
}

function resolveHqRoot(env = process.env, { requireExists = false } = {}) {
  if (!env.HQ_ROOT) {
    throw new Error(`HQ_ROOT must be set when ${HQ_REMEDIATION_DISPATCH_TRIGGER}`);
  }
  const root = resolve(env.HQ_ROOT);
  if (requireExists && !existsSync(root)) {
    throw new Error(
      `HQ remediation root does not exist: ${root}. ` +
      `Set HQ_ROOT to an existing agent-os-hq checkout before consuming follow-up jobs when ${HQ_REMEDIATION_DISPATCH_TRIGGER}.`
    );
  }
  return root;
}

function shouldUseHqIntegration(env = process.env) {
  return env.ADV_WITH_HQ_INTEGRATION === '1' || Boolean(env.HQ_ROOT);
}

function resolveLocalRepliesRoot(env = process.env, { requireExists = false } = {}) {
  const root = resolve(env.ADV_REPLIES_ROOT || DEFAULT_REPLIES_ROOT);
  if (requireExists && !existsSync(root)) {
    throw new Error(`Local remediation replies root does not exist: ${root}`);
  }
  return root;
}

function resolveRemediationReplyTarget(env = process.env, { requireExists = false } = {}) {
  if (shouldUseHqIntegration(env)) {
    const hqRoot = resolveHqRoot(env, { requireExists });
    return {
      mode: 'hq',
      root: hqRoot,
      resolvePath: ({ launchRequestId }) => resolveHqReplyPath({ hqRoot, launchRequestId }),
    };
  }
  const repliesRoot = resolveLocalRepliesRoot(env, { requireExists: false });
  return {
    mode: 'local',
    root: repliesRoot,
    resolvePath: ({ launchRequestId }) => {
      const replyStorageKey = validateReplyStorageKey(launchRequestId, 'launchRequestId');
      const replyPath = resolve(repliesRoot, replyStorageKey, 'remediation-reply.json');
      const relativePath = relative(repliesRoot, replyPath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Invalid local remediation reply path outside replies root: ${replyPath}`);
      }
      return { replyDir: dirname(replyPath), replyPath };
    },
  };
}

function resolveHqReplyPath({ hqRoot, launchRequestId }) {
  const replyStorageKey = validateReplyStorageKey(launchRequestId, 'launchRequestId');
  const replyPath = resolveHqReplyArtifactPath(
    join(hqRoot, 'dispatch', 'remediation-replies', replyStorageKey, 'remediation-reply.json'),
    { hqRoot }
  );
  return {
    replyDir: dirname(replyPath),
    replyPath,
  };
}

function requireWorkerReplyContext({ replyPath = null, hqRoot = null, launchRequestId = null }) {
  const normalizedReplyPath = String(replyPath ?? '').trim();
  let resolvedReplyPath = normalizedReplyPath;
  let resolvedReplyDir = normalizedReplyPath ? dirname(normalizedReplyPath) : null;

  if (normalizedReplyPath) {
    if (!isAbsolute(normalizedReplyPath)) {
      throw new Error(`Invalid replyPath: expected absolute path, got ${JSON.stringify(normalizedReplyPath)}`);
    }
    resolvedReplyPath = resolve(normalizedReplyPath);
    resolvedReplyDir = dirname(resolvedReplyPath);
  } else {
    const normalizedHqRoot = String(hqRoot ?? '').trim();
    if (!normalizedHqRoot) {
      throw new Error('Missing remediation reply path');
    }
    if (!isAbsolute(normalizedHqRoot)) {
      throw new Error(`Invalid hqRoot: expected absolute path, got ${JSON.stringify(normalizedHqRoot)}`);
    }
    const normalizedLaunchRequestId = validateReplyStorageKey(launchRequestId, 'launchRequestId');
    const hqReplyPath = resolveHqReplyPath({
      hqRoot: resolve(normalizedHqRoot),
      launchRequestId: normalizedLaunchRequestId,
    });
    resolvedReplyPath = hqReplyPath.replyPath;
    resolvedReplyDir = hqReplyPath.replyDir;
  }

  const normalizedHqRoot = String(hqRoot ?? '').trim();
  const normalizedLaunchRequestId = String(launchRequestId ?? '').trim();
  return {
    replyPath: resolvedReplyPath,
    replyDir: resolvedReplyDir,
    hqRoot: normalizedHqRoot
      ? resolve(normalizedHqRoot)
      : null,
    launchRequestId: normalizedLaunchRequestId
      ? validateReplyStorageKey(normalizedLaunchRequestId, 'launchRequestId')
      : null,
  };
}

function prepareHqReplyLandingPad({ hqRoot, launchRequestId }) {
  const required = requireWorkerReplyContext({ hqRoot, launchRequestId });
  const { replyDir, replyPath } = resolveHqReplyPath(required);
  mkdirSync(replyDir, { recursive: true });
  return { replyDir, replyPath };
}

function resolveReplyStorageKey(job) {
  const persistedKey = typeof job?.replyStorageKey === 'string' && job.replyStorageKey.trim()
    ? job.replyStorageKey.trim()
    : typeof job?.launchRequestId === 'string' && job.launchRequestId.trim()
      ? job.launchRequestId.trim()
      : null;
  if (persistedKey) {
    return validateReplyStorageKey(persistedKey, 'replyStorageKey');
  }
  if (typeof job?.jobId === 'string' && job.jobId.trim()) {
    return validateReplyStorageKey(job.jobId.trim(), 'jobId');
  }
  throw new Error('Cannot resolve remediation reply storage key: missing launchRequestId and jobId');
}

function resolveJobRelativePath(rootDir, relativePath, { label, allowMissing = true } = {}) {
  if (!relativePath) {
    return null;
  }

  const value = String(relativePath);
  if (isAbsolute(value)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }

  const absolutePath = resolve(rootDir, value);
  const relativeToRoot = relative(rootDir, absolutePath);
  if (relativeToRoot.startsWith('..') || relativeToRoot === '') {
    throw new Error(`Invalid ${label}: path escapes follow-up job root`);
  }

  if (!allowMissing && !existsSync(absolutePath)) {
    throw new Error(`Invalid ${label}: path does not exist`);
  }

  return absolutePath;
}

function resolveHqReplyArtifactPath(replyPath, { hqRoot, allowMissing = true } = {}) {
  if (!replyPath) {
    return null;
  }

  const value = String(replyPath);
  if (!isAbsolute(value)) {
    throw new Error('Invalid replyPath: HQ remediation reply paths must be absolute');
  }

  const absolutePath = resolve(value);
  const hqReplyRoot = join(resolve(hqRoot), 'dispatch', 'remediation-replies');
  const relativeToReplyRoot = relative(hqReplyRoot, absolutePath);
  if (
    relativeToReplyRoot.startsWith('..')
    || relativeToReplyRoot === ''
    || isAbsolute(relativeToReplyRoot)
  ) {
    throw new Error('Invalid replyPath: path escapes HQ remediation reply root');
  }

  if (!allowMissing && !existsSync(absolutePath)) {
    throw new Error('Invalid replyPath: path does not exist');
  }

  const replyDir = dirname(absolutePath);
  if (existsSync(replyDir) && lstatSync(replyDir).isSymbolicLink()) {
    throw new Error('Invalid replyPath: symbolic links are not allowed for reply directories');
  }
  if (existsSync(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error('Invalid replyPath: symbolic links are not allowed');
  }

  const realReplyRoot = resolveRealPath(hqReplyRoot);
  const realReplyPath = resolveRealPath(absolutePath);
  const realRelativeToReplyRoot = relative(realReplyRoot, realReplyPath);
  if (
    realRelativeToReplyRoot.startsWith('..')
    || realRelativeToReplyRoot === ''
    || isAbsolute(realRelativeToReplyRoot)
  ) {
    throw new Error('Invalid replyPath: resolved path escapes HQ remediation reply root');
  }

  return absolutePath;
}

// Resolve a path to its on-disk real path so symlinks cannot be used to
// escape the workspace. When the leaf file is missing, we still walk up
// to the longest existing ancestor and realpath that, then re-attach
// the missing tail — that way a symlinked workspace or symlinked
// .adversarial-follow-up/ is still caught even before the worker has
// written its artifact.
function resolveRealPath(candidate) {
  if (existsSync(candidate)) {
    return realpathSync.native?.(candidate) ?? realpathSync(candidate);
  }

  const tail = [];
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return candidate;
    }
    tail.unshift(basename(current));
    current = parent;
  }

  const realParent = realpathSync.native?.(current) ?? realpathSync(current);
  return join(realParent, ...tail);
}

function readWorkerFinalMessage(outputPath) {
  if (!outputPath || !existsSync(outputPath)) {
    return { exists: false, text: '', bytes: 0 };
  }

  const text = readFileSync(outputPath, 'utf8');
  return {
    exists: true,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function summarizeWorkerFinalMessage(text, limit = 400) {
  // Worker output is untrusted; redactSensitiveText masks tokens / Bearer
  // headers / private keys / labelled secrets the worker may have echoed
  // from logs or environment. Whitespace is collapsed so a one-line
  // preview fits in a digest field even if the worker dumped multi-line
        // output. Centralized in the GitHub PR comments redaction adapter so PR comments and final-
  // message previews share the same masking pipeline.
  const collapsed = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return '';
  }
  const redacted = redactSensitiveText(collapsed);
  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, limit - 1)}…`;
}

function digestWorkerFinalMessage(text) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  const hash = createHash('sha256');
  hash.update(buffer.subarray(0, MAX_FINAL_MESSAGE_DIGEST_PREVIEW_BYTES));
  if (buffer.length > MAX_FINAL_MESSAGE_DIGEST_PREVIEW_BYTES) {
    hash.update(Buffer.from(String(buffer.length), 'utf8'));
  }
  return hash.digest('hex');
}

export {
  DEFAULT_REPLIES_ROOT,
  MAX_FINAL_MESSAGE_DIGEST_PREVIEW_BYTES,
  HQ_REMEDIATION_DISPATCH_TRIGGER,
  validateReplyStorageKey,
  resolveHqRoot,
  shouldUseHqIntegration,
  resolveLocalRepliesRoot,
  resolveRemediationReplyTarget,
  resolveHqReplyPath,
  requireWorkerReplyContext,
  prepareHqReplyLandingPad,
  resolveReplyStorageKey,
  resolveJobRelativePath,
  resolveHqReplyArtifactPath,
  resolveRealPath,
  readWorkerFinalMessage,
  summarizeWorkerFinalMessage,
  digestWorkerFinalMessage,
};
