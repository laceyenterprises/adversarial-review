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

const reviewLatencyDocPath = resolve(root, 'docs/data-model/review-latency-events.md');
const reviewLatencyWriterPath = resolve(root, 'src/review-latency-event-writer.mjs');
const reviewLatencyReportPath = resolve(root, 'src/review-latency-report.mjs');
const reviewLatencyDoc = readFileSync(reviewLatencyDocPath, 'utf8');
const reviewLatencyWriterSource = readFileSync(reviewLatencyWriterPath, 'utf8');
const reviewLatencyReportSource = readFileSync(reviewLatencyReportPath, 'utf8');
const eventTypesMatch = reviewLatencyWriterSource.match(/const REVIEW_LATENCY_EVENT_TYPES = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/);
assert.ok(eventTypesMatch, 'REVIEW_LATENCY_EVENT_TYPES set must be parseable');
const codeEventTypes = [...eventTypesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
const reportEventTypesMatch = reviewLatencyReportSource.match(/const EVENT_TYPES = Object\.freeze\(\[([\s\S]*?)\]\);/);
assert.ok(reportEventTypesMatch, 'review-latency-report EVENT_TYPES list must be parseable');
const reportEventTypes = [...reportEventTypesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
const stageMapMatch = reviewLatencyWriterSource.match(/const REVIEW_LATENCY_EVENT_STAGE_BY_TYPE = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert.ok(stageMapMatch, 'REVIEW_LATENCY_EVENT_STAGE_BY_TYPE map must be parseable');
const stageMapEventTypes = [...stageMapMatch[1].matchAll(/(?:^|,)\s*([a-zA-Z0-9_]+):\s*'[^']+'/gm)].map((match) => match[1]);
const eventContractMatch = reviewLatencyDoc.match(/## Event contract[\s\S]*?reported by `collectReviewLatencyReport`:\n\n([\s\S]*?)\n\n/);
assert.ok(eventContractMatch, 'review-latency-events.md Event contract list must be parseable');
const docEventTypes = [...eventContractMatch[1].matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
assert.deepEqual(
  docEventTypes,
  codeEventTypes,
  'review-latency-events.md event type list must match REVIEW_LATENCY_EVENT_TYPES'
);
assert.deepEqual(
  reportEventTypes,
  codeEventTypes,
  'review-latency-report EVENT_TYPES must match REVIEW_LATENCY_EVENT_TYPES'
);
assert.deepEqual(
  stageMapEventTypes,
  codeEventTypes,
  'REVIEW_LATENCY_EVENT_STAGE_BY_TYPE keys must match REVIEW_LATENCY_EVENT_TYPES'
);

console.log(`validated ${catalog.entries.length} data-model catalog entries`);
