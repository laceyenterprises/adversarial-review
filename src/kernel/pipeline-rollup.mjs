// Pipeline rollup renderer (ARC-13, v2 app architecture §1 Win 2). Pure and
// side-effect-free: it turns a resolved multi-stage pipeline result into the
// operator-facing markdown comment posted once per review pass through the
// comms adapter. Rendering the rollup here (rather than in the comms adapter)
// keeps the markdown contract unit-testable via snapshots and independent of
// the GitHub delivery mechanics.
//
// The rendered shape is the SPEC's Win 2 (rev 4f2c9a1):
//
//   ## Adversarial review — pipeline rollup (rev 4f2c9a1)
//   | stage        | reviewer role         | verdict         | round |
//   |--------------|-----------------------|-----------------|-------|
//   | code-quality | code-quality-reviewer | comment-only    | 1/2   |
//   | security     | security-reviewer     | request-changes | 1/3   |
//   pipeline: BLOCKED at security — 2 blocking findings routed to remediation

const COLUMN_HEADERS = Object.freeze(['stage', 'reviewer role', 'verdict', 'round']);
const NOT_RUN = 'not run';
const EM_DASH = '—';

// Short revision label for the header (a 7-char abbreviated commit sha, the
// GitHub convention), falling back to the whole ref when it is already short.
function shortRevision(revisionRef) {
  const ref = String(revisionRef ?? '').trim();
  if (!ref) return '(unknown)';
  return ref.length > 7 ? ref.slice(0, 7) : ref;
}

function cell(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text === '' ? fallback : text;
}

function renderRow(cells, widths) {
  const padded = cells.map((value, index) => value.padEnd(widths[index]));
  return `| ${padded.join(' | ')} |`;
}

/**
 * Render the round column: `current/budget` (e.g. `1/2`), or an em dash for a
 * stage that has not run this pass.
 */
function renderRound(row) {
  if (row.verdict == null || row.verdict === '') return EM_DASH;
  const round = Number(row.round);
  const budget = Number(row.roundBudget);
  const roundText = Number.isFinite(round) && round > 0 ? String(round) : '?';
  const budgetText = Number.isFinite(budget) && budget > 0 ? String(budget) : '?';
  return `${roundText}/${budgetText}`;
}

function pluralizeFindings(count) {
  return `${count} blocking finding${count === 1 ? '' : 's'}`;
}

/**
 * Compose the footer disposition line.
 *
 * @param {{ disposition: 'clean'|'blocking'|'pending', blockingStageId?: string|null,
 *   pendingStageId?: string|null, blockingFindingsCount?: number, stageCount: number,
 *   revisionRef: string }} params
 */
function renderDispositionLine({
  disposition,
  blockingStageId,
  pendingStageId,
  blockingFindingsCount = 0,
  stageCount,
  revisionRef,
}) {
  if (disposition === 'blocking') {
    const findings = pluralizeFindings(Math.max(0, Number(blockingFindingsCount) || 0));
    return `pipeline: BLOCKED at ${cell(blockingStageId, '(unknown stage)')} — ${findings} routed to remediation`;
  }
  if (disposition === 'pending') {
    return `pipeline: PENDING at ${cell(pendingStageId, '(unknown stage)')} — awaiting verdict at rev ${shortRevision(revisionRef)}`;
  }
  const plural = stageCount === 1 ? 'stage' : 'stages';
  return `pipeline: CLEAN — all ${stageCount} ${plural} clean at rev ${shortRevision(revisionRef)}`;
}

/**
 * Render the full pipeline rollup comment body.
 *
 * @param {{
 *   revisionRef: string,
 *   rows: ReadonlyArray<{ stageId: string, roleId?: string|null, verdict?: string|null,
 *     round?: number|null, roundBudget?: number|null }>,
 *   disposition: 'clean' | 'blocking' | 'pending',
 *   blockingStageId?: string | null,
 *   pendingStageId?: string | null,
 *   blockingFindingsCount?: number,
 * }} params
 * @returns {string} markdown comment body
 */
export function renderPipelineRollup({
  revisionRef,
  rows = [],
  disposition = 'clean',
  blockingStageId = null,
  pendingStageId = null,
  blockingFindingsCount = 0,
} = {}) {
  const bodyRows = (Array.isArray(rows) ? rows : []).map((row) => [
    cell(row.stageId, '(unknown)'),
    cell(row.roleId, EM_DASH),
    cell(row.verdict, NOT_RUN),
    renderRound(row),
  ]);

  const widths = COLUMN_HEADERS.map((header, index) => {
    const columnCells = [header, ...bodyRows.map((cells) => cells[index])];
    return columnCells.reduce((max, value) => Math.max(max, value.length), 0);
  });

  const header = `## Adversarial review — pipeline rollup (rev ${shortRevision(revisionRef)})`;
  const headerRow = renderRow([...COLUMN_HEADERS], widths);
  const dividerRow = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
  const tableRows = bodyRows.map((cells) => renderRow(cells, widths));
  const dispositionLine = renderDispositionLine({
    disposition,
    blockingStageId,
    pendingStageId,
    blockingFindingsCount,
    stageCount: bodyRows.length,
    revisionRef,
  });

  return [header, headerRow, dividerRow, ...tableRows, dispositionLine].join('\n');
}

export { shortRevision };
