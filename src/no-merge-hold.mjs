import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { NO_MERGE_HOLD_LABEL } from './follow-up-merge-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = [...argv];
  let repo = null;
  let prNumber = null;
  let resume = false;
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
    if (arg === '--resume' || arg === '--release') {
      resume = true;
      continue;
    }
    reasonParts.push(arg);
  }

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Usage: node src/no-merge-hold.mjs --repo <owner/repo> --pr <number> [--resume] [reason]');
  }

  return {
    repo,
    prNumber,
    resume,
    reason: reasonParts.join(' ').trim() || (resume ? 'Operator released no-merge hold.' : 'Operator applied no-merge hold.'),
  };
}

async function ensureNoMergeHoldLabel({ repo, execFileImpl = execFileAsync } = {}) {
  await execFileImpl('gh', [
    'label',
    'create',
    NO_MERGE_HOLD_LABEL,
    '--repo',
    repo,
    '--description',
    'Operator hold: block merge-agent and adversarial gate for this PR',
    '--color',
    'd93f0b',
    '--force',
  ]);
}

function holdReceiptPath(rootDir, { repo, prNumber, requestedAt }) {
  const safeRepo = String(repo || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_') || 'unknown';
  const safeTs = String(requestedAt || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_') || 'unknown';
  return join(rootDir, 'data', 'operator-mutations', 'no-merge-holds', `${safeRepo}-pr-${prNumber}-${safeTs}.json`);
}

async function applyNoMergeHold({
  rootDir = ROOT,
  repo,
  prNumber,
  resume = false,
  reason = resume ? 'Operator released no-merge hold.' : 'Operator applied no-merge hold.',
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  execFileImpl = execFileAsync,
} = {}) {
  if (!resume) {
    await ensureNoMergeHoldLabel({ repo, execFileImpl });
  }
  await execFileImpl('gh', [
    'pr',
    'edit',
    String(prNumber),
    '--repo',
    repo,
    resume ? '--remove-label' : '--add-label',
    NO_MERGE_HOLD_LABEL,
  ]);
  const receipt = {
    kind: 'adversarial-review-no-merge-hold',
    schemaVersion: 1,
    requestedAt,
    requestedBy,
    reason,
    repo,
    prNumber,
    held: !resume,
    label: NO_MERGE_HOLD_LABEL,
  };
  const receiptPath = holdReceiptPath(rootDir, { repo, prNumber, requestedAt });
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    held: !resume,
    label: NO_MERGE_HOLD_LABEL,
    receipt,
    receiptPath,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await applyNoMergeHold({
      rootDir: ROOT,
      ...args,
    });
    console.log(
      `[no-merge-hold] held=${result.held} repo=${args.repo} pr=${args.prNumber} ` +
      `label=${result.label} receipt=${result.receiptPath}`
    );
  } catch (err) {
    console.error(`[no-merge-hold] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  applyNoMergeHold,
  ensureNoMergeHoldLabel,
  parseArgs,
};
