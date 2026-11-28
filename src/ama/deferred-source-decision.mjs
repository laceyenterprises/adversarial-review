import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

const OPTIONS = ['keep-custody', 'discard-remediation'];

// HQ owns replies. The closer owns release and rechecks the live head, owner
// and lease before acting on the reply. Both records pin the retained attempt.
export function deferredDecisionFiles(hqRoot, hold) {
  if (!hqRoot || hold?.unreadable || !/^lrq_[a-zA-Z0-9-]+$/.test(hold?.launchRequestId || '')
    || !/^attempt-[a-zA-Z0-9]+$/.test(hold?.attempt || '')) return null;
  const { repo, prNumber, targetHead, sourceHead, launchRequestId, attempt } = hold;
  const identity = { repo, prNumber, targetHead, sourceHead, launchRequestId, attempt };
  const dir = join(hqRoot, 'dispatch', 'audit', 'deferred-source-decisions', launchRequestId, attempt);
  return { identity, decision: join(dir, 'decision.json'), answer: join(dir, 'answer.json') };
}

function matchingRecord(path, identity) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record?.schemaVersion !== 1 || Object.entries(identity).some(([key, value]) => record[key] !== value)) {
      throw new Error('deferred custody decision identity changed');
    }
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readDeferredDecisionAnswer(files) {
  if (!files) return null;
  const answer = matchingRecord(files.answer, files.identity);
  if (answer && (!OPTIONS.includes(answer.answer) || !Number.isFinite(Date.parse(answer.answeredAt))
    || !matchingRecord(files.decision, files.identity))) throw new Error('invalid deferred custody answer');
  return answer;
}

export function raiseDeferredDecision(files, question, now) {
  if (!files) return null;
  const { launchRequestId, attempt } = files.identity;
  const command = `hq decision reply ${launchRequestId} --custody-attempt ${attempt} --answer keep-custody`;
  try {
    writeFileAtomic(files.decision, JSON.stringify({ schemaVersion: 1, ...files.identity,
      question, options: OPTIONS, recommended: OPTIONS[0], command, createdAt: now }), { mode: 0o600, overwrite: false });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const record = matchingRecord(files.decision, files.identity);
    if (record?.command !== command || JSON.stringify(record.options) !== JSON.stringify(OPTIONS)) {
      throw new Error('invalid deferred custody decision');
    }
  }
  return command;
}
