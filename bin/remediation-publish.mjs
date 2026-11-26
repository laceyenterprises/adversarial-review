#!/usr/bin/env node
// Production remediation publication boundary; no CI job or repository hook.
import { parseArgs } from 'node:util';
import { unlinkSync } from 'node:fs';
import { writeFileAtomic } from '../src/atomic-write.mjs';
import { publicationBlocker, publishRemediation, runRemediationPublicationCommand } from '../src/remediation-publication.mjs';
import { OWNER_AUTH_HOLD } from '../src/remediation-owner-auth.mjs';
import { redactGithubAuthRecoveryDetail } from '../src/github-auth-recovery.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

const { values } = parseArgs({ options: {
  'base-branch': { type: 'string' }, 'previous-head': { type: 'string' },
  repo: { type: 'string' }, pr: { type: 'string' },
  branch: { type: 'string' }, 'expected-remote-sha': { type: 'string' },
  'job-id': { type: 'string' }, 'expected-candidate': { type: 'string' },
  'failure-path': { type: 'string' }, 'push-command': { type: 'string' },
  'worker-class': { type: 'string' }, 'reviewer-model': { type: 'string' }, 'reviewer-role': { type: 'string' },
  'requires-workflow-push': { type: 'boolean' },
} });
const previousHead = values['previous-head'];
const expectedRemoteSha = values['expected-remote-sha'] || previousHead;
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
const execFileImpl = (command, args, options) =>
  runRemediationPublicationCommand(command, args, { ...options, signal: cancellation.signal });
// Capture the tip before publication. A checkout move during error handling
// must never change which source the sidecar names.
let localCommit = null;
try {
  const { stdout } = await execFileImpl('git', ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD^{commit}'],
    { timeout: loadAwareTimeoutMs(30_000) });
  localCommit = stdout.trim();
} catch { /* No verified local tip. */ }
try {
  const result = await publishRemediation({ baseBranch: values['base-branch'], previousHead,
    repo: values.repo, prNumber: values.pr, branch: values.branch, expectedRemoteSha,
    expectedCandidate: values['expected-candidate'] || localCommit,
    pushCommand: values['push-command'], workerClass: values['worker-class'], reviewerModel: values['reviewer-model'],
    reviewerRole: values['reviewer-role'],
    requiresWorkflowPush: values['requires-workflow-push'], execFileImpl });
  if (values['failure-path']) {
    try { unlinkSync(values['failure-path']); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = String(error.code || '').startsWith('remediation-') ? error.code : 'remediation-publication-unproven';
  const blocker = publicationBlocker({ code, localCommit, expectedRemoteSha });
  const message = redactGithubAuthRecoveryDetail(String(error.message || blocker.finding));
  const failure = { localCommit, code, message, blocker,
    jobId: values['job-id'], repo: values.repo, prNumber: Number(values.pr) || undefined,
    previousHead, expectedRemoteSha, refusedAt: new Date().toISOString(),
    ...(error.code === OWNER_AUTH_HOLD && { owner: error.owner, capability: error.capability, reason: error.reason }) };
  if (values['failure-path']) writeFileAtomic(values['failure-path'], JSON.stringify(failure));
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
