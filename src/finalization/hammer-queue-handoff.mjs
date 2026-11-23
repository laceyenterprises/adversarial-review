// MRQ-21: on a queue-v2 lane the hammer ends at its attested head. After
// publish and the exact-head audit, the close controller hands that head to the
// queue executor through the installed handoff surface and exits. The executor
// re-validates live state and merges under its own lane ownership and retries.
//
// This module never merges, waits for CI, rebases or evaluates the merge
// predicate. It builds a head-bound request, delivers it, and independently
// confirms the durable receipt and queue entry before reporting admission.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffDigest } from './queue-handoff.mjs';
import { resolveLaneKey } from './ledger-events.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';
import { confirmQueueAdmission, readCompletedQueueHandoff } from './queue-closer.mjs';
import { openFinalizationQueueStore } from './queue-store.mjs';
import { parseHammerQueueHandoffCommand } from './hammer-queue-command.mjs';

export { hammerQueueInputs, parseHammerQueueHandoffCommand } from './hammer-queue-command.mjs';

export const HAMMER_QUEUE_EXECUTOR = 'queue-v2';
export const HAMMER_QUEUE_HANDOFF_ADMITTED = 'queue-handoff-admitted';
export const HAMMER_QUEUE_HANDOFF_UNADMITTED = 'queue-handoff-unadmitted';
// One admission per (lane, PR, head). A moved head is a new head, so it needs a
// new review and a new handoff; it can never reuse this one.
export const HAMMER_QUEUE_ADMISSION_GENERATION = 1;
export const HAMMER_QUEUE_ATTEMPT_PHASE = 'hammer-queue-handoff';

const SHA = /^[a-f0-9]{40}$/i;
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const sameSha = (a, b) => SHA.test(a || '') && SHA.test(b || '') && a.toLowerCase() === b.toLowerCase();

export class HammerQueueHandoffError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
const refuse = (code, detail) => { throw new HammerQueueHandoffError(code, detail); };

/** The review evidence this handoff relies on: the reviewed head and the
 * terminal-remediation audit the hammer published for the exact head. A
 * trusted evidence adapter recomputes the same digest from the live audit
 * comment; the handoff validator requires the two to match. */
export function hammerReviewProof({ lane, prNumber, head, reviewedSha, auditHead, auditBody }) {
  lane = resolveLaneKey(lane);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !SHA.test(head || '') || !SHA.test(reviewedSha || '')) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'review-proof identity invalid');
  }
  if (!sameSha(auditHead, head)) refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'audit not published for the exact head');
  if (!text(auditBody) || !auditBody.split(/\r?\n/).some(line => line.trim().toLowerCase() === `ham-validated-head: ${head.toLowerCase()}`)) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'audit body does not name the exact head');
  }
  const bound = { schemaVersion: 1, lane, prNumber, head: head.toLowerCase(),
    reviewedSha: reviewedSha.toLowerCase(), auditBodySha256: sha256(auditBody) };
  return { ...bound, digest: handoffDigest(bound) };
}

export function hammerQueueHandoffId({ lane, prNumber, head }) {
  return `hammer-${handoffDigest([resolveLaneKey(lane), prNumber, String(head).toLowerCase(),
    HAMMER_QUEUE_ADMISSION_GENERATION]).slice(0, 40)}`;
}

export function buildHammerQueueHandoffRequest({ lane, prNumber, head, routeGeneration, deadline, closer, reviewProof }) {
  lane = resolveLaneKey(lane);
  if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 0) refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'route generation invalid');
  if (!Number.isFinite(Date.parse(deadline))) refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'deadline invalid');
  if (!closer || !['workerId', 'workerClass', 'launchRequestId'].every(key => text(closer[key]))) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'closer identity unavailable');
  }
  if (!reviewProof || !sameSha(reviewProof.head, head) || reviewProof.prNumber !== prNumber
    || handoffDigest(Object.fromEntries(Object.entries(reviewProof).filter(([key]) => key !== 'digest'))) !== reviewProof.digest) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'review proof is not bound to this head');
  }
  return { schemaVersion: 1, kind: 'hammer-queue-handoff-request', lane, prNumber, head: head.toLowerCase(),
    admissionGeneration: HAMMER_QUEUE_ADMISSION_GENERATION, handoffId: hammerQueueHandoffId({ lane, prNumber, head }),
    routeGeneration, deadline: new Date(deadline).toISOString(),
    closer: { workerId: closer.workerId, workerClass: closer.workerClass, launchRequestId: closer.launchRequestId },
    reviewProof };
}

function lastJsonLine(stdout) {
  const output = String(stdout || '').trim();
  try {
    const value = JSON.parse(output);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* permit diagnostic lines before the acknowledgement */ }
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      if (!lines[i].startsWith('{')) continue;
      const value = JSON.parse(lines.slice(i).join('\n'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* keep looking */ }
  }
  return null;
}

export function runHammerQueueHandoffCommand({ command, requestPath, timeoutMs, env = process.env }) {
  return new Promise((resolve, reject) => {
    execFile(command[0], [...command.slice(1), requestPath], { env, timeout: timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new HammerQueueHandoffError(HAMMER_QUEUE_HANDOFF_UNADMITTED,
        error.killed ? 'handoff command timed out' : `handoff command exited ${error.code ?? error.signal ?? 'abnormally'}`));
      else resolve(lastJsonLine(stdout));
    });
  });
}

/** A reply is never admission evidence by itself. Join it to the actual
 * durable receipt and entry, and require the receipt to carry this request's
 * head, closer launch and review-proof digest. */
export function confirmHammerQueueHandoff({ rootDir, request, ack }) {
  ack = ack?.ack ?? ack;
  const { lane, prNumber, head } = request;
  if (!ack?.entryId || !ack?.ackId || !sameSha(ack.head, head) || ack.prNumber !== prNumber
    || ack.lane?.repository !== lane.repository || ack.lane?.base !== lane.base) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'acknowledgement foreign or missing');
  }
  const store = openFinalizationQueueStore({ rootDir });
  let receipt;
  try {
    receipt = resolveQueueHandoffStore(store).read({ lane, prNumber, head: ack.head, admissionGeneration: ack.admissionGeneration });
  } catch (error) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, `durable receipt unreadable (${error.message})`);
  } finally { store.close(); }
  if (!receipt || receipt.ack.ackId !== ack.ackId || receipt.ack.entryId !== ack.entryId) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'durable receipt unavailable');
  }
  const h = receipt.handoff;
  if (!sameSha(h.head, head) || h.reviewProof?.digest !== request.reviewProof.digest
    || h.closer?.launchRequestId !== request.closer.launchRequestId) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'durable receipt is not bound to this head, launch and review proof');
  }
  try { confirmQueueAdmission({ rootDir, lane, prNumber, head: ack.head, acknowledgement: receipt.ack }); }
  catch (error) { refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, error.message); }
  return { ok: true, outcome: HAMMER_QUEUE_HANDOFF_ADMITTED, lane, prNumber, head,
    entryId: receipt.ack.entryId, ackId: receipt.ack.ackId, handoffId: receipt.ack.handoffId,
    reviewProofDigest: request.reviewProof.digest };
}

function existingAdmission(rootDir, request) {
  const store = openFinalizationQueueStore({ rootDir });
  try {
    const ack = readCompletedQueueHandoff(store, request);
    if (!ack) return null;
    const receipt = resolveQueueHandoffStore(store).read({ lane: request.lane, prNumber: request.prNumber,
      head: ack.head, admissionGeneration: ack.admissionGeneration });
    return { ack, reviewProofDigest: receipt?.handoff?.reviewProof?.digest ?? null };
  } finally { store.close(); }
}

/** Deliver one request and confirm it. A lost reply or a retried launch
 * replays: an existing durable admission for this head is reported without a
 * second delivery, under its own recorded review proof. */
export async function admitHammerQueueHandoff({ rootDir, request, command, runDir, timeoutMs,
  run = runHammerQueueHandoffCommand, env }) {
  const prior = existingAdmission(rootDir, request);
  if (prior) {
    return { ok: true, outcome: HAMMER_QUEUE_HANDOFF_ADMITTED, replay: true, lane: request.lane,
      prNumber: request.prNumber, head: request.head, entryId: prior.ack.entryId, ackId: prior.ack.ackId,
      handoffId: prior.ack.handoffId, reviewProofDigest: prior.reviewProofDigest };
  }
  if (!command) refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'queue handoff command unavailable');
  const requestPath = join(runDir, 'queue-handoff-request.json');
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  const reply = await run({ command, requestPath, timeoutMs, env });
  if (reply?.ok === false && /^[a-z-]{1,80}$/.test(reply.reason ?? '')) refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, reply.reason);
  return confirmHammerQueueHandoff({ rootDir, request, ack: reply });
}

/** The close controller's queue-v2 step. Inputs are the run's rendered
 * inputs.sh environment plus the publish phase's exports. Every collaborator
 * that reads GitHub, spawns or writes the audit is injected. */
export async function runHammerQueueHandoffStep({ env, rootDir, readPr, admit = admitHammerQueueHandoff,
  appendAdmittedAudit, now = () => new Date(), timeoutMs }) {
  const repo = env.HAM_REPO, prNumber = Number(env.HAM_PR_NUMBER), head = env.POST_REMEDIATION_SHA;
  if (!text(repo) || !Number.isSafeInteger(prNumber) || prNumber <= 0 || !SHA.test(head || '')) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'run identity unavailable');
  }
  let live;
  try { live = await readPr(); } catch (error) { refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, `live PR read failed (${error.message})`); }
  const state = String(live?.state || '').toUpperCase();
  if (state === 'MERGED') refuse('already-merged');
  if (state === 'CLOSED') refuse('pr-closed');
  const liveHead = live?.headSha || live?.headRefOid;
  if (state !== 'OPEN' || !SHA.test(liveHead || '') || !text(live?.baseRefName)) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'live PR state unavailable');
  }
  // The attested head is the only head this run may hand off. A moved head
  // starts a fresh review lifecycle; it is never re-hammered from here.
  if (!sameSha(liveHead, head)) refuse('head-changed');
  const lane = resolveLaneKey({ repository: repo, base: live.baseRefName });
  const routeGeneration = Number(env.HAM_QUEUE_ROUTE_GENERATION);
  const reviewProof = hammerReviewProof({ lane, prNumber, head, reviewedSha: env.HAM_REVIEWED_SHA,
    auditHead: env.HAM_PUBLISHED_AUDIT_HEAD, auditBody: env.HAM_AUDIT_COMMENT_BODY });
  const started = now();
  const request = buildHammerQueueHandoffRequest({ lane, prNumber, head, routeGeneration,
    deadline: new Date(started.getTime() + timeoutMs).toISOString(),
    closer: { workerId: env.HAM_QUEUE_CLOSER_WORKER_ID, workerClass: env.HAM_QUEUE_CLOSER_WORKER_CLASS,
      launchRequestId: env.HQ_LAUNCH_REQUEST_ID }, reviewProof });
  const command = parseHammerQueueHandoffCommand(env.HAM_QUEUE_HANDOFF_COMMAND);
  const result = await admit({ rootDir, request, command, runDir: env.HAM_RUN_DIR, timeoutMs, env });
  if (result?.ok !== true || result.outcome !== HAMMER_QUEUE_HANDOFF_ADMITTED) {
    refuse(HAMMER_QUEUE_HANDOFF_UNADMITTED, 'admission unconfirmed');
  }
  // Admission is the launch's required outcome on this lane: the attempt is
  // superseded by the queue executor, which now owns CI, predicate and merge.
  await appendAdmittedAudit({ head, attempt: { outcome: 'superseded', reason: HAMMER_QUEUE_HANDOFF_ADMITTED,
    attemptPhase: HAMMER_QUEUE_ATTEMPT_PHASE, launchRequestId: request.closer.launchRequestId,
    validatedHead: head, reviewedHead: env.HAM_REVIEWED_SHA,
    queueHandoff: { executor: HAMMER_QUEUE_EXECUTOR, lane, prNumber, head, entryId: result.entryId,
      ackId: result.ackId, handoffId: result.handoffId, routeGeneration,
      reviewProofDigest: result.reviewProofDigest, replay: result.replay === true } } });
  return result;
}
