#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'docs/data-model/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

assert.equal(catalog.version, 1, 'catalog.version must be 1');
assert.ok(Array.isArray(catalog.entries), 'catalog.entries must be an array');

const ids = new Set();
for (const entry of catalog.entries) {
  assert.equal(typeof entry.id, 'string', 'entry.id must be a string');
  assert.ok(entry.id.length > 0, 'entry.id must not be empty');
  assert.equal(ids.has(entry.id), false, `duplicate entry.id ${entry.id}`);
  ids.add(entry.id);

  for (const key of ['title', 'path', 'store', 'schemaSurface', 'owner']) {
    assert.equal(typeof entry[key], 'string', `${entry.id}.${key} must be a string`);
    assert.ok(entry[key].length > 0, `${entry.id}.${key} must not be empty`);
  }
  assert.ok(existsSync(resolve(root, entry.path)), `${entry.id}.path does not exist`);
  assert.ok(existsSync(resolve(root, entry.schemaSurface)), `${entry.id}.schemaSurface does not exist`);
  if (entry.relatedSchemaSurfaces !== undefined) {
    assert.ok(Array.isArray(entry.relatedSchemaSurfaces), `${entry.id}.relatedSchemaSurfaces must be an array`);
    for (const surface of entry.relatedSchemaSurfaces) {
      assert.equal(typeof surface, 'string', `${entry.id}.relatedSchemaSurfaces entries must be strings`);
      assert.ok(existsSync(resolve(root, surface)), `${entry.id}.related schema surface does not exist: ${surface}`);
    }
  }
}

console.log(`validated ${catalog.entries.length} data-model catalog entries`);
