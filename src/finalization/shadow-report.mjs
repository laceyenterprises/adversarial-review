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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {import('../kernel/contracts.js').ShadowObservation} ShadowObservation
 * @typedef {import('../kernel/contracts.js').ShadowReportModel} ShadowReportModel
 */

/** The disposition in force: a human override supersedes the classifier proposal. */
export function effectiveDisposition(observation) {
  return observation?.dispositionOverride?.disposition ?? observation?.classification?.disposition ?? 'open';
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
  const cls = observation.classification ?? {};
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
 * }} args
 * @returns {ShadowReportModel}
 */
export function buildShadowReport({ observations, now, windowDays = 7 }) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('buildShadowReport requires a valid `now` ISO timestamp');
  const days = Number(windowDays) > 0 ? Number(windowDays) : 7;
  const fromMs = nowMs - days * MS_PER_DAY;
  const fromIso = new Date(fromMs).toISOString();

  const all = observations ?? [];
  // Coverage is measured across ALL shadow data: has shadow been running ≥ N days?
  let earliestMs = Infinity;
  let organicHeadMoves = 0;
  let exhaustionCloses = 0;
  for (const o of all) {
    const t = Date.parse(o.observedAt);
    if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
    if (o.sawHeadMove) organicHeadMoves += 1;
    if (o.sawExhaustion) exhaustionCloses += 1;
  }
  const earliestObservedAt = Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null;
  const coverageDays = Number.isFinite(earliestMs) ? Math.floor((nowMs - earliestMs) / MS_PER_DAY) : 0;
  const enoughDays = Number.isFinite(earliestMs) && (nowMs - earliestMs) >= days * MS_PER_DAY;

  // The report body is the observations whose tick time falls in the window.
  const windowed = all.filter((o) => {
    const t = Date.parse(o.observedAt);
    return Number.isFinite(t) && t >= fromMs && t <= nowMs;
  });

  let agree = 0;
  let diverge = 0;
  const divergences = [];
  for (const o of windowed) {
    if (o.classification?.relation === 'diverge') {
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
        direction: o.classification?.direction ?? 'open',
        class: o.classification?.class ?? null,
        ref: o.classification?.ref ?? null,
        reason: o.classification?.reason ?? '',
        disposition: eff,
        overridden: o.dispositionOverride != null,
        tag: dispositionTag(o),
      });
    } else {
      agree += 1;
    }
  }

  const openDivergences = divergences.filter((d) => d.disposition === 'open').length;

  const blockers = [];
  if (windowed.length === 0) blockers.push('no shadowed finalizations in window');
  if (!enoughDays) blockers.push(`insufficient shadow coverage (${coverageDays}d < ${days}d)`);
  if (openDivergences > 0) {
    blockers.push(`${openDivergences} open divergence${openDivergences === 1 ? '' : 's'}`);
  }
  if (organicHeadMoves < 1) blockers.push('no organic head-move observed in shadow');
  if (exhaustionCloses < 1) blockers.push('no budget-exhaustion close observed in shadow');
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

  if (model.promotable) {
    lines.push('verdict: promotable');
  } else {
    lines.push(`verdict: NOT promotable (${model.blockers.join('; ')})`);
  }
  return lines.join('\n');
}
