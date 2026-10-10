/** CIGUARD-01: independent live-head CI-cost refusal, including unprotected repos. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { loadEffectiveMergeAuthorityConfig } from './effective-policy.mjs';

const engine = fileURLToPath(new URL('../../scripts/ci-cost-guard.py', import.meta.url));
const label = 'ci-cost-approved';

export function evaluateCiCost(payload, { python = process.env.HQ_PYTHON3 || 'python3' } = {}) {
  const run = spawnSync(python, [engine, '--json-input'], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  if (run.error || ![0, 1].includes(run.status)) throw new Error(`CI-cost engine unavailable: ${run.error?.message || run.stderr}`);
  const result = JSON.parse(run.stdout);
  if (typeof result.ok !== 'boolean' || result.error) throw new Error(result.error || 'invalid CI-cost result');
  return result;
}

// CIGUARDADV-01 (operator decision 2026-10-06, "Cost guard advisory now"): the
// CI-cost check is ADVISORY by default. A flagged, unreadable or failed cost
// check is reported (returned as `advisory`) but never blocks merge; spend is
// controlled by the org budget cap, the billing read and the ci-spend-alarm.
// AMA_CI_COST_MODE=blocking restores the CIGUARD-01 refusal.
export function ciCostMode(env = process.env) {
  return String(env.AMA_CI_COST_MODE || '').toLowerCase() === 'blocking' ? 'blocking' : 'advisory';
}

function blockingCheck(evidence, headSha) {
  if (!evidence || evidence.headSha !== headSha || evidence.error) return { ok: false, reason: 'ci-cost-read-failed' };
  if (evidence.failedCheck) return { ok: false, reason: 'ci-cost-check-failed' };
  if (evidence.ok !== true) return { ok: false, reason: 'ci-cost-unauthorized' };
  return { ok: true };
}

export function checkCiCost(evidence, headSha, { mode = ciCostMode() } = {}) {
  const result = blockingCheck(evidence, headSha);
  if (result.ok || mode === 'blocking') return result;
  return { ok: true, advisory: result.reason };
}

async function pages(get, path, field = null) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = field ? response[field] : response;
    if (!Array.isArray(items)) throw new Error(`incomplete GitHub ${path}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error(`GitHub pagination exceeds bound: ${path}`);
}

export async function fetchCiCost({ repo, prNumber, headSha, get, rootDir, operators }) {
  try {
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha || !/^[0-9a-f]{40}$/i.test(pr.base?.sha || '')) throw new Error('stale PR head/base');
    // Compare against the merge base, never the moving base tip or PR-owned scanner.
    // REVIEWCHUNK-01: the merge base is taken with the CURRENT base-branch tip
    // (three-dot compare on the base ref). The stored base SHA goes stale once a
    // PR merges its base branch back in, and the PR files list then includes
    // every workflow change that merge pulled in, billed to this PR.
    const compareBase = pr.base.ref ? encodeURIComponent(pr.base.ref) : pr.base.sha;
    const comparison = await get(`repos/${repo}/compare/${compareBase}...${headSha}`);
    const base = comparison.merge_base_commit?.sha;
    if (!/^[0-9a-f]{40}$/i.test(base || '')) throw new Error('missing merge base');
    const files = await pages(get, `repos/${repo}/pulls/${prNumber}/files`);
    if (files.length >= 3000 || (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)) throw new Error('truncated PR files');
    // The compare lists at most 300 files; past that it may be truncated, so the
    // complete (possibly stale-base-inflated) PR files list is the safe superset.
    const ownFiles = Array.isArray(comparison.files) && comparison.files.length < 300 ? comparison.files : files;
    const workflows = ownFiles.filter((file) => file.filename?.startsWith('.github/workflows/') || file.previous_filename?.startsWith('.github/workflows/'));
    const readYaml = async (path, ref) => {
      const data = await get(`repos/${repo}/contents/${path}?ref=${ref}`);
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.truncated) throw new Error(`unreadable workflow ${path}`);
      const value = yaml.load(Buffer.from(data.content, 'base64').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid workflow ${path}`);
      return value;
    };
    const changes = [];
    for (const file of workflows) {
      changes.push({ path: file.filename,
        before: file.status === 'added' ? null : await readYaml(file.previous_filename || file.filename, base),
        after: file.status === 'removed' ? null : await readYaml(file.filename, headSha),
      });
    }
    const labels = (pr.labels || []).map((item) => item.name);
    const timeline = labels.includes(label) ? await pages(get, `repos/${repo}/issues/${prNumber}/timeline`) : [];
    operators ??= labels.includes(label) ? loadEffectiveMergeAuthorityConfig({ rootDir }).operatorLogins || [] : [];
    const result = changes.length ? evaluateCiCost({ changes, labels, timeline, operators })
      : { ok: true, flagged: false, authorized: false, findings: [], added_minutes_per_pr_push: 0, added_minutes_per_month: 0 };
    // Failed cost checks remain a hard stop even when a label later appears:
    // the operator must rerun CI. This also catches an equivalent repo guard.
    const checks = await pages(get, `repos/${repo}/commits/${headSha}/check-runs`, 'check_runs');
    const statuses = await pages(get, `repos/${repo}/commits/${headSha}/statuses`);
    const latest = new Map();
    for (const check of checks) {
      if (/ci[- ]cost/i.test(check.name || '') && (!latest.has(check.name) || Number(check.id || 0) > Number(latest.get(check.name).id || 0))) latest.set(check.name, check);
    }
    const failedCheck = [...latest.values()].some((check) => check.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(check.conclusion))
      || statuses.some((status, i) => /ci[- ]cost/i.test(status.context || '') && !statuses.slice(0, i).some((older) => older.context === status.context) && status.state !== 'success');
    const finalPr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (finalPr.head?.sha !== headSha || finalPr.base?.sha !== pr.base.sha || JSON.stringify(finalPr.labels) !== JSON.stringify(pr.labels)) throw new Error('PR changed during cost read');
    return { ...result, headSha, failedCheck };
  } catch (error) {
    return { ok: false, headSha, error: String(error.message || error) };
  }
}
