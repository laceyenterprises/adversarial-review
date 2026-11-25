#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { meteredExecFile } from '../src/metered-gh.mjs';
import { reportHammerProgress } from '../src/ama/hammer-progress.mjs';
import { awaitThrottleIfNeeded, recordResponseRateLimit, recordRateLimitedCall, withGitHubBudgetScope, isGitHubRateLimitError, rateLimitErrorObservation } from '../src/rate-limit-throttle.mjs';

function isPrMerge(argv) {
  // Skip repository options without mistaking option values or another
  // command's positional arguments for a merge subcommand.
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '-R' || arg === '--repo') index += 2;
    else if (arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2)) index += 1;
    else break;
  }
  return argv[index] === 'pr' && argv[index + 1] === 'merge';
}

const [action, ...args] = process.argv.slice(2);
if (action === 'wait' || action === 'record' || action === 'limited' || action === 'admit') {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  // Every bridge action takes an array. Admission returns one result object,
  // so reject unsupported batches before processing anything or emitting output.
  if (!Array.isArray(payload) || (action === 'admit' && payload.length !== 1)) {
    process.stderr.write(`${action} requires ${action === 'admit' ? 'exactly one payload item' : 'an array payload'}\n`);
    process.exitCode = 1;
  } else {
    const recorded = [];
    for (const item of payload) {
      if (action === 'admit') {
        try {
          await withGitHubBudgetScope({}, () => awaitThrottleIfNeeded(item.resource, item.credential));
          process.stdout.write(JSON.stringify({ deferred: false }));
        } catch (err) {
          if (!err.budgetDeferred) throw err;
          process.stdout.write(JSON.stringify({ deferred: true, observation: err.observation }));
        }
      } else if (action === 'wait') await awaitThrottleIfNeeded(item.resource || item, item.credential);
      else if (action === 'limited') await recordRateLimitedCall(item.resource || item, item.credential);
      else recorded.push(await recordResponseRateLimit(item));
    }
    if (action === 'record') process.stdout.write(JSON.stringify(recorded));
  }
} else if (action === 'exec' || action === 'exec-hammer' || action === 'exec-git') {
  const hammerMerge = action === 'exec-hammer' && isPrMerge(args);
  const writerEvidence = hammerMerge && process.env.HAM_MERGE_TRANSPORT_EVIDENCE;
  const forcedRefresh = hammerMerge && process.env.HAM_MERGE_FORCE_CREDENTIAL_REFRESH === '1';
  delete process.env.HAM_MERGE_TRANSPORT_EVIDENCE;
  let spawnedAt;
  function recordWriterEvidence(value) {
    if (writerEvidence) {
      try { writeFileSync(writerEvidence, JSON.stringify({ value, spawnedAt }), { mode: 0o600 }); }
      catch { /* Missing evidence leaves the writer outcome unknown. */ }
    }
  }
  let authRejected = false;
  let terminationSignal;
  let terminationTimer;
  const execute = (command, argv, options) => new Promise((resolve, reject) => {
    const child = execFile(command, argv, options, (err, stdout, stderr) => {
      for (const [signal, cancel] of cancellations) process.removeListener(signal, cancel);
      clearTimeout(terminationTimer);
      // A normal gh exit with the explicit HTTP rejection is separate from
      // preparation failures and interrupted or otherwise ambiguous transport.
      authRejected = hammerMerge && spawnedAt !== undefined && err?.code === 1 && !stdout.trim()
        && /(?:^|\n)HTTP(?:\/\S+)? 401:?[ \t]+(?:Bad credentials|Unauthorized)(?:[ \t]+\(https:\/\/[^\r\n]+\))?$/im.test(stderr.trimEnd());
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (hammerMerge && command === 'gh' && isPrMerge(argv)) {
      child.once('spawn', () => {
        spawnedAt = performance.timeOrigin + performance.now();
        recordWriterEvidence('transport');
        reportHammerProgress('merge-attempted');
      });
    }
    const cancellations = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
      // Preserve the interruption cause even though cleanup escalates to SIGKILL.
      terminationSignal ||= signal;
      child.kill(action === 'exec-git' ? signal : 'SIGKILL');
      // Finish Git cleanup before the bounded shell's five-second escalation.
      if (action === 'exec-git' && !terminationTimer) terminationTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
    }]);
    for (const [signal, cancel] of cancellations) process.on(signal, cancel);
  });
  try {
    const result = await meteredExecFile(execute, action === 'exec-git' ? 'git' : 'gh', args, {
      ...(action !== 'exec' ? { hammerToken: true } : {}),
      // A new mutation requires fresh GitHub readback from the close procedure.
      ...(hammerMerge ? { retryAuthFailure: false,
        forceCredentialRefresh: forcedRefresh } : {}),
      // The bounded shell fetch owns its load-aware deadline and TERM cleanup.
      timeout: action === 'exec-git' && process.env.HAM_GIT_SYNC_BOUNDED === '1' ? 0 : 30_000,
      killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  } catch (err) {
    if (hammerMerge && !terminationSignal && !err.signal) {
      if (spawnedAt === undefined) recordWriterEvidence('not-spawned');
      else if (authRejected) recordWriterEvidence(forcedRefresh ? 'refreshed-credential-rejected' : 'stale-credential-rejected');
    }
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || (hammerMerge
      ? `gh pr merge did not return a usable result (${err.signal || err.code || err.status || 'unknown'}).\n`
      : err.message || ''));
    if (isGitHubRateLimitError(err)) {
      // Only transport evidence emits this protocol line; command prose cannot.
      process.stderr.write(`\ngithub-rate-limit: ${err.githubRateLimitKind || rateLimitErrorObservation(err)?.kind || 'deferred'}\n`);
    }
    const signalNumber = constants.signals[terminationSignal || err.signal];
    process.exitCode = signalNumber ? 128 + signalNumber : Number.isInteger(err.code) ? err.code : Number.isInteger(err.status) ? err.status : 1;
  }
} else {
  process.stderr.write('usage: metered-gh.mjs exec|exec-hammer <gh arguments> | exec-git <git arguments>\n');
  process.exitCode = 64;
}
