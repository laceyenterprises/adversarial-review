#!/usr/bin/env node
// Bind authored finding/documentation claims to the head established by phases.
import { readFileSync, writeFileSync } from 'node:fs';

try {
  const path = process.argv[2];
  const head = process.env.POST_REMEDIATION_SHA;
  if (process.argv.length !== 3 || !/^[a-f0-9]{40}$/i.test(head || '')) {
    throw new Error('expected claim file and exported exact head');
  }
  const claim = JSON.parse(readFileSync(path, 'utf8'));
  if (!claim.commit || typeof claim.commit !== 'object' || Array.isArray(claim.commit)) {
    throw new Error('claim must contain a commit object');
  }
  claim.commit.sha = head;
  writeFileSync(path, JSON.stringify(claim, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`claim-build-failed: ${error.message}\n`);
  process.exitCode = 1;
}
