import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { simulate } from './simulator.mjs';
import { invariants } from './oracle.mjs';

export const library = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));
export async function report() {
  const rows = [];
  for (const scenario of library.scenarios) {
    for (const load of [1, 3, 6]) {
      const result = await simulate(scenario, { load });
      rows.push({ id: scenario.id, load, failed: result.failed, unmet: result.unmet, terminal: result.terminal });
    }
  }
  return { schemaVersion: 1, seed: 17, invariants, requirementsSha256: library.sourceSha256,
    implementationSha256: Object.fromEntries(['ledger-fold', 'eligibility', 'executor'].map(name => [name,
      createHash('sha256').update(readFileSync(new URL(`../../src/finalization/${name}.mjs`, import.meta.url))).digest('hex')])), rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await report();
  if (process.argv.includes('--write-baseline')) {
    const { rows, ...metadata } = result;
    const header = JSON.stringify(metadata, null, 2).slice(0, -2);
    writeFileSync(new URL('./baseline.json', import.meta.url),
      `${header},\n  "rows": [\n${rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`);
  }
  else console.log(JSON.stringify(result, null, 2));
}
