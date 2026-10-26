// Offline release evidence only. Keep consumer assertions inside this wrapper so
// drift failures identify the producer/version without echoing fixture contents.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProducerContracts } from '@agent-os/app-sdk';

const root = new URL('../fixtures/producer-contracts/', import.meta.url);
export const fixtureProvenance = JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8'));
export const sdkSnapshotBytes = execFileSync('tar', ['-xOf', fileURLToPath(new URL('../../' + fixtureProvenance.recorded.sdk.file, import.meta.url)), 'package/src/producer-contracts-v1.json'], {maxBuffer: 2 * 1024 * 1024, timeout: 10000});
export const sdkBundle = parseProducerContracts(sdkSnapshotBytes.toString('utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertProducerContract(name, assertion) {
  const record = fixtureProvenance.recorded?.producers[name];
  const label = `${name} contract ${record?.contractVersion || 'unrecorded'}`;
  try {
    assert.ok(record, 'recording metadata missing');
    return assertion(record);
  } catch {
    // AssertionError messages can print actual and expected values. Never copy
    // their message, stack or cause into a public diagnostic.
    throw new Error(`${label}: recorded producer fixture drift`);
  }
}

export function recordedFixture(name, { readFileImpl = readFileSync } = {}) {
  return assertProducerContract(name, record => {
    const bytes = readFileImpl(new URL(record.file, root));
    assert.equal(sha256(bytes), record.sha256);
    const text = bytes.toString('utf8');
    const value = name === 'github-token-refresh' ? text : JSON.parse(text);
    const producer = sdkBundle.producers[name];
    for (const [field, expected] of Object.entries(producer.recording)) assert.deepEqual(record[field], expected);
    assert.equal(record.producerCommand, producer.producerCommand);
    assert.equal(fixtureProvenance.producerHashes[name], record.contentHash);
    assert.equal(sha256(name === 'github-token-refresh' ? JSON.stringify(value) : bytes), record.contentHash);
    assert.deepEqual(value, producer.examples.find(entry => entry.provenance === 'producer-recorded').value);
    return value;
  });
}
