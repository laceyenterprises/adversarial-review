// Only holds enforced by the merge authorities suppress pipeline accounting.
// Pipeline state labels deliberately remain countable.
export const OPERATOR_HOLD_LABELS = Object.freeze([
  'no-merge-hold', 'do-not-merge', 'merge-agent-skip',
]);

export function isOperatorHeld(labels = []) {
  if (typeof labels === 'string') {
    try { labels = JSON.parse(labels); } catch { return false; }
  }
  return Array.isArray(labels) && labels.some(label =>
    OPERATOR_HOLD_LABELS.includes(typeof label === 'string' ? label : label?.name));
}

export function operatorHeldSql(column = 'labels_json') {
  return `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) AS hold_label WHERE COALESCE(json_extract(CASE WHEN hold_label.type = 'object' THEN hold_label.value ELSE '{}' END, '$.name'), hold_label.value) IN (${OPERATOR_HOLD_LABELS.map(label => `'${label}'`).join(', ')}))`;
}

export const SQL_COUNT_HELD_OPEN_PRS =
  `SELECT COUNT(*) AS n FROM reviewed_prs WHERE pr_state = 'open' AND ${operatorHeldSql()}`;

// Opt-in accounting reads retain closed history and exclude enforced holds.
// Never apply this to lifecycle repair or diagnostic cleanup reads.
export function excludingHeldOpenRows(sql) {
  const cte = `reviewed_prs AS (SELECT * FROM main.reviewed_prs WHERE pr_state IS NOT 'open' OR NOT ${operatorHeldSql()})`;
  return /^\s*WITH\s/i.test(sql) ? sql.replace(/^(\s*WITH\s)/i, `$1${cte}, `) : `WITH ${cte} ${sql}`;
}

// Diagnostics remain read-only on legacy databases; absent evidence is unknown.
export function readHeldOpenPrCount(db) {
  if (!db) return null;
  try { return Number(db.prepare(SQL_COUNT_HELD_OPEN_PRS).get()?.n || 0); }
  catch (error) {
    if (error.code === 'SQLITE_ERROR' && /no such (table|column)/.test(error.message)) return null;
    throw error;
  }
}
