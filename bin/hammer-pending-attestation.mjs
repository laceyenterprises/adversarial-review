#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pendingAttestationBody, recordPendingAttestation } from '../src/ama/hammer-pending-attestation.mjs';

const [command, hqRoot, repo, prNumber, baseHead, validatedHead, identityPath, rangePath, total, blocking, nonBlocking] = process.argv.slice(2);
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
const common = { hqRoot, repo, prNumber: Number(prNumber), identity };
if (command === 'read') {
  process.stdout.write(pendingAttestationBody({ ...common, reviewedHead: baseHead, currentHead: validatedHead }));
} else if (command === 'record') {
  recordPendingAttestation({ ...common, baseHead, validatedHead,
    range: JSON.parse(readFileSync(rangePath, 'utf8')),
    counts: { total: Number(total), blocking: Number(blocking), nonBlocking: Number(nonBlocking) } });
} else {
  throw new Error('expected pending attestation read or record');
}
