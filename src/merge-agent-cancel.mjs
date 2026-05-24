import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { cancelMergeAgentDispatchOnMerge } from './follow-up-merge-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = [...argv];
  let repo = null;
  let prNumber = null;
  let hqPath = process.env.HQ_BIN || 'hq';
  const reasonParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo') {
      repo = args[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--pr') {
      prNumber = Number.parseInt(args[index + 1] || '', 10);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--pr=')) {
      prNumber = Number.parseInt(arg.slice('--pr='.length), 10);
      continue;
    }
    if (arg === '--hq') {
      hqPath = args[index + 1] || hqPath;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--hq=')) {
      hqPath = arg.slice('--hq='.length) || hqPath;
      continue;
    }
    reasonParts.push(arg);
  }

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Usage: node src/merge-agent-cancel.mjs --repo <owner/repo> --pr <number> [--hq hq] [reason]');
  }

  return {
    repo,
    prNumber,
    hqPath,
    reason: reasonParts.join(' ').trim() || 'Operator requested merge-agent cancellation.',
  };
}

function sanitizePathSegment(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180) || 'unknown';
}

function cancellationReceiptPath(rootDir, receipt, attempt = 0) {
  const safeRepo = sanitizePathSegment(receipt.repo);
  const safePr = sanitizePathSegment(`pr-${receipt.prNumber}`);
  const safeTs = sanitizePathSegment(receipt.requestedAt);
  const suffix = attempt ? `.${attempt}` : '';
  return join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-cancellations', `${safeRepo}-${safePr}-${safeTs}${suffix}.json`);
}

function writeCancellationReceipt(rootDir, receipt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filePath = cancellationReceiptPath(rootDir, receipt, attempt);
    try {
      writeFileAtomic(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { overwrite: false });
      return filePath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Unable to allocate merge-agent cancellation receipt for ${receipt.repo}#${receipt.prNumber}`);
}

async function cancelMergeAgentDispatch({
  rootDir = ROOT,
  repo,
  prNumber,
  hqPath = process.env.HQ_BIN || 'hq',
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  reason = 'Operator requested merge-agent cancellation.',
  ghExecFileImpl = execFileAsync,
  hqExecFileImpl = ghExecFileImpl,
  cancelImpl = cancelMergeAgentDispatchOnMerge,
} = {}) {
  const result = await cancelImpl({
    rootDir,
    repo,
    prNumber,
    hqPath,
    ghExecFileImpl,
    hqExecFileImpl,
    now: requestedAt,
  });
  const receipt = {
    kind: 'adversarial-review-merge-agent-cancellation',
    schemaVersion: 1,
    requestedAt,
    requestedBy,
    reason,
    repo,
    prNumber,
    hqPath,
    result,
  };
  const receiptPath = writeCancellationReceipt(rootDir, receipt);
  return {
    ...result,
    receipt,
    receiptPath,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await cancelMergeAgentDispatch({
      rootDir: ROOT,
      ...args,
    });
    console.log(
      `[merge-agent-cancel] cancelled=${result.cancelled} lrq=${result.launchRequestId || 'none'} ` +
      `labelRemoved=${result.labelRemoved} retryable=${result.retryable} receipt=${result.receiptPath}`
    );
    if (result.retryable) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[merge-agent-cancel] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  cancelMergeAgentDispatch,
  parseArgs,
};
