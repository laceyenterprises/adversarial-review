// ── NXA-02 observational shadow of the shared next action ────────────────────
//
// Each current consumer keeps its legacy decision and effects. After deciding,
// it hands this module (through src/pr-next-action-consumer.mjs, which copies
// the evidence synchronously and loads this module lazily) that decision plus
// evidence it already holds. The
// shadow computes `nextAction` once per pass snapshot, compares action, actor
// and reason, and appends every disagreement (generation, source, deadline,
// evidence references) to a bounded local JSONL log for the rollout owner
// (bin/next-action-disagreements.mjs classifies it read-only).
//
// Shadow never changes effects: the call copies its evidence synchronously,
// returns at once, never throws, and its promise never rejects. Sink, alert and
// evidence failures are swallowed. It prints nothing: CLI stdout stays the
// caller's, and the JSONL log is the only record. Under the offline test runner it is inert
// unless a test installs a sink. Overdue decisions reach the existing
// closure-wait alert path (debounce, refund, retry) only when the rollout owner
// sets AMA_NEXT_ACTION_OVERDUE_ALERTS=1; a deadline never gates execution.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
import { fromLegacyClosureOwner, markNextActionShadowTestSink, NEXT_ACTION_SHADOW_LAUNCH_READ_MS } from './pr-next-action-consumer.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { checkPrimaryChange } from './ama/primary-change.mjs';

export const NEXT_ACTION_SHADOW_SCHEMA = 'nxa-shadow/v1';
export const NEXT_ACTION_SHADOW_MAX_BYTES = 16 * 1024 * 1024;
export const NEXT_ACTION_OVERDUE_ALERTS_ENV = 'AMA_NEXT_ACTION_OVERDUE_ALERTS';
const COMPARED_FIELDS = Object.freeze(['action', 'actor', 'reason']);
const REPORTED_LIMIT = 2048;
const NOTE_LIMIT = 512;

// One decision promise per pass snapshot, shared by every consumer of that
// pass. Closure orchestration registers its enriched derivation; later
// consumers of the same pass (posted-review, hammer-owner route) reuse it.
const decisionsByPass = new WeakMap();
const reportedOverdue = new Set();
// Consumers without a pass (the no-progress lane) leave a legacy note that the
// next pass decision for the same subject/head compares and drains.
const legacyNotes = new Map();
let testSink = null;

export function nextActionShadowLogPath(rootDir) {
  return join(rootDir, 'data', 'next-action-shadow', 'disagreements.jsonl');
}

export function setNextActionShadowSinkForTesting(sink) {
  testSink = sink || null;
  markNextActionShadowTestSink(testSink !== null);
  reportedOverdue.clear();
  legacyNotes.clear();
}

function remember(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  while (set.size > REPORTED_LIMIT) set.delete(set.values().next().value);
  return true;
}

async function appendBounded(rootDir, record) {
  const dir = join(rootDir, 'data', 'next-action-shadow');
  const file = nextActionShadowLogPath(rootDir);
  await mkdir(dir, { recursive: true });
  const size = await stat(file).then(info => info.size, () => 0);
  // One rotation keeps the log under twice the limit.
  if (size >= NEXT_ACTION_SHADOW_MAX_BYTES) await rename(file, `${file}.1`);
  await appendFile(file, `${JSON.stringify(record)}\n`);
}

const inertUnderTest = (sink, env) => !sink && !testSink && Boolean(env?.NODE_TEST_CONTEXT);

async function deliverOverdue(text, options) {
  const { deliverAlert } = await import('./alert-delivery.mjs');
  return deliverAlert(text, { payload: { source: 'nxa-next-action-overdue', dedupKey: options?.dedupKey ?? null } });
}

export function caseKeyOf(record) {
  return createHash('sha256').update(JSON.stringify([record.subjectKey, record.head,
    record.legacy?.action, record.legacy?.actor, record.legacy?.reason,
    record.next?.action, record.next?.actor, record.next?.reason])).digest('hex').slice(0, 24);
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'unknown', value: null, provenance: { sourceRef: 'launch-requests', timedOut: true } }), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

// Raw primary-change evidence goes through the shared pure helper.
function primaryChangeObservation(input, progress) {
  if (!input) return null;
  let result;
  try {
    result = checkPrimaryChange(input.evidence, input.head, { strictNonBlockingRemediation: input.strictNonBlockingRemediation });
  } catch { result = { ok: false, reason: 'primary-change-unknown' }; }
  return { ...(progress || {}), primaryChange: { ok: result?.ok === true, reason: result?.reason ?? null } };
}

function resolveShared({ snapshot, passSnapshot, evidence }) {
  if (snapshot) return Promise.resolve({ snapshot, decision: nextAction(snapshot) });
  if (evidence) {
    // Copy synchronously: legacy objects may change after the caller resumes.
    const { readLaunches, primaryChangeInput, ...fields } = evidence;
    const progress = primaryChangeObservation(primaryChangeInput, fields.observations?.progress);
    const derived = deriveNextActionSnapshot({ base: passSnapshot, ...fields,
      ...(progress ? { observations: { ...fields.observations, progress } } : {}) });
    const shared = (async () => {
      let final = derived;
      if (readLaunches) {
        const launches = await bounded(Promise.resolve().then(readLaunches), NEXT_ACTION_SHADOW_LAUNCH_READ_MS)
          .catch(() => ({ state: 'error', value: null, provenance: { sourceRef: 'launch-requests' } }));
        final = deriveNextActionSnapshot({ base: derived, observations: { launches } });
      }
      return { snapshot: final, decision: nextAction(final) };
    })();
    if (passSnapshot) decisionsByPass.set(passSnapshot, shared);
    return shared;
  }
  if (!passSnapshot) return null;
  let shared = decisionsByPass.get(passSnapshot);
  if (!shared) {
    shared = Promise.resolve({ snapshot: passSnapshot, decision: nextAction(passSnapshot) });
    decisionsByPass.set(passSnapshot, shared);
  }
  return shared;
}

function adaptLegacy(input) {
  const legacy = typeof input === 'function' ? input() : input;
  if (legacy == null) return null;
  return typeof legacy.action === 'string' ? legacy : fromLegacyClosureOwner(legacy);
}

function compare(source, adapted, shared, observedMs) {
  const { decision } = shared;
  const fields = adapted ? COMPARED_FIELDS.filter(field => adapted[field] !== decision[field]) : [];
  if (!fields.length) return null;
  const record = {
    schema: NEXT_ACTION_SHADOW_SCHEMA, kind: 'disagreement', observedAt: new Date(observedMs).toISOString(),
    source: String(source || 'unknown'), subjectKey: shared.snapshot?.subjectKey ?? null,
    passId: shared.snapshot?.passId ?? null, generation: shared.snapshot?.generation ?? null, head: decision.head, fields,
    legacy: { action: adapted.action, actor: adapted.actor, reason: adapted.reason,
      legacyOwner: adapted.legacyOwner ?? null, legacyReason: adapted.legacyReason ?? null },
    next: nextFields(decision), evidenceRefs: decision.evidenceRefs,
  };
  record.caseKey = caseKeyOf(record);
  return record;
}

const nextFields = decision => ({ action: decision.action, actor: decision.actor, reason: decision.reason,
  row: decision.row, round: decision.round ?? null, attempt: decision.attempt, deadline: decision.deadline,
  decisionKey: decision.decisionKey, queue: decision.queue });

/**
 * Leave a legacy decision from a consumer that has no pass snapshot. The next
 * shadow call for the same subject/head compares it against the shared decision.
 */
export function noteNextActionLegacy({ source, subjectKey, head, legacy, env = process.env } = {}) {
  try {
    if (inertUnderTest(null, env) || !subjectKey || !head) return;
    const adapted = adaptLegacy(legacy);
    if (!adapted) return;
    const key = `${subjectKey}@${head}`;
    const notes = (legacyNotes.get(key) || []).filter(note => note.source !== source);
    legacyNotes.delete(key);
    legacyNotes.set(key, [...notes, { source: String(source), adapted }]);
    while (legacyNotes.size > NOTE_LIMIT) legacyNotes.delete(legacyNotes.keys().next().value);
  } catch { /* observation only */ }
}

/**
 * Compare one consumer's legacy decision with the shared next action.
 * `legacy` is a legacy closure owner ({owner, reason}), an already adapted
 * ({action, actor, reason}) decision, or a thunk returning either (evaluated
 * inside the shadow's guard); null records only overdue observation. Returns a
 * promise for tests; callers must not await it for control flow.
 */
export function shadowNextAction({ source, legacy = null, snapshot = null, passSnapshot = null, evidence = null,
  repo = null, prNumber = null, rootDir = null, now = Date.now, env = process.env,
  sink = null, observeOverdueImpl = observeClosureWait, overduePageImpl = deliverOverdue } = {}) {
  let sharedPromise;
  let adapted;
  try {
    if (inertUnderTest(sink, env)) return Promise.resolve(null);
    adapted = adaptLegacy(legacy);
    sharedPromise = resolveShared({ snapshot, passSnapshot,
      evidence: typeof evidence === 'function' ? evidence() : evidence });
    if (!sharedPromise) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  const write = sink || testSink || (rootDir ? record => appendBounded(rootDir, record) : null);
  return (async () => {
    const shared = await sharedPromise;
    const observedMs = now();
    const { decision } = shared;
    const outcome = { decision, disagreement: null, notes: [], overdue: null, sinkError: null, alert: null };
    outcome.disagreement = compare(source, adapted, shared, observedMs);
    const noteKey = `${shared.snapshot?.subjectKey}@${decision.head}`;
    const notes = legacyNotes.get(noteKey) || [];
    legacyNotes.delete(noteKey);
    outcome.notes = notes.map(note => compare(note.source, note.adapted, shared, observedMs)).filter(Boolean);
    const dueMs = Date.parse(decision.deadline?.at || '');
    // One overdue report per decision, whichever consumer observes it first.
    const overdueKey = decision.decisionKey;
    if (Number.isFinite(dueMs) && dueMs <= observedMs && remember(reportedOverdue, overdueKey)) {
      outcome.overdue = { schema: NEXT_ACTION_SHADOW_SCHEMA, kind: 'overdue', observedAt: new Date(observedMs).toISOString(),
        source: String(source || 'unknown'), subjectKey: shared.snapshot?.subjectKey ?? null,
        passId: shared.snapshot?.passId ?? null, generation: shared.snapshot?.generation ?? null, head: decision.head,
        ageMs: observedMs - dueMs, next: nextFields(decision), evidenceRefs: decision.evidenceRefs };
    }
    for (const entry of [outcome.disagreement, ...outcome.notes, outcome.overdue]) {
      if (!entry || !write) continue;
      try { await write(entry); } catch (error) { outcome.sinkError = error; }
    }
    const overdue = outcome.overdue;
    if (overdue && env?.[NEXT_ACTION_OVERDUE_ALERTS_ENV] === '1' && rootDir && repo && prNumber != null && overdue.head) {
      const next = overdue.next;
      try {
        outcome.alert = await observeOverdueImpl({ rootDir, repo, prNumber, headSha: overdue.head,
          reason: `NXA-02 next action overdue: action=${next.action} actor=${next.actor} reason=${next.reason} ` +
            `head=${overdue.head.slice(0, 12)} age_minutes=${Math.floor(overdue.ageMs / 60_000)} decision=${next.decisionKey}`,
          waitClass: `next-action-overdue:${next.action}:${next.reason}`, immediate: true,
          pageImpl: overduePageImpl, env, now: observedMs });
      } catch (error) {
        // closure-wait refunded its reservation; the next pass retries delivery.
        reportedOverdue.delete(overdueKey);
        outcome.alert = { error };
      }
    }
    return outcome;
  })().catch(() => null);
}

