import { readFileSync } from 'node:fs';

// Public hq api spec examples. Clone so negative mutations cannot contaminate
// other accounts or later tests. All provider/account floors stay independent.
const artifact = JSON.parse(readFileSync(new URL('../fixtures/producer-contracts/reserve-floors.json', import.meta.url)));
export function exportedReserveFloors(scenario = 'repaired-disabled') {
  const example = artifact.examples.find(row => row.scenario === scenario);
  if (!example) throw new Error(`missing public reserve-floors example: ${scenario}`);
  return structuredClone(example.value);
}
