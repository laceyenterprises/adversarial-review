// ONS-07 — the generated Node config validator agrees with the Python loader.
//
// fixtures/cfg-parity-cases.v1.json holds YAML inputs and the verdict the
// Python CFG loader returned for each (recorded offline with
// scripts/record-cfg-parity-cases.py). Both readers must accept the same
// documents with the same resolved values, and refuse the same documents at
// the same key: cascade order (code, module, top, local, env), unknown keys,
// leaf annotations, env coercion and merged-config semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import { CFG_JSON_SCHEMA, schemaV1 } from '../src/config-schema.mjs';
import { NODE_ONLY_ENUM_MEMBERS, NODE_ONLY_KEYS } from '../src/config-node-keys.mjs';

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/cfg-parity-cases.v1.json', import.meta.url), 'utf8'));

for (const { name, files, modules = [], env = {}, get = [], python } of cases) {
  test(`CFG parity: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-parity-'));
    try {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      const load = () => loadConfig({
        topPath: join(dir, 'config.yaml'), modulePaths: modules.map(file => join(dir, file)), env,
      });
      if (!python.ok) {
        assert.throws(load, error => error instanceof AgentOSConfigError && error.key === python.key,
          `Python refused at ${python.key}`);
        return;
      }
      const cfg = load();
      for (const key of get) assert.deepEqual(cfg.get(key), python.values[key], key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('every CFG key is in the Node schema and every Node-only key is inventoried', () => {
  const nodePaths = new Set();
  (function walk(node, path) {
    nodePaths.add(path);
    for (const [key, child] of Object.entries(node.__keys ?? {})) walk(child, path ? `${path}.${key}` : key);
    if (node.__item) walk(node.__item, `${path}[]`);
    if (node.__extra_keys_schema) walk(node.__extra_keys_schema, `${path}.*`);
  })(schemaV1(), '');
  const cfgPaths = new Set();
  (function walk(js, path) {
    // Visit every non-null alternative: branch order and multiple alternatives
    // must never hide child keys from parity coverage.
    for (const branch of js.anyOf ?? []) if (branch.type !== 'null') walk(branch, path);
    cfgPaths.add(path);
    for (const [key, child] of Object.entries(js.properties ?? {})) walk(child, path ? `${path}.${key}` : key);
    if (js.items) walk(js.items, `${path}[]`);
    if (typeof js.additionalProperties === 'object') walk(js.additionalProperties, `${path}.*`);
  })(CFG_JSON_SCHEMA, '');
  for (const path of cfgPaths) assert.ok(nodePaths.has(path), `CFG key ${path} missing from the Node schema`);
  const extra = [...nodePaths].filter(path => !cfgPaths.has(path)
    && !Object.keys(NODE_ONLY_KEYS).some(root => path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`))
    && !path.includes('.operation_limits.*') && !path.startsWith('worker_pool.public_hygiene.identities.*'));
  assert.deepEqual(extra, []);
  assert.equal(Object.keys(NODE_ONLY_KEYS).length, 32);
  assert.equal(Object.keys(NODE_ONLY_ENUM_MEMBERS).length, 3);
});
