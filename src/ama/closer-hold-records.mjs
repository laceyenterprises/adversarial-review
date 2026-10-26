import { createHash } from 'node:crypto';
import { readFileSync, statSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { hammerStopInputs, normalizeHammerStopHold, readHammerStopForHead, isInfrastructureStop } from './hammer-stop-hold.mjs';
import { normalizeOperatorLabelHold } from './operator-label-gates.mjs';
import { normalizeStackedBaseHold } from './stacked-base.mjs';
import { assertHoldRecord, evaluateHoldRecord, holdEvaluatedThisPoll, markHoldEscalated } from './hold-record.mjs';

// The same exports are usable by owner-resolution consumers. No directory scan,
// remote read, dispatch or merge is needed to project the current subject's holds.
export function readCloserHoldRecords({ rootDir, repo, prNumber, headSha }) {
  const digest = value => createHash('sha256').update(value).digest('hex');
  const safeRepo = repo.replace(/[^A-Za-z0-9._-]/g, '-');
  const stores = [
    ['hammer-stop', join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', `${safeRepo}-pr-${prNumber}.json`)],
    ['operator-label', join(rootDir, 'data', 'operator-label-holds', `${digest(JSON.stringify([repo, prNumber, headSha]))}.json`)],
    ['stacked-base', join(rootDir, 'data', 'stacked-base-holds', `${digest(`${repo.toLowerCase()}#${prNumber}`)}.json`)],
  ];
  const holds = [];
  for (const [type, path] of stores) {
    try {
      const raw = readFileSync(path, 'utf8');
      const document = JSON.parse(raw);
      const legacyNow = statSync(path).mtime.toISOString();
      const value = type === 'hammer-stop' ? document.heads?.[headSha] : document;
      if (!value || value.releasedAt || value.clearedAt || (type === 'stacked-base' && !value.reason)) continue;
      const record = type === 'hammer-stop' ? normalizeHammerStopHold(value, { repo, prNumber, headSha, now: legacyNow })
        : type === 'operator-label' ? normalizeOperatorLabelHold(value, legacyNow) : normalizeStackedBaseHold(value, legacyNow);
      holds.push({ path, raw, document, record, type });
    } catch (error) {
      if (error.code !== 'ENOENT') holds.push({ path, error });
    }
  }
  return holds;
}

// Called after the ordinary handlers in each poll. Owners already evaluated in
// this poll are skipped. Backed-off subjects still get timer/head/base/check
// evaluation; expensive evidence probes retain their existing owner cadence.
export async function evaluateCloserHoldsForPoll({ rootDir, hqRoot = rootDir, subjects, now = new Date().toISOString(),
  deliverAlertImpl, logger = console }) {
  const seen = new Set();
  for (const subject of subjects) {
    const repo = subject.repoPath || subject.repo;
    const { prNumber, headSha } = subject;
    if (!repo || !prNumber || !headSha) continue;
    const key = JSON.stringify([repo, prNumber, headSha]);
    if (seen.has(key)) continue;
    seen.add(key);
    const metadata = subject.holdMetadata || { headSha };
    // Only currently discovered open subjects participate. Terminal observations
    // cannot release, page, or create work, even if an old hold file remains.
    if (metadata.terminal === true || metadata.lifecycle === 'terminal' || metadata.isOpen === false || metadata.mergedAt
      || (metadata.state && String(metadata.state).toUpperCase() !== 'OPEN')) continue;
    for (const stored of readCloserHoldRecords({ rootDir, repo, prNumber, headSha })) {
      if (stored.error) { logger.warn?.(`Closer hold unreadable: ${stored.error.code || 'invalid-record'}`); continue; }
      const { record, path, raw, document, type } = stored;
      if (holdEvaluatedThisPoll(record, rootDir)) continue;
      if (type === 'hammer-stop') {
        // A receipt cannot invent a stop after audit retention or success. The
        // existing packaging exception still retains its deterministic refusal.
        const stop = readHammerStopForHead({ hqRoot, repo, prNumber, headSha, reviewedSha: subject.reviewedSha, logger });
        const sameRefusal = record.refusal && record.refusal.key === stop?.refusal?.key;
        if (!stop || (stop.stopKey !== record.stopKey && !sameRefusal && !isInfrastructureStop(stop))) continue;
      }
      const inputs = hammerStopInputs(metadata, { excludeContexts: record.excludeContexts || [] });
      // Review fingerprints require the owner's complete review snapshot. Missing
      // rollups and unknown own-context policy cannot prove a check change.
      delete inputs.review;
      if (!Array.isArray(metadata.statusCheckRollup) || !Array.isArray(record.excludeContexts)) delete inputs.checks;
      const events = {};
      if (type === 'operator-label' && record.holdSource === 'checks'
        && classifyCheckRollup(metadata.statusCheckRollup, { requiredContexts: record.gates.map(gate => gate.check).filter(Boolean) }) === 'SUCCESS') events['operator-label-gates-cleared'] = true;
      if ((metadata.baseBranch || metadata.baseRefName) && (metadata.baseBranch || metadata.baseRefName) === metadata.defaultBranch) events['stacked-base-cleared'] = true;
      const evaluation = evaluateHoldRecord(record, { now, namespace: rootDir, inputs, events });
      if (evaluation.action !== 'release' && !evaluation.escalate) continue;
      const lock = `${path}.lock`;
      let claimed = false;
      try {
        closeSync(openSync(lock, 'wx')); claimed = true;
        if (readFileSync(path, 'utf8') !== raw) continue;
        const updated = { ...record };
        if (evaluation.action === 'release') {
          updated.releasedAt = now;
          updated.releasedBy = evaluation.changed;
          updated.releasedInputs = inputs;
        } else {
          const text = `Closure hold ${repo} PR ${prNumber}: ${record.reason}; owner=${record.owner}; deadline=${record.deadline}; awaits=${JSON.stringify(record.awaits)}`;
          if (type === 'stacked-base') {
            // Its existing escalation is the retarget comment, owned by the
            // normal guard. Do not add a second external notification path.
            logger.warn?.(text);
          } else {
            if (typeof deliverAlertImpl !== 'function') continue;
            await deliverAlertImpl(text, { event: record.onDeadline, payload: { repo, prNumber, headSha,
              owner: record.owner, reason: record.reason, deadline: record.deadline, awaits: record.awaits } });
            markHoldEscalated(record, rootDir);
            if (readFileSync(path, 'utf8') !== raw) continue;
            if (type === 'hammer-stop') updated.pagedAt = now;
            else updated.alertedAt = now;
          }
          markHoldEscalated(record, rootDir);
          updated.escalatedAt = now;
        }
        assertHoldRecord(updated);
        const next = type === 'hammer-stop' ? { ...document, heads: { ...document.heads, [headSha]: updated } } : updated;
        writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') logger.warn?.(`Closer hold evaluation failed: ${error.code || 'delivery-error'}`);
      } finally { if (claimed) { try { unlinkSync(lock); } catch { /* replaced/removed claim */ } } }
    }
  }
}
