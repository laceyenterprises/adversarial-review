import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { buildLegacyHqRemediationDispatchArgs } from './remediation-dispatch-mode.mjs';
import { normalizeTag } from './adapters/subject/github-pr/title-tagging.mjs';
import { parseDispatchJsonOutput, readDispatchReceipt } from './producer-contracts/dispatch-receipt.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { alertClioOversizedAgyFailure } from './reviewer-alerts.mjs';
import { parseDiffEntries } from './reviewer-util.mjs';

const execute = promisify(execFile);
const FACTS_PREFIX = '[reviewer-size-facts] ';

// Sizes are UTF-8 bytes contributed by each file to the complete diff,
// including headers. Do not fetch blobs or retain generated file contents.
export function reviewerSizeFacts({ diff, promptBytes, maxBytes, maxChunks, headSha, chunkPlan = null }) {
  const files = parseDiffEntries(diff).map(entry => ({ path: entry.path || '<unparsed>',
    diffBytes: Buffer.byteLength(entry.patch) }));
  return { headSha, diffBytes: Buffer.byteLength(diff), promptBytes, maxBytes, maxChunks,
    chunkPlan, largestFiles: files.sort((a, b) => b.diffBytes - a.diffBytes).slice(0, 10) };
}

export function reviewerSizeFactsLine(facts) {
  return `${FACTS_PREFIX}${JSON.stringify(facts)}`;
}

function readSizeFacts(result, headSha) {
  for (const line of String(result.stderr || '').split('\n').reverse()) {
    if (!line.startsWith(FACTS_PREFIX)) continue;
    try {
      const facts = JSON.parse(line.slice(FACTS_PREFIX.length));
      if (facts.headSha === headSha) return facts;
    } catch { /* A malformed diagnostic cannot establish size evidence. */ }
  }
  return { headSha, diffBytes: null, promptBytes: null, maxBytes: null, maxChunks: null,
    largestFiles: [], chunkPlan: null };
}

export async function dispatchReviewerSizeUpdate({ repo, prNumber, workerClass, promptPath, dispatchKey,
  env = process.env, execFileImpl = execute }) {
  if (process.env.NODE_TEST_CONTEXT && execFileImpl === execute) {
    throw new Error('offline tests must inject size update transport');
  }
  const args = buildLegacyHqRemediationDispatchArgs({ ticketRef: `SHRINK-DIFF-PR-${prNumber}`,
    workerClass, repo, prNumber, promptPath, hqRoot: resolveHqRoot(env),
    project: 'adversarial-merge-authority',
    parentSession: env.HQ_PARENT_SESSION || 'session:unknown:reviewer-size',
  });
  args.push('--idempotency-key', dispatchKey, '--fleet-retry-policy', 'origin-owned');
  const response = await execFileImpl(env.HQ_BIN || 'hq', args,
    { env, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  const receipt = readDispatchReceipt(parseDispatchJsonOutput(response.stdout));
  if (!receipt.launchRequestId) throw new Error(receipt.identityDiagnostic);
  return { dispatched: true, launchRequestId: receipt.launchRequestId };
}

// Reserve before submission. Lost acknowledgements retain ownership: they must
// never cause another worker to be launched for the same deterministic failure.
export async function ownReviewerSizeFailure({ rootDir, repo, prNumber, headSha, builderTag,
  result, failureClass, failureAt, env = process.env, logger = console,
  dispatchImpl = dispatchReviewerSizeUpdate, alertImpl = alertClioOversizedAgyFailure }) {
  if (!headSha) return { posted: false, reason: 'size-failure-missing-head' };
  const key = createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex');
  const recordPath = join(rootDir, 'data', 'review-size-actions', `${key}.json`);
  const promptPath = join(rootDir, 'data', 'review-size-actions', `${key}.md`);
  const facts = readSizeFacts(result, headSha);
  const workerClass = normalizeTag(builderTag);
  const nextAction = { action: 'shrink-diff', actor: workerClass, head: headSha, facts };
  const record = { repo, prNumber, headSha, failureClass, createdAt: failureAt, nextAction,
    dispatch: { dispatchKey: `shrink-diff-${key}`, dispatched: false, reservedAt: failureAt } };
  const alert = () => alertImpl({ repo, prNumber, headSha, promptBytes: facts.promptBytes, maxBytes: facts.maxBytes,
    reason: result.error || failureClass, failureClass, nextAction, dispatch: record.dispatch });
  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`, { overwrite: false });
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        const retained = JSON.parse(readFileSync(recordPath, 'utf8'));
        return { posted: false, nextAction: retained.nextAction, dispatch: retained.dispatch };
      } catch (readError) {
        // EEXIST can also name an invalid parent directory; unreadable or
        // corrupt reservation evidence must never permit another submission.
        error = readError;
      }
    }
    // Never submit without a durable reservation, but preserve the size alert.
    record.dispatch.error = `size action reservation failed: ${error.message}`;
    logger.warn?.(`[watcher] ${record.dispatch.error}`);
    await alert();
    return { posted: false, nextAction, dispatch: record.dispatch };
  }
  try {
    if (!workerClass) throw new Error('size update requires a recognized builder title prefix');
    const brief = [
      `Shrink the diff for ${repo} PR ${prNumber}. Expected head: ${headSha}.`,
      'This head is too large to review. Shrink the diff below the prompt budget without changing behaviour.',
      'Move generated data out of the diff, for example by compressing it, or split the pull request.',
      'Push normally to this pull request; do not force-push. Do not merge or relax review budgets or chunk caps.',
      'Before editing and before pushing, verify the PR is open and still at the expected head; stop if it moved.',
      'Size facts (bytes; largest files measured by their diff contribution):', JSON.stringify(facts, null, 2),
    ].join('\n');
    writeFileAtomic(promptPath, `${brief}\n`);
    record.dispatch = { ...record.dispatch, ...await dispatchImpl({ repo, prNumber, headSha,
      workerClass, promptPath, dispatchKey: record.dispatch.dispatchKey, env }), promptPath };
  } catch (error) {
    record.dispatch.error = error.message;
    logger.warn?.(`[watcher] shrink-diff dispatch unconfirmed for ${repo} PR ${prNumber}: ${error.message}`);
  }
  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    record.dispatch.persistenceError = error.message;
    logger.warn?.(`[watcher] shrink-diff receipt persistence failed: ${error.message}`);
  }
  await alert();
  return { posted: false, nextAction, dispatch: record.dispatch };
}
