#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deliverHammerClosingComment } from '../src/ama/hammer-closing-comment.mjs';
import { hammerTokenSession } from '../src/hammer-token.mjs';
import { meteredExecFile } from '../src/metered-gh.mjs';
import { withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

const [repo, pr, hqRoot, ...recoveryArgs] = process.argv.slice(2);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const env = { ...process.env };
if (env.TMPDIR && !existsSync(env.TMPDIR)) delete env.TMPDIR;
// An unavailable closing comment must not emit a pre-merge failure audit.
const ghOptions = { env, hammerToken: true, reportAuthFailure() {}, timeout: 30_000,
  killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 };
try {
  const [mode, launchRequestId, runId] = recoveryArgs;
  const recovery = mode === '--recover' && recoveryArgs.length === 3 ? { launchRequestId, runId } : undefined;
  if (!/^[1-9]\d*$/.test(pr || '') || !hqRoot?.startsWith('/') || (recoveryArgs.length && !recovery)) {
    throw new Error('usage: hammer-closing-comment.mjs OWNER/REPO PR HQ_ROOT [--recover LAUNCH_ID RUN_ID]');
  }
  const github = async args => {
    if (!hammerTokenSession(ghOptions).managed) throw new Error('closing-comment-author-unconfirmed');
    const { stdout } = await meteredExecFile(execute, 'gh', args, {
      ...ghOptions, retryAuthFailure: args[2] !== 'POST',
    });
    return JSON.parse(stdout);
  };
  const result = await withGitHubBudgetScope({}, () => deliverHammerClosingComment({
    repo, prNumber: Number(pr), hqRoot, rootDir, env, recovery,
  }, { github }));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`hammer-closing-comment: ${error.message}`);
  process.exitCode = 1;
}
