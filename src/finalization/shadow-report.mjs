// Merge Authority v2 shadow mode — the divergence report (ARC-16; SPEC §1 Win 3,
// docs/SPEC-merge-authority-v2.md §5.2–5.3). A PURE model builder + renderer over
// recorded shadow observations: it counts agreements vs divergences in a window,
// lists each open/attributed divergence with its bidirectional triage, and
// computes the operator promotion verdict. No I/O, no clock — the caller supplies
// `now` and the observations; `finalization shadow-report` (the CLI) reads the
// store and prints the model.
//
// The promotion gate is §5.3: ≥ N days of shadow with EVERY divergence
// dispositioned (only an `open` disposition blocks), including at least one
// organic head-move and one budget-exhaustion close observed. A human override on
// an observation (recorded in the store) supersedes the classifier's proposal —
// the bidirectional discipline: the classifier proposes, a human disposes.

import { buildQueueShadowMetrics } from './queue-shadow-metrics.mjs';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {import('../kernel/contracts.js').ShadowObservation} ShadowObservation
 * @typedef {import('../kernel/contracts.js').ShadowReportModel} ShadowReportModel
 */

/** The disposition in force: a human override supersedes the classifier proposal. */
export function effectiveDisposition(observation) {
  const override = observation?.dispositionOverride?.disposition;
  if (['resolved', 'open'].includes(override)) return override;
  if (!['agree', 'diverge'].includes(observation?.classification?.relation)) return 'open';
  return observation?.classification?.disposition === 'resolved' ? 'resolved' : 'open';
}

/** MLR-04: count terminal subjects, never polls, dispatches or replay samples.
 * Whole history is required: an old open divergence cannot age out of safety. */
export function buildMlrPromotionGate(observations, now) {
  const history = observations.filter(o => Date.parse(o.observedAt) <= Date.parse(now));
  const organic = history.filter(o => o.live?.source === 'organic' || o.queue?.source === 'organic');
  const outcomes = new Map();
  for (const o of organic) {
    const landed = o.v1Action?.kind === 'merged' && o.v1Action.sourceRef
      && (o.live?.terminalOutcome === 'merged' && o.live?.lane?.base
        || o.queue?.phase === 'merged');
    const closed = o.v1Action?.kind === 'close' && o.v1Action.sourceRef
      && o.live?.terminalOutcome === 'closed' && o.live?.lane?.base;
    if ((!landed && !closed) || o.foldError) continue;
    const key = JSON.stringify(o.subjectKey);
    const prior = outcomes.get(key);
    outcomes.set(key, { headMove: prior?.headMove || Boolean(landed && o.sawHeadMove),
      exhaustion: prior?.exhaustion || Boolean(landed && o.sawExhaustion) });
  }
  const finalizations = outcomes.size;
  const headMoves = [...outcomes.values()].filter(o => o.headMove).length;
  const exhaustionCloses = [...outcomes.values()].filter(o => o.exhaustion).length;
  const openDivergences = history.filter(o => o.classification?.relation !== 'agree'
    && effectiveDisposition(o) === 'open').length;
  const foldErrors = organic.filter(o => o.foldError && !(o.dispositionOverride?.disposition === 'resolved'
    && o.dispositionOverride.principal && o.dispositionOverride.note)).length;
  const blockers = [];
  if (finalizations < 50) blockers.push(`insufficient distinct finalizations (${finalizations} < 50)`);
  if (!headMoves) blockers.push('no organic terminal head-move example');
  if (!exhaustionCloses) blockers.push('no organic exhaustion close-by-landing example');
  if (openDivergences) blockers.push(`${openDivergences} undispositioned historical divergences`);
  if (foldErrors) blockers.push(`${foldErrors} unresolved fold/evidence errors`);
  return { approvedSpec: 'MLR-04', minimumFinalizations: 50, finalizations, headMoves,
    exhaustionCloses, openDivergences, foldErrors, promotable: blockers.length === 0, blockers };
}

function subjectLabel(subjectExternalId) {
  const m = /#(\d+)$/.exec(String(subjectExternalId ?? ''));
  return m ? `#${m[1]}` : String(subjectExternalId ?? '<unknown>');
}

// A compact one-line rendering of the v2 decision for the divergence list.
function compactV2(decision) {
  const kind = decision?.kind ?? 'unknown';
  const reason = decision?.reason ?? '';
  if (kind === 'finalize-now' && /clean verdict, green checks|validated full coverage/i.test(reason)) {
    return 'finalize-now (verdict@head clean)';
  }
  if (!reason) return kind;
  return `${kind}(${reason})`;
}

function dispositionTag(observation) {
  const cls = { ...observation.classification, ...(observation.dispositionOverride?.direction
    ? { direction: observation.dispositionOverride.direction } : {}) };
  const overridden = observation.dispositionOverride != null;
  const eff = effectiveDisposition(observation);
  let base;
  if (eff === 'open') {
    base = 'triage open';
  } else if (cls.direction === 'v1-defect') {
    base = `v1 defect: ${cls.ref ?? cls.class} class`;
  } else if (cls.direction === 'v2-suspect') {
    base = `v2 suspect: ${cls.class}`;
  } else if (cls.direction === 'benign') {
    base = `benign: ${cls.class}`;
  } else {
    base = `dispositioned: ${cls.class ?? 'divergence'}`;
  }
  return overridden ? `${base} (overridden)` : base;
}

/**
 * Build the shadow-report model from recorded observations.
 *
 * @param {{
 *   observations: readonly ShadowObservation[],
 *   now: string,
 *   windowDays?: number,
 *   coverage?: {
 *     earliestObservedAt?: string | null,
 *     organicHeadMoves?: number,
 *     exhaustionCloses?: number,
 *   } | null,
 * }} args
 * @returns {ShadowReportModel}
 */
export function buildShadowReport({ observations, now, windowDays = 7, coverage = null, queueHistory = null,
  promotionHistory = null }) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('buildShadowReport requires a valid `now` ISO timestamp');
  const days = Number(windowDays) > 0 ? Number(windowDays) : 7;
  const fromMs = nowMs - days * MS_PER_DAY;
  const fromIso = new Date(fromMs).toISOString();

  const all = observations ?? [];
  // Coverage is measured across ALL shadow data: has shadow been running ≥ N days?
  let earliestObservedAt = coverage?.earliestObservedAt ?? null;
  let organicHeadMoves = Number(coverage?.organicHeadMoves ?? 0);
  let exhaustionCloses = Number(coverage?.exhaustionCloses ?? 0);
  if (!coverage) {
    let earliestMsFallback = Infinity;
    for (const o of all) {
      if ((o.queue && o.queue.source !== 'organic') || (o.live && o.live.source !== 'organic')) continue;
      const t = Date.parse(o.observedAt);
      if (Number.isFinite(t) && t < earliestMsFallback) earliestMsFallback = t;
      if (o.sawHeadMove) organicHeadMoves += 1;
      if (o.sawExhaustion) exhaustionCloses += 1;
    }
    earliestObservedAt = Number.isFinite(earliestMsFallback)
      ? new Date(earliestMsFallback).toISOString()
      : null;
  }
  const earliestMs = Date.parse(earliestObservedAt ?? '');
  const hasEarliest = Number.isFinite(earliestMs);
  const coverageDays = hasEarliest ? Math.floor((nowMs - earliestMs) / MS_PER_DAY) : 0;
  const enoughDays = hasEarliest && (nowMs - earliestMs) >= days * MS_PER_DAY;

  // The report body is the observations whose tick time falls in the window.
  const windowed = all.filter((o) => {
    const t = Date.parse(o.observedAt);
    return Number.isFinite(t) && t >= fromMs && t <= nowMs;
  });

  let agree = 0;
  let diverge = 0;
  const divergences = [];
  for (const o of windowed) {
    if (o.classification?.relation !== 'agree') {
      diverge += 1;
      const eff = effectiveDisposition(o);
      divergences.push({
        id: o.id ?? null,
        subjectExternalId: o.subjectKey?.subjectExternalId ?? '',
        label: subjectLabel(o.subjectKey?.subjectExternalId),
        revisionRef: o.revisionRef ?? '',
        v1: o.v1Action?.kind ?? 'unknown',
        v1Detail: o.v1Action?.detail ?? null,
        v2: o.v2Decision?.kind ?? 'unknown',
        v2Compact: compactV2(o.v2Decision),
        direction: o.dispositionOverride?.direction ?? o.classification?.direction ?? 'open',
        class: o.classification?.class ?? null,
        ref: o.classification?.ref ?? null,
        reason: o.classification?.reason ?? '',
        disposition: eff,
        overridden: o.dispositionOverride != null,
        tag: dispositionTag(o),
        evidence: { v1SourceRef: o.v1Action?.sourceRef ?? null, queue: o.queue ?? null, live: o.live ?? null,
          disposition: o.dispositionOverride ?? null },
      });
    } else {
      agree += 1;
    }
  }

  const openDivergences = divergences.filter((d) => d.disposition === 'open').length;

  const blockers = [];
  if (!windowed.some(o => (!o.queue || o.queue.source === 'organic') && (!o.live || o.live.source === 'organic'))) blockers.push('no shadowed finalizations in window');
  if (!enoughDays) blockers.push(`insufficient shadow coverage (${coverageDays}d < ${days}d)`);
  if (openDivergences > 0) {
    blockers.push(`${openDivergences} open divergence${openDivergences === 1 ? '' : 's'}`);
  }
  if (organicHeadMoves < 1) blockers.push('no organic head-move observed in shadow');
  if (exhaustionCloses < 1) blockers.push('no budget-exhaustion close observed in shadow');
  const mgqPromotable = blockers.length === 0;
  const history = promotionHistory ?? all;
  const lanes = new Map();
  for (const o of history) {
    const evidence = o.live?.source === 'organic' ? o.live : o.queue?.source === 'organic' ? o.queue : null;
    if (!evidence?.lane) continue;
    const key = JSON.stringify(evidence.lane);
    const lane = lanes.get(key) ?? { lane: evidence.lane, rows: 0, subjects: new Set(), foldErrors: 0,
      lastObservationAt: null, consumer: null };
    lane.rows++;
    lane.subjects.add(JSON.stringify(o.subjectKey));
    lane.foldErrors += o.foldError ? 1 : 0;
    if (!lane.lastObservationAt || Date.parse(o.observedAt) >= Date.parse(lane.lastObservationAt)) {
      lane.lastObservationAt = o.observedAt;
      lane.consumer = evidence.consumer ?? null;
    }
    lanes.set(key, lane);
  }
  const promotionGate = buildMlrPromotionGate(history, now);
  blockers.push(...promotionGate.blockers);
  const promotable = blockers.length === 0;

  return {
    now,
    windowDays: days,
    window: { from: fromIso, to: now },
    shadowed: windowed.length,
    agree,
    diverge,
    divergences,
    organicHeadMoves,
    exhaustionCloses,
    coverage: { earliestObservedAt, coverageDays, enoughDays },
    openDivergences,
    promotable,
    blockers,
    promotionGate: { ...promotionGate, mgqPromotable },
    shadow: { rows: history.length,
      subjects: new Set(history.filter(o => o.live?.source === 'organic' || o.queue?.source === 'organic')
        .map(o => JSON.stringify(o.subjectKey))).size,
      foldErrors: history.filter(o => o.foldError).length,
      lanes: [...lanes.values()].map(lane => ({ ...lane, subjects: lane.subjects.size })) },
    queue: { organic: buildQueueShadowMetrics(queueHistory ?? all, { from: fromIso, to: now, source: 'organic' }),
      synthetic: buildQueueShadowMetrics(queueHistory ?? all, { from: fromIso, to: now, source: 'synthetic' }) },
  };
}

/**
 * Render the model as the operator status block (SPEC §1 Win 3).
 * @param {ShadowReportModel} model
 * @returns {string}
 */
export function renderShadowReport(model) {
  const lines = [];
  lines.push(`shadowed finalizations: ${model.shadowed}   agree: ${model.agree}   diverge: ${model.diverge}`);
  for (const lane of model.shadow?.lanes ?? []) {
    lines.push(`lane ${lane.lane.repository}/${lane.lane.base ?? 'unknown'}: pairs=${lane.rows} subjects=${lane.subjects} fold_errors=${lane.foldErrors} observed_at=${lane.lastObservationAt}`);
  }
  for (const sample of Object.values(model.queue ?? {})) {
    for (const lane of sample.lanes) lines.push(`queue ${lane.lane.repository}/${lane.lane.base} (${sample.source}): entries=${lane.entries} service_samples=${lane.serviceTimeSamples} service_total_ms=${lane.totalServiceTimeMs} service_mean_ms=${lane.serviceTimeMeanMs ?? 'unknown'} oldest_ready_ms=${lane.oldestReadyAgeMs ?? 'none'} arrivals/hour=${lane.arrivalsPerHour.toFixed(2)} merges/hour=${lane.mergesPerHour.toFixed(2)} returns/hour=${lane.returnsToRemediationPerHour.toFixed(2)} infrastructure_wait_ms=${lane.infrastructureWaitMs} infrastructure_park_ms=${lane.infrastructureParkMs} window_hours=${sample.window.hours}`);
  }

  if (model.divergences.length > 0) {
    const labelW = Math.max(...model.divergences.map((d) => d.label.length));
    const v1W = Math.max(...model.divergences.map((d) => d.v1.length));
    const v2W = Math.max(...model.divergences.map((d) => d.v2Compact.length));
    for (const d of model.divergences) {
      const label = d.label.padEnd(labelW);
      const v1 = `v1=${d.v1}`.padEnd(v1W + 3);
      const v2 = `v2=${d.v2Compact}`.padEnd(v2W + 3);
      lines.push(`  ${label} ${v1} ${v2}  [${d.tag}]`);
    }
  }
  if (model.promotionGate) {
    const g = model.promotionGate;
    lines.push(`promotion gate: ≥50 finalizations ${g.finalizations >= 50 ? '✔' : '✖'} (${g.finalizations}) · ≥1 head-move ${g.headMoves ? '✔' : '✖'} · ≥1 exhaustion close ${g.exhaustionCloses ? '✔' : '✖'} · all dispositioned ${g.openDivergences ? `✖ (${g.openDivergences})` : '✔'} · fold/evidence errors ${g.foldErrors}`);
  }

  if (model.promotable) {
    lines.push('verdict: promotable');
  } else {
    lines.push(`verdict: NOT promotable (${model.blockers.join('; ')})`);
  }
  return lines.join('\n');
}
