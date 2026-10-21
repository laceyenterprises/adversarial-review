// Opt-in publication evidence, never part of the standalone offline test run.
// Usage: node test/verify-identity-token-owner.mjs <registered-agent-os-config-src>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

assert.ok(process.argv[2], 'provide the registered companion agent-os-config/src path');
const owner = resolve(process.argv[2]);
for (const [local, upstream] of [
  ['../src/identity-token-pools.v1.json', 'agent_os_config/identity-token-pools.v1.json'],
  ['../src/identity-token-selection.v1.json', 'agent_os_core/identity-token-selection.v1.json'],
  ['./fixtures/identity-token-selection.v1.json', 'agent_os_core/tests/fixtures/identity-token-selection.v1.json'],
]) {
  assert.deepEqual(readFileSync(new URL(local, import.meta.url)), readFileSync(join(owner, upstream)));
}
const python = `
import copy, json, pathlib, sys
sys.path.insert(0, sys.argv[1])
from agent_os_core.identity_token_pools import read_identity_token_pools
from agent_os_core.identity_token_selection import select_account
vectors = json.loads((pathlib.Path(sys.argv[1]) / 'agent_os_core/tests/fixtures/identity-token-selection.v1.json').read_text())
def merge(base, patch):
    result = copy.deepcopy(base)
    for key, value in patch.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else copy.deepcopy(value)
    return result
outcomes = []
for case in vectors['cases']:
    inputs = merge(vectors['defaults'], case.get('patch', {}))
    try:
        outcome = {'result': select_account(read_identity_token_pools(inputs['oauth']), **inputs['request']).to_dict()}
    except ValueError as error:
        outcome = {'error': str(error)}
    outcomes.append({'name': case['name'], **outcome})
print(json.dumps(outcomes, allow_nan=False))
`;
const observed = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', python, owner], {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
}));
const published = JSON.parse(readFileSync(new URL('./fixtures/identity-token-outcomes.v1.json', import.meta.url)));
assert.deepEqual(observed, published.cases);
console.log(`Owner parity: ${observed.length} Python outcomes and all published vocabularies/vectors match.`);
