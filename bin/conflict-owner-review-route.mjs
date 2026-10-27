#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { conflictOwnerReviewRoute } from '../src/conflict-owner-review-route.mjs';

try {
  const { values } = parseArgs({ options: {
    'root-dir': { type: 'string' }, repo: { type: 'string' },
    pr: { type: 'string' }, 'head-sha': { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (!values['root-dir'] || !/^[\w.-]+\/[\w.-]+$/.test(values.repo || '')
    || !/^[1-9]\d*$/.test(values.pr || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(values['head-sha'] || '')) {
    throw new Error('root-dir, repo, positive pr and head-sha required');
  }
  console.log(JSON.stringify(conflictOwnerReviewRoute({ rootDir: values['root-dir'],
    repo: values.repo, prNumber: Number(values.pr), headSha: values['head-sha'] })));
} catch {
  // Unavailable evidence must not be confused with an unreviewed PR.
  console.error('conflict-owner review state unavailable');
  process.exitCode = 1;
}
