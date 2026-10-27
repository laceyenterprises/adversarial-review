import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { createHoldRecord, evaluateHoldRecord, markHoldEscalated, holdEscalatedInProcess } from './hold-record.mjs';
import { creditHammerDispatchBudgets, readHammerRetryCapLedger, updateHammerRetryCapLedger } from './hammer-retry-cap.mjs';
import { meteredExecFile } from '../metered-gh.mjs';

export const COMPANION_WAIT_REASONS = new Set(['companion-submodule-pr-unmerged', 'companion-float-pending', 'companion-submodule-float-pending']);
// Normal all-submodule float backstop (24h), plus one hour of scheduling margin.
export const COMPANION_FLOAT_WAIT_MS = 25 * 60 * 60_000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const safePath = value => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

export function companionOnlyStop(stop) {
  const reasons = [...(stop?.reasons || []), ...(stop?.eligibilityTrace?.reasons || []),
    ...(stop?.githubGate?.reasons || []), stop?.predicate || stop?.reason]
    .filter(reason => reason && !['predicate-not-eligible', 'not-eligible', 'reason-not-recorded'].includes(reason));
  return reasons.length > 0 && reasons.every(reason => COMPANION_WAIT_REASONS.has(reason));
}

export function companionReference(value) {
  return value && REPO.test(value.repo) && Number.isSafeInteger(value.prNumber) && value.prNumber > 0
    && safePath(value.submodulePath)
    ? { repo: value.repo, prNumber: value.prNumber, submodulePath: value.submodulePath } : null;
}

function repoFromUrl(value) {
  const match = String(value || '').match(/^(?:https:\/\/github\.com\/|git:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1] || null;
}

// Read only GitHub APIs, uncached and pinned to the observed superproject base.
// The injected executor keeps all regression coverage fully offline.
export async function probeCompanionWait({ repo, prNumber, headSha, prMetadata, stop, prior, execFileImpl }) {
  const get = async endpoint => {
    const { stdout } = await meteredExecFile(execFileImpl, 'gh', ['api', endpoint], { timeout: loadAwareTimeoutMs(15_000), maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  let companion = companionReference(stop.companionWait) || companionReference(prior?.companionWait);
  let baseSha = prMetadata?.baseSha;
  if (!SHA.test(baseSha || '') || !companion) {
    const parent = await get(`repos/${repo}/pulls/${prNumber}`);
    if (parent.state !== 'open' || parent.merged_at || parent.head?.sha !== headSha) throw new Error('superproject changed or terminal');
    baseSha = parent.base?.sha;
    if (!SHA.test(baseSha || '')) throw new Error('base unavailable');
    if (!companion) {
      const modules = await get(`repos/${repo}/contents/.gitmodules?ref=${baseSha}`);
      const text = Buffer.from(modules.content || '', 'base64').toString('utf8');
      // Legacy notes may name a PR URL without a structured wait. Only accept
      // a unique reference that maps to a real base submodule repository.
      const evidence = [stop.companionEvidence, String(parent.body || '').split('\n')
        .filter(line => /companion|submodule/i.test(line)).join('\n')].filter(Boolean).join('\n');
      const refs = [...evidence.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)];
      const matches = [];
      for (const block of text.split(/\[submodule\s+[^\]]+\]/).slice(1)) {
        const path = block.match(/^\s*path\s*=\s*"?([^\n"]+)"?\s*$/m)?.[1]?.trim();
        const url = block.match(/^\s*url\s*=\s*"?([^\n"]+)"?\s*$/m)?.[1]?.trim();
        for (const ref of refs) if (repoFromUrl(url)?.toLowerCase() === ref[1].toLowerCase()) {
          const candidate = companionReference({ repo: ref[1], prNumber: Number(ref[2]), submodulePath: path });
          if (candidate) matches.push(candidate);
        }
      }
      const unique = [...new Map(matches.map(item => [JSON.stringify(item), item])).values()];
      if (unique.length !== 1) throw new Error('companion identity unavailable or ambiguous');
      [companion] = unique;
    }
  }
  const pull = await get(`repos/${companion.repo}/pulls/${companion.prNumber}`);
  if (!pull.merged_at) {
    if (!['open', 'closed'].includes(pull.state)) throw new Error('companion state unavailable');
    return { ...companion, state: pull.state, mergeCommit: null, baseSha, containsMerge: false };
  }
  const mergeCommit = pull.merge_commit_sha;
  if (!SHA.test(mergeCommit || '') || !Number.isFinite(Date.parse(pull.merged_at))) throw new Error('merge evidence unavailable');
  const result = { ...companion, state: 'merged', mergeCommit, mergedAt: pull.merged_at, baseSha, containsMerge: false };
  // A contents response must actually be a submodule, belonging to this repo.
  try {
    const link = await get(`repos/${repo}/contents/${companion.submodulePath.split('/').map(encodeURIComponent).join('/')}?ref=${baseSha}`);
    if (repoFromUrl(link.submodule_git_url)?.toLowerCase() !== companion.repo.toLowerCase() || !SHA.test(link.sha || '')) {
      throw new Error('base gitlink unavailable or repository mismatch');
    }
    result.gitlinkSha = link.sha;
    if (link.sha === mergeCommit) result.containsMerge = true;
    else {
      const comparison = await get(`repos/${companion.repo}/compare/${mergeCommit}...${link.sha}`);
      result.containsMerge = comparison.status === 'ahead' && comparison.merge_base_commit?.sha === mergeCommit;
    }
  } catch { result.evidenceUnreadable = true; }
  return result;
}

export function refundCompanionWaits(rootDir, identity, stop, now) {
  return updateHammerRetryCapLedger(rootDir, identity, ledger => {
    if (![ledger.attemptCount, ledger.targetAttemptCount, ledger.lifetimeAttemptCount]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return false;
    let changed = false;
    for (const item of stop.refundStops || []) {
      if (!item.companionOnly || !item.launchRequestId) continue;
      if (stop.refundStops.some(other => other.launchRequestId === item.launchRequestId && !other.companionOnly)) continue;
      const charge = Object.values(ledger.dispatchCharges || {}).find(value => value.launchRequestId === item.launchRequestId
        && value.headSha === item.headSha && value.jobKey === item.auditHead);
      if (!charge || charge.companionWaitRefund) continue;
      const credited = charge.refundedBudgets || {};
      const budgets = { pr: !credited.pr && ledger.jobKey === charge.jobKey,
        head: !credited.head && ledger.targetRemediationSha === charge.headSha && ledger.targetChargeEpoch === charge.targetEpoch,
        lifetime: !credited.lifetime };
      if (budgets.pr) ledger.attemptCount = Math.max(0, ledger.attemptCount - 1);
      if (budgets.head) ledger.targetAttemptCount = Math.max(0, ledger.targetAttemptCount - 1);
      if (budgets.lifetime) ledger.lifetimeAttemptCount = Math.max(0, ledger.lifetimeAttemptCount - 1);
      creditHammerDispatchBudgets(ledger, item.launchRequestId, budgets);
      charge.companionWaitRefund = { stopKey: item.stopKey, refundedAt: now };
      ledger.unexecutedLaunchRequestIds = [...new Set([...(ledger.unexecutedLaunchRequestIds || []), item.launchRequestId])];
      changed = true;
    }
    if (!changed) return false;
    ledger.suppressed = false;
    ledger.targetSuppressed = false;
    ledger.lifetimeSuppressed = false;
    return ledger;
  });
}

export function companionWaitRefundCount(rootDir, identity, headSha) {
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  return Object.values(ledger?.dispatchCharges || {}).filter(charge => charge.headSha === headSha
    && charge.companionWaitRefund && charge.refundedBudgets?.head).length;
}

export async function evaluateCompanionWait({ rootDir, repo, prNumber, headSha, prMetadata, stop, prior,
  execFileImpl, deliverAlertImpl, logger, now, persist, pageEvent, pagedInProcess }) {
  const sameStop = prior?.stopKey === stop.stopKey;
  const priorCompanion = companionReference(prior?.companionWait);
  const incoming = companionReference(stop.companionWait);
  const sameDependency = prior?.mode === 'companion' && (!incoming || JSON.stringify(incoming) === JSON.stringify(priorCompanion));
  let entry = sameDependency || sameStop ? { ...prior } : { firstObservedAt: now, pagedAt: null };
  if (prior?.mode !== 'companion') entry.pagedAt = null;
  entry.stopKey = stop.stopKey;
  entry.predicate = stop.predicate;
  entry.mode = 'companion';
  entry.owner = 'closure-recovery';
  delete entry.retryAfter;
  delete entry.refusal;
  // Old transient releases are not proof that the dependency is ready.
  delete entry.releasedAt;
  delete entry.releasedBy;
  entry.companionWait = incoming && JSON.stringify(incoming) !== JSON.stringify(priorCompanion)
    ? incoming : prior?.companionWait || incoming;
  try {
    entry.companionWait = await probeCompanionWait({ repo, prNumber, headSha, prMetadata, stop, prior: entry, execFileImpl });
    delete entry.probeError;
    if (entry.companionWait.evidenceUnreadable) entry.probeError = 'base gitlink evidence unreadable';
  } catch {
    // A previous closed/merged observation is not a fresh classification.
    // Retain timing/identity evidence, but require a readable next-pass probe.
    entry.companionWait = { ...entry.companionWait, state: 'unknown', containsMerge: false };
    entry.probeError = 'companion evidence unreadable';
  }
  const wait = entry.companionWait;
  // Credit only exactly identified charges for pure companion stops. An
  // unreadable ledger remains charged; never synthesize a retry allowance.
  try { refundCompanionWaits(rootDir, { repo, prNumber }, stop, now); }
  catch { logger?.warn?.('companion wait refund unavailable; existing charges retained'); }
  const events = { ...(entry.events || {}) };
  if (wait?.state === 'merged' && !events.companionMergedAt) events.companionMergedAt = now;
  const deadline = Date.parse(wait?.mergedAt || entry.firstObservedAt) + COMPANION_FLOAT_WAIT_MS;
  entry.waitUntil = new Date(deadline).toISOString();
  entry.awaitedEvent = wait?.state === 'merged' ? 'base-gitlink-contains-merge' : 'companion-merge';
  const name = wait ? `${wait.repo} PR ${wait.prNumber} (${wait.submodulePath})` : 'unidentified companion (dependency evidence pending)';
  const closingStatus = `Automated owner: closure-recovery; awaiting ${entry.awaitedEvent} for ${name}. Normal submodule float owns the base gitlink update.`;
  entry.closingStatus = closingStatus;
  entry = createHoldRecord({ ...entry, holdType: 'hammer-stop', repo, prNumber, headSha,
    reason: stop.predicate, deadline: entry.waitUntil, onDeadline: pageEvent,
    awaits: [{ kind: 'gitlink-contains-commit', ...(companionReference(wait) || {}),
      ...(wait?.mergeCommit ? { commit: wait.mergeCommit } : {}), changed: 'companion-floated' }] });
  const evaluation = evaluateHoldRecord(entry, { now, namespace: rootDir, companionWait: wait, evidenceUnreadable: Boolean(entry.probeError) });
  if (evaluation.action === 'release') {
    entry.releasedAt = sameStop && prior?.releasedAt || now;
    entry.releasedBy = ['companion-floated'];
    if (!events.companionFloatedAt) events.companionFloatedAt = now;
  }
  entry.events = events;
  for (const [key, changed] of [['companionMergedAt', 'companion-merged'], ['companionFloatedAt', 'companion-floated']]) {
    if (events[key] && !prior?.events?.[key]) logger?.log?.(JSON.stringify({
      event: 'ama_closer.hammer_stop_hold_released', repo, prNumber, headSha,
      stopKey: stop.stopKey, predicate: stop.predicate, changed: [changed], companionWait: wait,
    }));
  }
  const escalation = !entry.releasedAt && (wait?.state === 'closed' ? 'companion-closed-unmerged'
    : evaluation.escalate ? 'companion-float-timeout' : null);
  const debounceKey = `${rootDir}\0${repo}\0${prNumber}\0${headSha}\0companion\0${name}`;
  if (escalation && !holdEscalatedInProcess(entry, rootDir) && !entry.pagedAt && !pagedInProcess.has(debounceKey) && typeof deliverAlertImpl === 'function') {
    try {
      await deliverAlertImpl(`${closingStatus} Escalation: ${escalation}; companion ${name}.`, {
        event: pageEvent, payload: { repo, prNumber, headSha, predicate: stop.predicate,
          owner: entry.owner, awaitedEvent: entry.awaitedEvent, companionWait: wait, escalation },
      });
      markHoldEscalated(entry, rootDir);
      entry.pagedAt = now;
      pagedInProcess.add(debounceKey);
    } catch (err) { logger?.error?.(`companion wait escalation delivery failed: ${err?.code || 'delivery-error'}`); }
  }
  persist(entry);
  const hammerStop = { headSha, stopKey: stop.stopKey, predicate: stop.predicate, deterministic: false,
    owner: entry.owner, awaitedEvent: entry.awaitedEvent, closingStatus, companionWait: wait,
    since: entry.firstObservedAt, awaits: entry.awaits, deadline: entry.deadline, onDeadline: entry.onDeadline, waitUntil: entry.waitUntil, paged: Boolean(entry.pagedAt) };
  return entry.releasedAt ? { action: 'release', hammerStop, changed: entry.releasedBy }
    : { action: 'hold', hammerStop };
}
