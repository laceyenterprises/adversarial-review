#!/usr/bin/env node
// Production remediation publication boundary; no CI job or repository hook.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { writeFileAtomic } from '../src/atomic-write.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';

const { values } = parseArgs({ options: {
  'base-branch': { type: 'string' }, 'previous-head': { type: 'string' },
  repo: { type: 'string' }, pr: { type: 'string' },
  branch: { type: 'string' }, 'expected-remote-sha': { type: 'string' },
  'failure-path': { type: 'string' }, 'push-command': { type: 'string' },
} });
try {
  const result = await publishRemediation({ baseBranch: values['base-branch'], previousHead: values['previous-head'],
    repo: values.repo, prNumber: values.pr, branch: values.branch, expectedRemoteSha: values['expected-remote-sha'] || values['previous-head'],
    pushCommand: values['push-command'] });
  if (values['failure-path']) {
    try { unlinkSync(values['failure-path']); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  let localCommit = null;
  try { localCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'],
    { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* Retain any available commit evidence. */ }
  const failure = { localCommit, code: String(error.code || '').startsWith('remediation-') ? error.code : 'remediation-publication-unproven', message: error.message,
    previousHead: values['previous-head'], refusedAt: new Date().toISOString() };
  if (values['failure-path']) writeFileAtomic(values['failure-path'], JSON.stringify(failure));
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.exitCode = 1;
}
