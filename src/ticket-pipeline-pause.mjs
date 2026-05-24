import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import {
  resolveTicketPipelinePauseRoot,
  TICKET_PIPELINE_PAUSE_ROOT_ENV,
  TICKET_PIPELINE_PAUSED_LABEL,
  repoPausePath,
} from './adapters/operator/linear-triage/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const execFileAsync = promisify(execFile);
const VALID_SCOPES = new Set(['pr', 'repo', 'both']);
const CONFIRM_LIVE_ROOT_FLAG = '--confirm-live-root';

function parseArgs(argv) {
  const args = [...argv];
  let repo = null;
  let prNumber = null;
  let scope = null;
  let resume = false;
  let rootDir = ROOT;
  let confirmLiveRoot = false;
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
    if (arg === '--scope') {
      scope = String(args[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg?.startsWith('--scope=')) {
      scope = String(arg.slice('--scope='.length)).trim().toLowerCase();
      continue;
    }
    if (arg === '--resume' || arg === '--unpause') {
      resume = true;
      continue;
    }
    if (arg === '--root') {
      rootDir = args[index + 1] || rootDir;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--root=')) {
      rootDir = arg.slice('--root='.length) || rootDir;
      continue;
    }
    if (arg === CONFIRM_LIVE_ROOT_FLAG) {
      confirmLiveRoot = true;
      continue;
    }
    reasonParts.push(arg);
  }

  if (!repo) {
    throw new Error('Usage: node src/ticket-pipeline-pause.mjs --repo <owner/repo> [--pr <number>] [--scope pr|repo|both] [--resume] [reason]');
  }
  if (!scope) {
    scope = Number.isInteger(prNumber) && prNumber > 0 ? 'pr' : 'repo';
  }
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`Unsupported scope ${JSON.stringify(scope)}. Supported: ${[...VALID_SCOPES].join(', ')}`);
  }
  if ((scope === 'pr' || scope === 'both') && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    throw new Error('--pr <number> is required for pr or both scope.');
  }

  return {
    repo,
    prNumber,
    scope,
    resume,
    rootDir,
    confirmLiveRoot,
    reason: reasonParts.join(' ').trim() || (resume ? 'Operator resumed ticket pipeline.' : 'Operator paused ticket pipeline.'),
  };
}

function ensureRepoPauseRootConfirmed({
  rootDir = ROOT,
  scope,
  confirmLiveRoot = false,
  env = process.env,
} = {}) {
  const resolvedRoot = resolveTicketPipelinePauseRoot(rootDir, env);
  if ((scope === 'repo' || scope === 'both') && !confirmLiveRoot) {
    throw new Error(
      `Repo-scope pause will write under ${resolvedRoot}. Re-run with ${CONFIRM_LIVE_ROOT_FLAG} ` +
      `once this matches the live daemon root; use --root, ${TICKET_PIPELINE_PAUSE_ROOT_ENV}, or HQ_ROOT if needed.`
    );
  }
  return resolvedRoot;
}

async function ensureTicketPipelinePauseLabel({ repo, execFileImpl = execFileAsync } = {}) {
  await execFileImpl('gh', [
    'label',
    'create',
    TICKET_PIPELINE_PAUSED_LABEL,
    '--repo',
    repo,
    '--description',
    'Pause adversarial-review Linear ticket pipeline sync for this PR',
    '--color',
    'f9d0c4',
    '--force',
  ]);
}

async function setPRTicketPipelinePause({
  repo,
  prNumber,
  paused,
  execFileImpl = execFileAsync,
} = {}) {
  if (paused) {
    await ensureTicketPipelinePauseLabel({ repo, execFileImpl });
  }
  await execFileImpl('gh', [
    'pr',
    'edit',
    String(prNumber),
    '--repo',
    repo,
    paused ? '--add-label' : '--remove-label',
    TICKET_PIPELINE_PAUSED_LABEL,
  ]);
}

function setRepoTicketPipelinePause({
  rootDir = ROOT,
  repo,
  paused,
  reason,
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  env = process.env,
} = {}) {
  const pauseRootDir = resolveTicketPipelinePauseRoot(rootDir, env);
  const filePath = repoPausePath(pauseRootDir, repo);
  if (!paused) {
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
    return { paused: false, filePath, pauseRootDir };
  }
  const record = {
    kind: 'adversarial-review-ticket-pipeline-repo-pause',
    schemaVersion: 1,
    paused: true,
    repo,
    requestedAt,
    requestedBy,
    reason,
  };
  writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return { paused: true, filePath, pauseRootDir, record };
}

async function applyTicketPipelinePause({
  rootDir = ROOT,
  repo,
  prNumber = null,
  scope = Number.isInteger(prNumber) && prNumber > 0 ? 'pr' : 'repo',
  resume = false,
  reason = resume ? 'Operator resumed ticket pipeline.' : 'Operator paused ticket pipeline.',
  requestedAt = new Date().toISOString(),
  requestedBy = process.env.USER || process.env.LOGNAME || 'operator',
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const paused = !resume;
  const result = {
    repo,
    prNumber,
    scope,
    paused,
    label: TICKET_PIPELINE_PAUSED_LABEL,
    prLabelUpdated: false,
    repoPauseUpdated: false,
    repoPausePath: null,
  };
  if (scope === 'pr' || scope === 'both') {
    await setPRTicketPipelinePause({
      repo,
      prNumber,
      paused,
      execFileImpl,
    });
    result.prLabelUpdated = true;
  }
  if (scope === 'repo' || scope === 'both') {
    const repoPause = setRepoTicketPipelinePause({
      rootDir,
      repo,
      paused,
      reason,
      requestedAt,
      requestedBy,
      env,
    });
    result.repoPauseUpdated = true;
    result.repoPausePath = repoPause.filePath;
    result.repoPauseRootDir = repoPause.pauseRootDir;
  }
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    ensureRepoPauseRootConfirmed({
      rootDir: args.rootDir,
      scope: args.scope,
      confirmLiveRoot: args.confirmLiveRoot,
    });
    const result = await applyTicketPipelinePause({
      rootDir: args.rootDir,
      ...args,
    });
    console.log(
      `[ticket-pipeline-pause] paused=${result.paused} scope=${result.scope} repo=${result.repo}` +
      (result.prNumber ? ` pr=${result.prNumber}` : '') +
      (result.repoPausePath ? ` repoPause=${result.repoPausePath}` : '') +
      (result.repoPauseRootDir ? ` repoPauseRoot=${result.repoPauseRootDir}` : '') +
      ` label=${result.label}`
    );
  } catch (err) {
    console.error(`[ticket-pipeline-pause] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  applyTicketPipelinePause,
  ensureRepoPauseRootConfirmed,
  ensureTicketPipelinePauseLabel,
  parseArgs,
  setPRTicketPipelinePause,
  setRepoTicketPipelinePause,
};
