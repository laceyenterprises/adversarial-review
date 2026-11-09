// Offline build tool. Only stable IDs cross the repository boundary, never
// recorded incidents, operator prose, account names or production payloads.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rowRecipes, profiles } from './recipes.mjs';

export function generate(source) {
  const input = JSON.parse(source);
  const ids = new Set();
  const scenarios = [];
  for (const row of input.requirements) {
    if (ids.has(row.id) || !/^R-\d+$/.test(row.id) || !/^S-\d+$/.test(row.scenarioId)) throw Error('invalid requirement identity');
    ids.add(row.id);
    const recipes = rowRecipes[row.id];
    if (!recipes?.length) throw Error(`unmapped requirement ${row.id}`);
    for (const profile of recipes) {
      if (!Object.hasOwn(profiles, profile)) throw Error(`unknown profile ${profile}`);
      scenarios.push({ id: `${row.scenarioId}-${profile}`, requirements: [row.id], profile });
    }
  }
  for (const parked of input.parkedPRs) {
    if (!Number.isSafeInteger(parked.pr) || !['agent-os', 'adversarial-review'].includes(parked.repo)) throw Error('invalid parked identity');
    if (!Array.isArray(parked.requirementIds) || !parked.requirementIds.length) throw Error(`parked PR ${parked.pr} requires a non-empty requirementIds array`);
    for (const id of parked.requirementIds) if (!ids.has(id)) throw Error(`unknown parked requirement ${id}`);
    scenarios.push({ id: `SEV0-2026-11-02-${parked.repo}-PR-${parked.pr}`, requirements: parked.requirementIds,
      profile: rowRecipes[parked.requirementIds[0]][0] });
  }
  return { schemaVersion: 1, specRef: input.specRef, sourceSha256: createHash('sha256').update(source).digest('hex'),
    requirementIds: [...ids], scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error('usage: node test/sim/generate.mjs /path/to/requirements.json');
  writeFileSync(new URL('./scenarios.json', import.meta.url), `${JSON.stringify(generate(readFileSync(process.argv[2], 'utf8')), null, 2)}\n`);
}
