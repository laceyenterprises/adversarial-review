#!/usr/bin/env node
// CLOSERGATES-01: read the HAM predicate's exact-head inputs into $HAM_RUN_DIR
// (pr-after, reviews, protection, timeline, commit) for $POST_REMEDIATION_SHA.
// Exit 0: every input read. Exit 75: a transient gate outlasted the closure
// budget; a validated, published head leaves a closure-resume receipt so the
// next launch on that head runs only the closure gates. Exit 1: a definitive
// refusal with its named reason. Nothing unreadable is ever written as passing.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPredicateInputs } from '../src/ama/predicate-inputs.mjs';
import { recordClosureResume } from '../src/ama/closure-resume.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

const env = process.env;
const binDir = dirname(fileURLToPath(import.meta.url));
const node = env.HAM_NODE_BIN || process.execPath;
// The same deployed readers the procedure's ham_pr and ham_gh use.
function child(script, args) {
  const result = spawnSync(node, [join(binDir, script), ...args], {
    env, encoding: 'utf8', timeout: loadAwareTimeoutMs(60_000), killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout;
  const detail = String(result.stderr || result.error?.message || `${script} exited ${result.status ?? result.signal}`);
  throw Object.assign(new Error(detail.slice(-2000)), { status: result.status, signal: result.signal });
}

const result = collectPredicateInputs({
  repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER, headSha: env.POST_REMEDIATION_SHA, runDir: env.HAM_RUN_DIR,
  readPr: args => child('hammer-pr-read.mjs', [env.HAM_REPO, env.HAM_PR_NUMBER, ...args]),
  readApi: args => child('metered-gh.mjs', ['exec-hammer', 'api', ...args]),
});
if (result.ok) {
  process.stderr.write(`HAM predicate inputs read: ${result.files.join(', ')}\n`);
} else if (result.kind === 'exhausted') {
  let receipt = null;
  try { receipt = recordClosureResume({ env, gate: result.gate, detail: result.detail }); }
  catch { process.stderr.write('HAM closure-resume receipt unavailable\n'); }
  if (!receipt) reportHammerEarlyFailure(result.reason, { env, headSha: env.POST_REMEDIATION_SHA });
  process.stderr.write(`HAM closure gate ${result.gate}: transient read failures outlasted the closure budget.\n`
    + (receipt ? `HAM closure-resume receipt recorded for ${env.POST_REMEDIATION_SHA}: the next launch on this head runs only the closure gates and the merge.\n` : '')
    + `HAM next: release the lease and stop with retryable ${result.reason}; not final for this head.\n`);
  process.exitCode = 75;
} else {
  reportHammerEarlyFailure(result.reason, { env, headSha: env.POST_REMEDIATION_SHA, final: true });
  process.stderr.write(`HAM closure gate ${result.gate} refused: ${result.reason}\n${String(result.detail || '').slice(-500)}\n`
    + `HAM next: release the lease and stop with ${result.reason}.\n`);
  process.exitCode = 1;
}
