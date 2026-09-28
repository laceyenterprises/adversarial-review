// token-refresh-pending-health.mjs — per-hour `token-refresh-pending` refusal
// counts for the review pipeline health surface (TOKDZ-01).
//
// A refusal is the Claude reviewer declining to hand its subprocess a broker
// token that is waiting on a rotation. After TOKDZ-01 it is a bounded hold, not
// a failed attempt, which also makes it quiet: nothing is charged, nothing goes
// terminal, and the PR simply waits. This summary keeps it visible. The SEV3
// that motivated the ticket (agent-os #7309) was ~2.5 h of refusals in every
// 8 h token cycle that nobody saw until PRs stranded.
//
// With the token-refresh proxy in place a healthy bridge produces zero
// refusals, so a sustained count means the bridge is late or the proxy is off.
// Pure: the collector owns the SQL and the finding.

export const DEFAULT_TOKEN_REFRESH_PENDING_WINDOW_MS = 60 * 60 * 1000;
// Refusals within the window before the finding can fire.
export const DEFAULT_TOKEN_REFRESH_PENDING_THRESHOLD = 3;
// ...and the share of Claude reviewer picks in the window they must reach, so
// a busy hour with a stray refusal or two stays quiet.
export const DEFAULT_TOKEN_REFRESH_PENDING_SHARE_THRESHOLD = 0.2;
export const TOKEN_REFRESH_PENDING_HOURLY_LOOKBACK_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

function metadataFailureClass(row) {
  try {
    const metadata = JSON.parse(row?.metadata_json || '{}');
    return String(metadata?.failureClass || metadata?.failure_class || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function isClaudePick(row) {
  return String(row?.reviewer_class || '').trim().toLowerCase() === 'claude';
}

// `rows` are reviewer_passes rows (started_at, reviewer_class, status,
// metadata_json, repo, pr_number) covering at least the hourly lookback.
export function summarizeTokenRefreshPendingRefusals(rows, {
  nowMs,
  windowMs = DEFAULT_TOKEN_REFRESH_PENDING_WINDOW_MS,
  threshold = DEFAULT_TOKEN_REFRESH_PENDING_THRESHOLD,
  shareThreshold = DEFAULT_TOKEN_REFRESH_PENDING_SHARE_THRESHOLD,
} = {}) {
  const windowStartMs = nowMs - windowMs;
  const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const firstHourStartMs = currentHourStartMs - (TOKEN_REFRESH_PENDING_HOURLY_LOOKBACK_HOURS - 1) * HOUR_MS;
  const hourly = Array.from({ length: TOKEN_REFRESH_PENDING_HOURLY_LOOKBACK_HOURS }, (_, index) => ({
    hourStart: new Date(firstHourStartMs + index * HOUR_MS).toISOString(),
    refusals: 0,
    claudePicks: 0,
  }));
  let refusals = 0;
  let claudePicks = 0;
  const distinctPrs = new Set();
  for (const row of rows || []) {
    const startedMs = Date.parse(row?.started_at || '');
    if (!Number.isFinite(startedMs) || startedMs > nowMs) continue;
    const refused = metadataFailureClass(row) === 'token-refresh-pending';
    const claude = isClaudePick(row) || refused;
    const bucket = hourly[Math.floor((startedMs - firstHourStartMs) / HOUR_MS)];
    if (bucket) {
      if (claude) bucket.claudePicks += 1;
      if (refused) bucket.refusals += 1;
    }
    if (startedMs < windowStartMs) continue;
    if (claude) claudePicks += 1;
    if (refused) {
      refusals += 1;
      distinctPrs.add(`${row.repo}#${row.pr_number}`);
    }
  }
  const share = claudePicks > 0 ? refusals / claudePicks : 0;
  return {
    windowMs,
    threshold,
    shareThreshold,
    refusals,
    claudePicks,
    share,
    distinctPrs: distinctPrs.size,
    alerting: refusals >= threshold && share >= shareThreshold,
    hourly,
    maxHourlyRefusals: hourly.reduce((max, bucket) => Math.max(max, bucket.refusals), 0),
  };
}
