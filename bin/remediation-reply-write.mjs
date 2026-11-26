#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../src/atomic-write.mjs';
import { validateRemediationReply } from '../src/follow-up-jobs.mjs';
import { requireWorkerReplyContext } from '../src/remediation-reply-paths.mjs';
import { redactAndCap } from '../src/adapters/comms/github-pr-comments/redaction.mjs';

function writeReply() {
  const { values } = parseArgs({ options: {
    'reply-path': { type: 'string' },
    'job-id': { type: 'string' },
    repo: { type: 'string' },
    pr: { type: 'string' },
  } });
  const { replyPath } = requireWorkerReplyContext({ replyPath: values['reply-path'] });
  const expectedJob = { jobId: values['job-id'], repo: values.repo, prNumber: Number(values.pr) };
  if (!expectedJob.jobId || !expectedJob.repo || !Number.isSafeInteger(expectedJob.prNumber) || expectedJob.prNumber < 1) {
    throw new Error('--job-id, --repo and a positive --pr are required.');
  }
  const draft = readFileSync(0, 'utf8');
  let reply;
  try {
    reply = JSON.parse(draft);
  } catch {
    throw new Error('Draft must be one valid JSON object. Check JSON syntax and quoting.');
  }
  validateRemediationReply(reply, { expectedJob });
  // Retries can reuse the job's reply path. Only a valid draft replaces it.
  writeFileAtomic(replyPath, draft);
}

try {
  writeReply();
} catch (error) {
  const message = error.code || error.message;
  process.stderr.write(`Remediation reply not written: ${redactAndCap(message.replace(/\s+/g, ' '), 400)}\n`);
  process.exitCode = 1;
}
