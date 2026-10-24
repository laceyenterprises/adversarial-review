// Read-only RCV-08 activation evidence. Absence, stale adoption and failed
// reads are reported as unavailable; installed source alone is not adoption.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHammerRetryCapLedger } from './ama/hammer-retry-cap.mjs';
import { readExecutionVerdictsFromLedgerAsync } from './session-ledger-read-adapter.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { loadRoleConfig } from './role-config.mjs';
import { validNoWorkVerdict } from './execution-verdict.mjs';
import { MAX_TIMER_DELAY_MS } from './load-aware-timeout.mjs';

export const RECOVERY_WAIT_INVENTORY = Object.freeze([
  { id: 'spawn-600s', source: 'src/ama/dispatch-closer.mjs:resolveAmaDispatchTimeoutMs', nominalMs: 600_000 },
  { id: 'merge', source: 'src/ama/dispatch-closer.mjs:runGhPrMergeWithTransientRetry', nominalMs: 30_000 },
  { id: 'checks', source: 'src/gh-cli.mjs:execGhWithRetry', nominalMs: 30_000 },
]);
export async function recoveryStatus({
  rootDir = join(dirname(fileURLToPath(import.meta.url)), '..'),
  hqRoot = resolveHqRoot(), env = process.env, nowMs = Date.now(),
  readVerdictsImpl = readExecutionVerdictsFromLedgerAsync, configImpl = loadRoleConfig,
} = {}) {
  let source;
  try { source = await readVerdictsImpl({ rootDir, hqRoot, env }); }
  catch { source = { ok: false }; }
  const sourceHealthy = source?.ok === true && Array.isArray(source.verdicts)
    && source.verdicts.every(value => value.schemaVersion === 1 && value.producer === 'cwp-execution/1'
      && ['unknown', 'work_started', 'no_work'].includes(value.verdict)
      && (value.verdict !== 'no_work' || validNoWorkVerdict(value, value.launchRequestId)));
  const configuredValues = {};
  let configHealthy = true;
  try {
    const cfg = configImpl();
    for (const key of ['roles.adversarial.merge_authority.dispatch_timeout_ms',
      'roles.adversarial.merge_authority.hammer_lifetime_dispatch_ceiling',
      'adversarial.reviewer.load_aware.enabled', 'adversarial.reviewer.load_aware.max_multiplier']) {
      configuredValues[key] = { value: cfg.get(key), resolution: cfg.resolutionTrace?.(key) || null };
    }
  } catch { configHealthy = false; }
  let ledgerHealthy = true;
  let files = [];
  try { files = readdirSync(join(rootDir, 'data/follow-up-jobs/hammer-retry-cap')).filter(file => file.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') ledgerHealthy = false; }
  if (files.length > 1000) ledgerHealthy = false;
  const charges = [], receipts = [];
  for (const file of files.slice(0, 1000)) {
    // Use the canonical ledger reader, retaining its corruption refusal. File
    // identity is decoded only for that reader; no raw ledger fields are emitted.
    const match = file.match(/^(.*)-pr-(\d+)\.json$/);
    if (!match) { ledgerHealthy = false; continue; }
    const doc = readHammerRetryCapLedger(rootDir,
      { repo: match[1].replaceAll('__', '/'), prNumber: Number(match[2]) }, { logger: null });
    if (!doc || doc.__corrupt) { ledgerHealthy = false; continue; }
    charges.push(...Object.values(doc.dispatchCharges || {}));
    receipts.push(...Object.values(doc.noWorkRefunds || {}));
  }
  const latest = charges.filter(charge => charge.consumerVersion === 1 && Number.isFinite(Date.parse(charge.chargedAt)))
    .sort((a, b) => Date.parse(b.chargedAt) - Date.parse(a.chargedAt))[0];
  const ageSeconds = latest ? Math.max(0, (nowMs - Date.parse(latest.chargedAt)) / 1000) : null;
  const active = ledgerHealthy && ageSeconds !== null && ageSeconds <= 86400;
  const waitObserved = active && latest.waitBudget?.dispatchTimeoutMs > 0
    && latest.waitBudget.dispatchTimeoutMs <= MAX_TIMER_DELAY_MS;
  const budgets = Object.fromEntries(['head', 'pr', 'lifetime', 'transient'].map(budget => [budget, {
    refundable: active && sourceHealthy,
    observedRefunds: receipts.filter(receipt => receipt.budgets?.[budget]).length,
    lastRefundAt: receipts.filter(receipt => receipt.budgets?.[budget])
      .map(receipt => receipt.refundedAt).sort().at(-1) || null,
  }]));
  return {
    verdictSchemaVersion: 1,
    consumer: { active, sourceHealthy, ledgerHealthy, configHealthy,
      source: source?.source || null, observedAt: latest?.chargedAt || null, ageSeconds,
      freshnessSeconds: 86400, chargesObserved: charges.length, refundsObserved: receipts.length },
    budgets, configuredValues,
    waitInventory: { entries: RECOVERY_WAIT_INVENTORY, ceilingMs: MAX_TIMER_DELAY_MS,
      observedDispatch: latest?.waitBudget || null,
      missing: waitObserved && configHealthy ? [] : ['runtime-dispatch-wait-observation'],
      exclusions: ['leases', 'freshness', 'cadence', 'SLO objectives', 'spend ceilings', 'no-progress deadlines'] },
    runtimeEvidence: { adapterModule: fileURLToPath(import.meta.url), source: 'durable hammer charge/refund receipts' },
    observedAt: new Date(nowMs).toISOString(),
  };
}
