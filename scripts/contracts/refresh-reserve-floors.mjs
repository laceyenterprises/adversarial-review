// Refresh only public export examples; no producer checkout or runtime imports.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseProducerContracts } from '@agent-os/app-sdk';

const [input, producerRevision, ...extra] = process.argv.slice(2);
if (!input || !/^[a-f0-9]{40}$/i.test(producerRevision || '') || extra.length) {
  throw new Error('usage: node scripts/contracts/refresh-reserve-floors.mjs <public-export.json> <producer-revision>');
}
const bytes = readFileSync(input);
const bundle = parseProducerContracts(bytes.toString('utf8'));
const artifact = {
  contractVersion: bundle.contractVersion,
  exportCommand: bundle.exportCommand,
  producerRevision,
  exportSha256: createHash('sha256').update(bytes).digest('hex'),
  examples: bundle.producers['reserve-floors'].examples,
};
writeFileSync(new URL('../../test/fixtures/producer-contracts/reserve-floors.json', import.meta.url),
  `${JSON.stringify(artifact, null, 2)}\n`);
