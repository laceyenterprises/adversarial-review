// Public serializer examples shipped inside the installed SDK release.
// No producer checkout, private definitions or runtime state is consulted.
import { readFileSync } from 'node:fs';
import { parseProducerContracts } from '@agent-os/app-sdk';

export const dispatchStatusExamples = parseProducerContracts(readFileSync(
  new URL('./producer-contracts-v1.json', import.meta.resolve('@agent-os/app-sdk')), 'utf8',
)).producers['dispatch-status'].examples;
