// Read model only. Live inventory owns terminal truth; NXA owns next intent.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationFingerprint as fingerprint } from './merge-lane-journal.mjs';
import { createHash } from 'node:crypto';
import { readShadowLogTail } from './next-action-disagreements.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { collect as inventory } from './merge-lane-inventory.mjs';
import { collectReviewLatencyReport } from './review-latency-report.mjs';
const DAY = 86_400_000;
const keyOf = r => r.repo && r.prNumber ? `${r.repo}#${r.prNumber}` : r.subjectKey;
const at = r => Date.parse(r.observedAt);

export function buildMergeLaneStatus({ records = [], inventory: input, now = Date.now(), loadOptions = {}, latency = null } = {}) {
  const graceMs = loadAwareTimeoutMs(3_600_000, { ...loadOptions, maxMs: 21_600_000 });
  const groups = new Map();
  for (const record of records) {
    if (!record?.next || !keyOf(record) || !Number.isFinite(at(record)) || at(record) > now) continue;
    const list = groups.get(keyOf(record)) || [];
    list.push(record); groups.set(keyOf(record), list);
  }
  for (const list of groups.values()) list.sort((a, b) => at(a) - at(b));
  let ownerlessMs = 0, observedMs = 0;
  // Integrate only observed intervals, capped at the shared load-scaled
  // refresh patience. A missing pass is unknown time, never a live owner.
  const freshnessMs = loadAwareTimeoutMs(300_000, { ...loadOptions, maxMs: 1_800_000 });
  for (const all of groups.values()) {
    const list = all.filter(r => r.kind === 'observation');
    for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!['OPEN', 'open'].includes(r.state)) continue;
    const end = Math.min(now, at(list[i + 1] || { observedAt: new Date(now).toISOString() }), at(r) + freshnessMs);
    const duration = Math.max(0, end - Math.max(now - DAY, at(r)));
    if (r.ownership?.ownerless != null) observedMs += duration;
    if (r.ownership?.ownerless === true) ownerlessMs += duration;
  }
  }
  const prs = [];
  const holds = new Set((input.holdLabels || []).map(s => s.trim().toLowerCase()));
  for (const [repo, items] of Object.entries(input.repositories || {})) for (const pr of items) {
    const subjectKey = `${repo}#${pr.number}`;
    const candidates = (groups.get(subjectKey) || []).filter(r => r.head === pr.headRefOid);
    const observations = candidates.filter(r => r.kind === 'observation');
    const history = observations.length ? observations : candidates;
    const latest = history.at(-1);
    const fresh = latest && now - at(latest) <= freshnessMs;
    const next = fresh ? latest.next : null;
    let start = history.length - 1;
    while (start > 0 && fingerprint(history[start - 1]) === fingerprint(latest)) start--;
    let deadline = next?.deadline?.at || null;
    if (next?.deadline?.anchorSource !== 'owner' && next?.deadline?.anchoredAt && next?.deadline?.budgetMs) {
      deadline = new Date((next.deadline.anchorSource === 'observed' ? Date.parse(latest.episodeStartedAt || history[start].observedAt) : Date.parse(next.deadline.anchoredAt)) + loadAwareTimeoutMs(next.deadline.budgetMs,
        { ...loadOptions, maxMs: Math.max(next.deadline.budgetMs, 21_600_000) })).toISOString();
    }
    const dueMs = Date.parse(deadline || '');
    const overdueAgeMs = Number.isFinite(dueMs) ? Math.max(0, now - dueMs) : null;
    // The episode starts at the last observed transition to this decision.
    const episode = latest ? createHash('sha256').update(`${subjectKey}:${fingerprint(latest)}:${latest.episodeStartedAt || history[start]?.observedAt}`).digest('hex').slice(0, 32) : null;
    const held = pr.isDraft || (pr.labels || []).some(l => holds.has(String(typeof l === 'string' ? l : l.name || '').trim().toLowerCase()));
    prs.push({ repo, number: pr.number, subjectKey, head: pr.headRefOid, title: pr.title, url: pr.url,
      state: held ? 'held' : next?.action || 'unknown', owner: next?.actor || null,
      nextAction: next?.action || null, deadline, overdueAgeMs, row: next?.row || 'unknown',
      reason: next?.reason || 'observation-unavailable', ownership: fresh ? latest.ownership || null : null,
      observedAt: latest?.observedAt || null, episode, pageEligible: !held && overdueAgeMs > graceMs,
      evidenceState: fresh ? 'complete' : latest ? 'stale' : 'missing' });
  }
  const samples = latency?.mergeLaneFlow?.greenToMergedSeconds || [];
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  const latest = records.filter(r => r.generation != null && Number.isFinite(at(r)) && at(r) <= now).sort((a, b) => at(b) - at(a))[0];
  return { schema: 'merge-lane-status/v1', observedAt: new Date(now).toISOString(), prs,
    source: { name: 'nxa-shadow', generation: latest?.generation ?? null, passId: latest?.passId ?? null,
      observedAt: latest?.observedAt || null, errors: input.errors || [],
      missing: prs.filter(p => p.evidenceState !== 'complete').length },
    load: { multiplier: graceMs / 3_600_000, overduePageAfterMs: graceMs },
    flow: { windowHours: 24, pages24h: null, pagesAvailability: 'aggregate-not-exposed', ownerlessMinutes24h: ownerlessMs / 60_000,
      observedOwnerMinutes24h: observedMs / 60_000, coverage: 'observed-intervals-only',
      merged24h: latency?.mergeLaneFlow?.merged ?? null, greenToMergedSeconds: samples,
      greenToMergedP50Seconds: percentile(0.5), greenToMergedP95Seconds: percentile(0.95),
      latencyAvailable: latency?.reviewStateLedger?.readable === true } };
}

export function readMergeLaneRecords(rootDir) {
  const records = [], errors = [];
  for (const name of ['observations.jsonl.1', 'disagreements.jsonl.1', 'observations.jsonl', 'disagreements.jsonl']) {
    try {
      const tail = readShadowLogTail(join(rootDir, 'data/next-action-shadow', name), { maxBytes: 16 * 1024 * 1024 });
      if (tail.truncated) errors.push(`${name}: truncated`);
      for (const line of tail.lines) {
        try { records.push(JSON.parse(line)); } catch { errors.push(`${name}: malformed record`); }
      }
    } catch { errors.push(`${name}: unreadable`); }
  }
  return { records, errors: [...new Set(errors)] };
}

export async function collectMergeLaneStatus({ rootDir = process.cwd(), codeRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  inventoryImpl = inventory, now = Date.now(), loadOptions = {} } = {}) {
  const input = await inventoryImpl(codeRoot, rootDir);
  const journal = readMergeLaneRecords(rootDir);
  input.errors = [...input.errors, ...journal.errors.map(error => ({ error }))];
  const latency = collectReviewLatencyReport({ rootDir, now: () => new Date(now) });
  return buildMergeLaneStatus({ records: journal.records, inventory: input, now, loadOptions, latency });
}

export function renderMergeLaneStatus(status) {
  const overdue = status.prs.filter(p => p.overdueAgeMs > 0);
  const age = ms => ms == null ? 'unknown' : `${Math.floor(ms / 60_000)}m`;
  return [`MERGE LANE — ${status.prs.length} open · ${overdue.length} overdue · oldest overdue ${age(Math.max(0, ...overdue.map(p => p.overdueAgeMs)))} · load ×${status.load.multiplier.toFixed(1)} · source nxa-shadow gen ${status.source.generation ?? 'unknown'}`,
    'PR\tREPO\tSTATE\tOWNER\tNEXT ACTION\tDEADLINE\tOVERDUE\tWHY',
    ...status.prs.map(p => `${p.number}\t${p.repo}\t${p.state}\t${p.owner || 'unknown'}\t${p.nextAction || 'unknown'}\t${p.deadline || 'unknown'}\t${age(p.overdueAgeMs)}\t${p.row} ${p.reason}`),
    `Flow (24h): merged ${status.flow.merged24h ?? 'unknown'} · green→merged p50 ${age(status.flow.greenToMergedP50Seconds == null ? null : status.flow.greenToMergedP50Seconds * 1000)} p95 ${age(status.flow.greenToMergedP95Seconds == null ? null : status.flow.greenToMergedP95Seconds * 1000)} · ownerless-minutes ${status.flow.ownerlessMinutes24h.toFixed(1)} (observed intervals only) · pages unknown (aggregate unavailable)`].join('\n');
}

export async function mergeLaneMain(argv, io = {}) {
  let rootDir = process.cwd(), json = false;
  if (argv.shift() !== 'status') throw new Error('Usage: merge-lane status [--root <dir>] [--json]');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--root' && argv[i + 1]) rootDir = argv[++i];
    else throw new Error('Usage: merge-lane status [--root <dir>] [--json]');
  }
  const status = await collectMergeLaneStatus({ rootDir });
  (io.stdout || process.stdout).write(`${json ? JSON.stringify(status) : renderMergeLaneStatus(status)}\n`);
  return status.source.errors.length ? 1 : 0;
}
