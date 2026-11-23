#!/usr/bin/env node
// MRQ-21: the queue-v2 close step. Run only by bin/hammer-close-controller.sh
// after publish and the exact-head audit, never by the closer directly.
// Exit 0: the handoff is durably admitted and the launch's terminal audit is
// recorded. Exit 20: a world fact ended this head (moved, merged or closed).
// Exit 75: admission is unconfirmed; the watcher re-drives the same head.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAmaAuditAttempt } from '../src/ama/audit.mjs';
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';
import { HAMMER_QUEUE_HANDOFF_ADMITTED, HAMMER_QUEUE_HANDOFF_UNADMITTED, runHammerQueueHandoffStep }
  from '../src/finalization/hammer-queue-handoff.mjs';

const env = process.env;
const binDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(binDir, '..');
const node = env.HAM_NODE_BIN || process.execPath;
const WORLD = new Set(['head-changed', 'already-merged', 'pr-closed']);

function readPr() {
  const result = spawnSync(node, [join(binDir, 'hammer-pr-read.mjs'), env.HAM_REPO, env.HAM_PR_NUMBER,
    '--json', 'headRefOid,baseRefName,state'], { env, encoding: 'utf8', timeout: loadAwareTimeoutMs(60_000),
    killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`hammer-pr-read exited ${result.status ?? result.signal}`);
  return JSON.parse(result.stdout);
}

function writeResult(value) {
  if (!env.HAM_RUN_DIR) return;
  try { writeFileSync(join(env.HAM_RUN_DIR, 'queue-handoff.json'), `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
  catch { /* The controller falls back to the registered default outcome. */ }
}

try {
  const result = await runHammerQueueHandoffStep({ env, rootDir, readPr,
    timeoutMs: loadAwareTimeoutMs(60_000, { maxMs: 300_000 }),
    appendAdmittedAudit: ({ head, attempt }) => appendAmaAuditAttempt({
      hqRoot: env.HAM_HQ_ROOT || env.HQ_ROOT, repo: env.HAM_REPO, prNumber: Number(env.HAM_PR_NUMBER), headSha: head,
      attempt: { ...attempt, deliveryKey: `queue-handoff:${attempt.queueHandoff.entryId}:${attempt.launchRequestId}` },
      metadata: { closureAuthority: 'ham-terminal-remediation' },
    }) });
  writeResult({ outcome: HAMMER_QUEUE_HANDOFF_ADMITTED, entryId: result.entryId, ackId: result.ackId, head: result.head });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write('HAM queue handoff admitted: the queue executor owns CI, the merge predicate and the merge for this head. End the run.\n');
} catch (error) {
  const outcome = typeof error?.code === 'string' && /^[a-z][a-z0-9-]*$/.test(error.code) ? error.code : HAMMER_QUEUE_HANDOFF_UNADMITTED;
  writeResult({ outcome, detail: String(error?.message || '').slice(0, 500) });
  try { recordHammerEarlyFailure(outcome, { env, headSha: env.POST_REMEDIATION_SHA }); }
  catch { process.stderr.write('HAM terminal failure audit unavailable\n'); }
  process.stderr.write(`HAM queue handoff: ${String(error?.message || outcome).slice(0, 500)}\n`);
  if (WORLD.has(outcome)) {
    process.stderr.write(`HAM next: stop with ${outcome}; a moved or finished head starts a fresh review lifecycle. Do not re-hammer it.\n`);
    process.exitCode = 20;
  } else {
    process.stderr.write(`HAM next: stop with retryable ${outcome}; the watcher re-drives this head under a fresh lease. Never merge from this run.\n`);
    process.exitCode = 75;
  }
}
