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
  const body = process.env.HAM_AUDIT_COMMENT_BODY;
  if (body !== undefined) {
    const heads = body.split(/\r?\n/).map(line => line.trim())
      .filter(line => line.startsWith('HAM-Validated-Head:'));
    if (heads.length !== 1 || heads[0] !== `HAM-Validated-Head: ${head}`) {
      throw new Error('exported audit comment must match the exact head');
    }
    if (!claim.auditComment || typeof claim.auditComment !== 'object' || Array.isArray(claim.auditComment)) {
      throw new Error('claim must contain an auditComment object');
    }
    claim.auditComment.body = body;
  }
  claim.commit.sha = head;
  writeFileSync(path, JSON.stringify(claim, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`claim-build-failed: ${error.message}\n`);
  process.exitCode = 1;
}
