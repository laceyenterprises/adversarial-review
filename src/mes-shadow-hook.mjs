// MES-06: review-service shadow hook for the agent-os Model/Effort Selector.
//
// After the review or remediation resolver has chosen an execution, record one
// MES decision through the `hq mes decide --record --json` contract. Shadow
// only: nothing here changes, delays past a fixed bound, or fails the chosen
// execution. Every failure is caught and logged with a fixed reason.
//
// Only value-free data leaves this process: counts, closed enumerations and
// booleans. No titles, paths, prompts or finding text.
import { execFile } from 'node:child_process';

export const MES_DECIDE_TIMEOUT_MS = 5_000;
// A same-subject retry (a re-review of one head, a respawned round) is the next
// attempt. The ledger's unique (work_kind, subject_key, attempt) key arbitrates.
export const MES_MAX_ATTEMPTS = 4;
const GIT_NUMSTAT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

// Mirrors agent_os_core.mes_signals (closed enumerations and exact key sets).
export const MES_REVIEW_SIGNAL_KEYS = Object.freeze([
  'diff_lines', 'file_count', 'risk_path_count', 'risk_paths_touched', 'change_kind', 'builder_prefix',
]);
export const MES_REMEDIATION_SIGNAL_KEYS = Object.freeze([
  'blocking_findings', 'nonblocking_findings', 'diff_lines', 'file_count',
  'rounds_so_far', 'round_budget', 'round_fraction',
]);
const CHANGE_KIND_VALUES = new Set(['feature', 'bug-fix', 'remediation', 'infrastructure', 'docs']);
// cwp_dispatch.change_kind.CHANGE_KIND_ALIASES.
const CHANGE_KIND_ALIASES = Object.freeze({
  feat: 'feature', fix: 'bug-fix', bug: 'bug-fix', bugfix: 'bug-fix', hotfix: 'bug-fix',
  infra: 'infrastructure', chore: 'infrastructure', ci: 'infrastructure', build: 'infrastructure',
  perf: 'infrastructure', refactor: 'infrastructure', test: 'infrastructure', doc: 'docs',
});
const BUILDER_PREFIXES = new Set(['codex', 'claude-code', 'clio-agent', 'gemini', 'pi', 'opencode', 'hermes']);
const TITLE_KIND_RE = /^\s*(?:\[[^\]]+\]\s*)?(?:\(([A-Za-z][A-Za-z-]*)\)|([A-Za-z][A-Za-z-]*)\s*:)/;
// session_ledger.mes._token: the subject key and every other ledger token.
const LEDGER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}$/;
const HEAD_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
// Git emits lowercase hex; normalize so an uppercase input keys the same subject.
const normalizeHeadSha = (value) => (HEAD_SHA_RE.test(String(value || '')) ? String(value).toLowerCase() : null);

// Resolver provenance -> session_ledger.mes SOURCES. Defaults are the implicit
// fill MES may later replace; everything else is an explicit source that wins.
const DEFAULT_SOURCES = Object.freeze({ registry: 'registry', 'committed-seed': 'static-default' });
const EXPLICIT_SOURCES = Object.freeze({ 'env-pin': 'env', env: 'env', 'non-blocking-config': 'env' });

// Local remediation launch class -> governed registry class (the resolver's
// class, or the requested corp class, which MES keeps but never chooses).
const REMEDIATION_REGISTRY_CLASSES = Object.freeze({
  codex: 'remediator-codex',
  'remediator-codex': 'remediator-codex',
  'remediator-codex-corp': 'remediator-codex-corp',
  'claude-code': 'remediator-claude',
  'remediator-claude': 'remediator-claude',
  gemini: 'remediator-gemini',
});

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/** Unified diff -> line counts and the distinct changed paths (kept in memory only). */
export function mesDiffStats(diff) {
  if (typeof diff !== 'string') return null;
  let addedLines = 0;
  let deletedLines = 0;
  const paths = new Set();
  let inHunk = false;
  let oldPath = null;
  let newPath = null;
  let gitPath = null;
  const flush = () => {
    const chosen = newPath && newPath !== '/dev/null' ? newPath : oldPath && oldPath !== '/dev/null' ? oldPath : gitPath;
    if (chosen) paths.add(chosen);
    oldPath = newPath = gitPath = null;
  };
  let open = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (open) flush();
      open = true;
      inHunk = false;
      const index = line.lastIndexOf(' b/');
      gitPath = index > 0 ? line.slice(index + 3) : null;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      oldPath = line.slice(4).replace(/^a\//, '');
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      newPath = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) addedLines += 1;
    else if (line.startsWith('-')) deletedLines += 1;
  }
  if (open) flush();
  return { addedLines, deletedLines, paths: [...paths] };
}

// cwp_dispatch.scope_envelope.split_pattern: noncanonical input is invalid.
function canonicalRelative(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\s\\\x00-\x1f:]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts;
}

function componentRegExp(glob) {
  // fnmatch.fnmatchcase for one component: *, ?, [seq] and [!seq]; no braces.
  if (glob.includes('{') || glob.includes('}')) return null;
  if (glob.includes('**') && glob !== '**') return null;
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const end = glob.indexOf(']', index + 2);
      if (end < 0) return null;
      let body = glob.slice(index + 1, end);
      if (body.includes('[')) return null;
      body = body.replace(/\\/g, '\\\\');
      body = body.startsWith('!') ? `^${body.slice(1)}` : body.replace(/^\^/, '\\^');
      source += `[${body}]`;
      index = end;
    } else if (char === ']') return null;
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's');
}

function compileRepoPattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const separator = pattern.indexOf(':');
  if (separator <= 0) return null;
  const repoName = pattern.slice(0, separator);
  if (repoName !== '*' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repoName)) return null;
  const globs = canonicalRelative(pattern.slice(separator + 1).toLowerCase());
  if (!globs) return null;
  const compiled = globs.map((glob) => (glob === '**' ? '**' : componentRegExp(glob)));
  if (compiled.includes(null)) return null;
  return { repoName: repoName === '*' ? null : repoName.toLowerCase(), compiled };
}

function matchComponents(parts, compiled) {
  const memo = new Map();
  const match = (i, j) => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (j === compiled.length) result = i === parts.length;
    else if (compiled[j] === '**') result = match(i, j + 1) || (i < parts.length && match(i + 1, j));
    else result = i < parts.length && compiled[j].test(parts[i]) && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/**
 * Count changed paths matching `worker_pool.scope.restricted_paths`
 * (`repo:glob`, `*:` for any repo). Any unknown input yields null, never 0.
 * The risk-class policy's path classes declare no paths today, so they add no
 * patterns (the same contract cwp_dispatch.mes_signals.review_signals reads).
 */
export function mesRiskPathCount(paths, patterns, repo) {
  const repoName = typeof repo === 'string' && repo ? repo.split('/').pop().toLowerCase() : null;
  if (!repoName || !Array.isArray(paths) || !Array.isArray(patterns)) return null;
  const compiled = patterns.map(compileRepoPattern);
  if (compiled.includes(null)) return null;
  const touched = new Set();
  for (const path of paths) {
    const parts = canonicalRelative(String(path).toLowerCase());
    if (!parts) return null;
    if (compiled.some((pattern) => (pattern.repoName === null || pattern.repoName === repoName)
      && matchComponents(parts, pattern.compiled))) touched.add(parts.join('/'));
  }
  return touched.size;
}

export function mesChangeKind(title) {
  const match = typeof title === 'string' ? TITLE_KIND_RE.exec(title) : null;
  const token = match ? String(match[1] || match[2]).trim().toLowerCase() : '';
  const kind = CHANGE_KIND_ALIASES[token] || token;
  return CHANGE_KIND_VALUES.has(kind) ? kind : null;
}

export function mesBuilderPrefix(title) {
  const match = typeof title === 'string' ? /^\s*\[([^\]]+)\]/.exec(title) : null;
  return match && BUILDER_PREFIXES.has(match[1]) ? match[1] : null;
}

/** Review signals from the diff under review and the PR title (never stored). */
export function reviewMesSignals({ diff, title = null, repo = null, restrictedPatterns = null } = {}) {
  const stats = mesDiffStats(diff);
  const riskPathCount = stats ? mesRiskPathCount(stats.paths, restrictedPatterns, repo) : null;
  return {
    diff_lines: stats ? stats.addedLines + stats.deletedLines : null,
    file_count: stats ? stats.paths.length : null,
    risk_path_count: riskPathCount,
    risk_paths_touched: riskPathCount === null ? null : riskPathCount > 0,
    change_kind: mesChangeKind(title),
    builder_prefix: mesBuilderPrefix(title),
  };
}

/** Remediation signals: finding counts, diff size and rounds against the budget. */
export function remediationMesSignals({
  blockingFindings = null, nonBlockingFindings = null, addedLines = null, deletedLines = null,
  fileCount = null, roundsSoFar = null, roundBudget = null,
} = {}) {
  const added = count(addedLines);
  const deleted = count(deletedLines);
  const rounds = count(roundsSoFar);
  const budget = count(roundBudget);
  return {
    blocking_findings: count(blockingFindings),
    nonblocking_findings: count(nonBlockingFindings),
    diff_lines: added === null || deleted === null ? null : added + deleted,
    file_count: count(fileCount),
    rounds_so_far: rounds,
    round_budget: budget,
    round_fraction: rounds !== null && budget ? rounds / budget : null,
  };
}

/**
 * The execution the resolver chose, as MES `actual`. Returns null when the
 * provenance has no ledger source, so an unknown origin is never recorded as a
 * default. `reviewerArm` marks pins that came from the OSG reviewer arm.
 */
export function mesActualExecution({
  workerClass, model = null, effort = null, modelSource = null, effortSource = null,
  source = null, reviewerArm = false,
} = {}) {
  if (typeof workerClass !== 'string' || !LEDGER_TOKEN_RE.test(workerClass)) return null;
  const explicit = [modelSource, effortSource].map((value) => EXPLICIT_SOURCES[value]).find(Boolean);
  const mapped = source === 'osg-remediator' ? 'osg-apply'
    : explicit ? (reviewerArm ? 'reviewerArm' : explicit)
      : DEFAULT_SOURCES[modelSource] || null;
  if (!mapped) return null;
  return { workerClass, model: model || null, effort: effort || null, source: mapped };
}

function isTestContext(env) {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT
    || env?.NODE_TEST_CONTEXT || env?.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT);
}

function runDecide(execFileImpl, hqBin, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Belt and braces: an injected or misbehaving exec cannot outlive the bound.
    const timer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
    try {
      const child = execFileImpl(hqBin, args, {
        env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
      }, (error, stdout) => {
        if (error?.code === 'ENOENT') return finish({ reason: 'cli-absent' });
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return finish({ reason: 'garbage-output' });
        if (error && (error.killed || error.signal)) return finish({ reason: 'timeout' });
        finish({ stdout: String(stdout ?? '') });
      });
      child?.stdin?.end?.();
    } catch (error) {
      finish({ reason: error?.code === 'ENOENT' ? 'cli-absent' : 'exec-error' });
    }
  });
}

function parseDecision(stdout) {
  const line = String(stdout).trim().split('\n').pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.schemaVersion === 1 ? parsed : null;
}

/**
 * Run `hq mes decide --record --json` for one request. Never throws. Resolves to
 * `{ recorded, reason, decisionId, attempt, decision }`; `decision` is the CLI's
 * parsed response and is evidence only (shadow never applies it).
 */
export async function recordMesDecision(request, {
  env = process.env,
  execFileImpl = null,
  timeoutMs = MES_DECIDE_TIMEOUT_MS,
  maxAttempts = MES_MAX_ATTEMPTS,
  nowMs = Date.now,
} = {}) {
  if (!execFileImpl && isTestContext(env)) return { recorded: false, reason: 'test-context' };
  const exec = execFileImpl || execFile;
  const hqBin = String(env?.HQ_BIN || '').trim() || 'hq';
  const deadline = nowMs() + timeoutMs;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = deadline - nowMs();
      if (remaining <= 0) return { recorded: false, reason: 'timeout', attempt };
      const payload = JSON.stringify({ ...request, attempt });
      const outcome = await runDecide(exec, hqBin, ['mes', 'decide', '--record', '--json', '--request-json', payload],
        { env, timeoutMs: remaining });
      if (outcome.reason) return { recorded: false, reason: outcome.reason, attempt };
      const decision = parseDecision(outcome.stdout);
      if (!decision) return { recorded: false, reason: 'garbage-output', attempt };
      if (decision.recorded === true && typeof decision.decisionId === 'string') {
        return { recorded: true, reason: decision.reason ?? null, decisionId: decision.decisionId, attempt, decision };
      }
      if (decision.recordError === 'duplicate') continue;
      const reason = [decision.error, decision.recordError].find((value) => typeof value === 'string'
        && LEDGER_TOKEN_RE.test(value)) || 'not-recorded';
      return { recorded: false, reason, attempt, decision };
    }
    return { recorded: false, reason: 'attempts-exhausted', attempt: maxAttempts };
  } catch {
    return { recorded: false, reason: 'exception' };
  }
}

function logOutcome(log, workKind, outcome) {
  try {
    if (outcome.recorded) {
      const message = `[mes-shadow] ${workKind} decision recorded decision=${outcome.decisionId} attempt=${outcome.attempt}`;
      if (log === console) console.error(message);
      else log.info?.(message);
    } else {
      log.warn?.(`[mes-shadow] ${workKind} decision not recorded reason=${outcome.reason}; execution unchanged`);
    }
  } catch {
    // Logging must not turn a shadow failure into a review failure.
  }
}

function subjectKey(repo, prNumber, suffix) {
  const key = `${repo}/pr/${prNumber}/${suffix}`;
  return Number.isInteger(prNumber) && prNumber > 0 && LEDGER_TOKEN_RE.test(key) ? key : null;
}

async function readRestrictedPathPatterns() {
  try {
    const { getConfig } = await import('./config-loader.mjs');
    const patterns = getConfig('worker_pool.scope.restricted_paths', null);
    return Array.isArray(patterns) ? patterns : null;
  } catch {
    return null;
  }
}

async function recordShadow(workKind, build, { log, ...options }) {
  // Offline suites never reach a host CLI or ledger; they inject execFileImpl.
  if (!options.execFileImpl && isTestContext(options.env)) return { recorded: false, reason: 'test-context' };
  let outcome;
  try {
    const request = await build();
    outcome = request.reason ? { recorded: false, reason: request.reason }
      : await recordMesDecision(request, options);
  } catch {
    outcome = { recorded: false, reason: 'exception' };
  }
  logOutcome(log, workKind, outcome);
  return outcome;
}

/**
 * Review pass: one decision per reviewed head. `execution` is the object the
 * reviewer resolver returned; it is read, never modified.
 */
export function recordReviewMesShadow({
  harness, execution, repo, prNumber, headSha = null, title = null, diff,
  reviewerArm = false, restrictedPatterns, env = process.env, execFileImpl = null,
  timeoutMs, log = console,
} = {}) {
  return recordShadow('review', async () => {
    const actual = mesActualExecution({ workerClass: `${harness}-reviewer`, model: execution?.model,
      effort: execution?.effort, modelSource: execution?.modelSource, effortSource: execution?.effortSource,
      reviewerArm });
    const head = normalizeHeadSha(headSha);
    const key = head && subjectKey(repo, Number(prNumber), `review/${head}`);
    if (!actual) return { reason: 'unmapped-source' };
    if (!key) return { reason: 'invalid-subject' };
    const patterns = restrictedPatterns === undefined ? await readRestrictedPathPatterns() : restrictedPatterns;
    return {
      workKind: 'review', subjectKey: key, prNumber: Number(prNumber), headSha: head,
      signals: reviewMesSignals({ diff, title, repo, restrictedPatterns: patterns }), actual,
    };
  }, { env, execFileImpl, timeoutMs, log });
}

async function readWorkspaceDiffStats({ workspaceDir, baseBranch, env, execFileImpl, timeoutMs }) {
  if (!workspaceDir || !baseBranch || (!execFileImpl && isTestContext(env))) return null;
  // Commit-to-commit numstat with --no-optional-locks: the just-spawned worker
  // owns the index, and this read must never take its lock.
  const output = await new Promise((resolve) => {
    try {
      (execFileImpl || execFile)('git', ['--no-optional-locks', '-C', workspaceDir, 'diff', '--numstat',
        `origin/${baseBranch}...HEAD`], { env, timeout: timeoutMs, killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout ?? '')));
    } catch {
      resolve(null);
    }
  });
  if (output === null) return null;
  let addedLines = 0;
  let deletedLines = 0;
  let fileCount = 0;
  let linesKnown = true;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split('\t');
    fileCount += 1;
    // Binary files report '-'; their line count is unknown, not zero. The
    // file itself still counts.
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) {
      linesKnown = false;
      continue;
    }
    addedLines += Number(added);
    deletedLines += Number(deleted);
  }
  return linesKnown ? { addedLines, deletedLines, fileCount } : { addedLines: null, deletedLines: null, fileCount };
}

async function classifyReviewFindings(reviewBody) {
  const { classifyFollowUpCriticality } = await import('./follow-up-jobs.mjs');
  const classification = classifyFollowUpCriticality(reviewBody);
  return {
    blockingFindings: classification.blockingFindingState === 'known' ? classification.blockingFindingCount : null,
    nonBlockingFindings: classification.nonBlockingFindingState === 'known'
      ? classification.nonBlockingFindingCount : null,
  };
}

/**
 * Local remediation round: one decision per round. `worker` is the spawned
 * worker descriptor, which carries the resolver's modelResolution unchanged;
 * `modelResolution` is the request's resolution, used whole only when the
 * descriptor carries no resolved model (fields are never mixed across the two).
 * The caller does not await this: the worker is already running, and the
 * spawned-job record must not wait on MES. The git read is bounded by
 * GIT_NUMSTAT_TIMEOUT_MS and the CLI by `timeoutMs`. Remediation launched
 * through hq dispatch is recorded by the dispatch-path hook (MES-05), not here.
 */
export function recordRemediationMesShadow({
  job, workerClass, worker, modelResolution = null, workspaceDir = null, env = process.env, execFileImpl = null,
  classifyFindingsImpl = classifyReviewFindings, timeoutMs = MES_DECIDE_TIMEOUT_MS, log = console,
} = {}) {
  return recordShadow('remediation', async () => {
    const registryClass = REMEDIATION_REGISTRY_CLASSES[workerClass] || null;
    const resolution = worker?.resolvedModel ? worker : modelResolution;
    const actual = registryClass && mesActualExecution({ workerClass: registryClass, model: resolution?.resolvedModel,
      effort: resolution?.resolvedReasoningLevel, modelSource: resolution?.modelSource,
      effortSource: resolution?.reasoningSource, source: resolution?.source });
    const round = Number(job?.remediationPlan?.currentRound);
    const key = Number.isInteger(round) && round > 0 && subjectKey(job?.repo, Number(job?.prNumber), `remediation/round-${round}`);
    if (!actual) return { reason: registryClass ? 'unmapped-source' : 'unmapped-worker-class' };
    if (!key) return { reason: 'invalid-subject' };
    const findings = await classifyFindingsImpl(job?.reviewBody).catch(() => ({}));
    const diff = await readWorkspaceDiffStats({ workspaceDir, baseBranch: job?.baseBranch, env, execFileImpl,
      timeoutMs: GIT_NUMSTAT_TIMEOUT_MS });
    const head = normalizeHeadSha(job?.revisionRef);
    return {
      workKind: 'remediation', subjectKey: key, prNumber: Number(job.prNumber), headSha: head,
      signals: remediationMesSignals({ ...findings, ...diff, roundsSoFar: round - 1,
        roundBudget: Number(job?.remediationPlan?.maxRounds) }),
      actual,
    };
  }, { env, execFileImpl, timeoutMs, log });
}
