// CLOSERGATES-01: the HAM machine predicate's exact-head inputs, read once by
// one deployed helper instead of shell the hammer transcribes. Every read
// retries transient failures in place (closure-gate-read.mjs). A definitive
// answer refuses with a named reason, and nothing unreadable is written as a
// passing input.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { CLOSURE_GATE_BUDGET_MS, classifyClosureGateFailure, closureGateClock, readClosureGateSync } from './closure-gate-read.mjs';

export const PREDICATE_PR_FIELDS = 'number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName';
// HAMBG-02 wording: a free-plan private repository (403), and a repository
// whose base has no classic protection (404). ama-check classifies both inputs.
const PLAN_UNAVAILABLE = /branch protection.*(not available|upgrade|plan)|upgrade.*branch protection|protected branches.*(not available|upgrade|plan)|upgrade to github pro|make this repository public/i;
const NOT_PROTECTED = /branch not protected/i;
// A ref name exactly as GitHub reports it: no whitespace, control characters
// or git-forbidden punctuation. "main\n" is not "main".
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[^\s\x00-\x1f\x7f~^:?*[\\]+(?<![/.])$/;
const SHA = /^[a-f0-9]{40}$/i;

function malformed(message) { return Object.assign(new Error(`malformed: ${message}`), { malformed: true }); }
export const CLOSURE_GATE_UNAVAILABLE = 'closure-gate-read-unavailable';

// readPr(args) and readApi(args) return stdout or throw an Error carrying the
// child's stderr. Files are written only after every gate has been read.
export function collectPredicateInputs({
  repo, prNumber, headSha, runDir, readPr, readApi,
  clock = closureGateClock, budgetMs = loadAwareTimeoutMs(CLOSURE_GATE_BUDGET_MS), writeImpl = writeFileSync,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || '') || !/^[1-9]\d*$/.test(String(prNumber)) || !SHA.test(headSha || '') || !runDir) {
    return { ok: false, gate: 'request', kind: 'definitive', reason: 'predicate-input-request-invalid' };
  }
  // One closure budget covers every gate this helper reads.
  const deadline = clock.now() + budgetMs;
  const gate = (name, read, options = {}) => {
    const result = readClosureGateSync(read, { ...options, clock,
      classify: detail => detail.startsWith('malformed:') ? 'definitive' : classifyClosureGateFailure(detail),
      budgetMs: Math.max(0, deadline - clock.now()) });
    return result.ok ? result : { ...result, gate: name };
  };
  // An exhausted transient gate is a retryable deferral; anything else keeps
  // its named refusal.
  const refuse = (result, reason) => ({ ok: false, gate: result.gate, kind: result.kind,
    reason: result.kind === 'exhausted' ? CLOSURE_GATE_UNAVAILABLE : reason, detail: result.detail });
  const jsonText = (text, check) => {
    let value;
    try { value = JSON.parse(text); } catch { throw malformed('response is not JSON'); }
    check?.(value);
    return text;
  };
  const outputs = {};

  const snapshot = gate('pr-snapshot', () => jsonText(readPr(['--json', PREDICATE_PR_FIELDS]), value => {
    if (!SHA.test(value?.headRefOid || '')) throw malformed('PR snapshot has no head');
    if (typeof value.baseRefName !== 'string' || !BRANCH.test(value.baseRefName)) {
      throw malformed('PR snapshot base ref is not a branch name');
    }
  }));
  if (!snapshot.ok) {
    return refuse(snapshot, snapshot.detail?.startsWith('malformed:') ? 'predicate-input-malformed' : 'predicate-input-refresh-failed');
  }
  const pr = JSON.parse(snapshot.value);
  // A moved head is an authoritative refusal: every input, and any receipt,
  // belongs to the validated head only.
  if (pr.headRefOid.toLowerCase() !== headSha.toLowerCase()) {
    return { ok: false, gate: 'pr-snapshot', kind: 'definitive', reason: 'head-changed' };
  }
  outputs['pr-after.json'] = snapshot.value;

  const reviews = gate('reviews', () => jsonText(readPr(['--json', 'reviews'])));
  if (!reviews.ok) return refuse(reviews, 'predicate-input-refresh-failed');
  outputs['reviews.json'] = reviews.value;

  // The base comes from the parsed snapshot and is encoded once, here, so a
  // trailing newline or another transcription slip cannot reach the URL.
  const branch = encodeURIComponent(pr.baseRefName);
  const protection = gate('protection', () => {
    try { return jsonText(readApi([`repos/${repo}/branches/${branch}/protection`])); }
    catch (error) {
      const detail = String(error?.message || '');
      if (error?.malformed) throw error;
      if (PLAN_UNAVAILABLE.test(detail)) return `${JSON.stringify({ branchProtectionUnavailable: true, reason: 'github_plan' })}\n`;
      if (NOT_PROTECTED.test(detail)) return `${JSON.stringify({ status: '404', message: 'Branch not protected' })}\n`;
      throw error;
    }
  }, { confirmNotFound: () => {
    // The protection endpoint said the branch is not found. A branch read that
    // finds the base contradicts it; only a missing base confirms it.
    try {
      jsonText(readApi([`repos/${repo}/branches/${branch}`]), value => {
        if (value?.name !== pr.baseRefName) throw malformed('branch read names another branch');
      });
      return false;
    } catch (error) {
      if (!error?.malformed && /\b404\b/.test(String(error?.message || ''))) return true;
      throw error;
    }
  } });
  if (!protection.ok) {
    // A 404 is never "no protection". Confirmed, or persisting while a branch
    // read contradicts it, it refuses with its own reason.
    if (protection.kind === 'not-found' || (protection.kind === 'exhausted' && protection.notFoundContradicted)) {
      return { ok: false, gate: 'protection', kind: 'definitive', reason: 'protection-branch-not-found', detail: protection.detail };
    }
    return refuse(protection, 'protection-read-failed');
  }
  outputs['protection.json'] = protection.value;

  const timeline = gate('timeline', () => readApi([`repos/${repo}/issues/${prNumber}/timeline`, '--paginate']));
  if (!timeline.ok) return refuse(timeline, 'timeline-read-failed');
  outputs['timeline.json'] = timeline.value;

  const commit = gate('commit', () => jsonText(readApi([`repos/${repo}/commits/${headSha}`])));
  if (!commit.ok) return refuse(commit, 'commit-read-failed');
  outputs['commit.json'] = commit.value;

  for (const [name, text] of Object.entries(outputs)) writeImpl(join(runDir, name), text, { mode: 0o600 });
  return { ok: true, files: Object.keys(outputs) };
}
