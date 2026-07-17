// ARC-24 acceptance gate: the app consumes the published @agent-os/app-sdk and
// the vendored fork (src/app-contract-dispatch.mjs) is gone for good.
//
//   1. fork-file absence + no lingering imports of it anywhere in the tree,
//   2. the SDK is declared as a `file:` tarball dependency per the ARC-23
//      packaging ADR (Recipe A), with the pinned tarball present, and
//   3. the SDK's canonical SSE frame is bridged to the follow-up telemetry
//      listener's (event, topic) contract, so the swap preserves behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { attachFollowUpTelemetryListeners } from '../src/follow-up-remediation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// -- 1. fork absence + no dangling references ---------------------------------

test('the vendored fork src/app-contract-dispatch.mjs no longer exists', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'src', 'app-contract-dispatch.mjs')),
    false,
    'ARC-24 deletes the vendored app-contract client; consume @agent-os/app-sdk instead',
  );
});

function collectSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test('no source, test, or bin file imports the deleted fork or its export', () => {
  const roots = ['src', 'test', 'bin'].map((d) => join(REPO_ROOT, d)).filter(existsSync);
  const files = roots.flatMap((root) => collectSourceFiles(root));
  const offenders = [];
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue; // this gate names the symbols on purpose
    const text = readFileSync(file, 'utf8');
    if (text.includes('app-contract-dispatch') || /\bconnectAppContract\b/.test(text)) {
      offenders.push(relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `these files still reference the deleted fork: ${offenders.join(', ')}`);
});

// -- 2. published SDK declared per the ARC-23 packaging recipe -----------------

test('package.json declares @agent-os/app-sdk as a file: tarball dependency (Recipe A)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const spec = pkg.dependencies?.['@agent-os/app-sdk'];
  assert.ok(spec, '@agent-os/app-sdk must be a declared runtime dependency');
  assert.match(spec, /^file:.*\.tgz$/, 'ARC-23 Recipe A pins the SDK as a committed file: tarball');
  const tarball = spec.replace(/^file:/, '');
  const tarballPath = join(REPO_ROOT, tarball);
  assert.ok(existsSync(tarballPath), `the pinned SDK tarball ${tarball} must be committed`);
  assert.ok(statSync(tarballPath).size > 0, 'the pinned SDK tarball must not be empty');
});

test('the published SDK actually resolves and exposes connect()', async () => {
  const sdk = await import('@agent-os/app-sdk');
  assert.equal(typeof sdk.connect, 'function', '@agent-os/app-sdk must export connect()');
});

// -- 3. SDK frame → telemetry listener bridge ---------------------------------

test('follow-up telemetry listener accepts the SDK canonical SSE frame', async () => {
  let registeredTopic = null;
  let handler = null;
  const session = {
    on(topic, cb) {
      registeredTopic = topic;
      handler = cb;
      return () => {};
    },
  };
  const handled = [];
  const listener = attachFollowUpTelemetryListeners({
    session,
    subscribes: ['health.worker.*'],
    handleTelemetryEventImpl: async (input) => {
      handled.push(input);
      return { action: 'active' };
    },
    log: { log() {}, warn() {}, error() {} },
  });

  assert.equal(registeredTopic, 'health.worker.*');

  // The published SDK delivers one frame { topic, payload, published_at }.
  await handler({
    topic: 'health.worker.terminal.lrq_frame_delivery',
    payload: { lrq: 'lrq_frame_delivery', status: 'succeeded' },
    published_at: '2026-07-17T20:00:00.000Z',
  });

  assert.equal(handled.length, 1);
  assert.equal(handled[0].topic, 'health.worker.terminal.lrq_frame_delivery');
  assert.deepEqual(handled[0].event, { lrq: 'lrq_frame_delivery', status: 'succeeded' });

  listener.dispose();
});

test('follow-up telemetry listener still accepts the legacy (event, topic) delivery', async () => {
  let handler = null;
  const session = {
    on(_topic, cb) {
      handler = cb;
      return () => {};
    },
  };
  const handled = [];
  const listener = attachFollowUpTelemetryListeners({
    session,
    subscribes: ['health.worker.*'],
    handleTelemetryEventImpl: async (input) => {
      handled.push(input);
      return { action: 'active' };
    },
    log: { log() {}, warn() {}, error() {} },
  });

  await handler(
    { lrq: 'lrq_legacy_delivery', status: 'succeeded' },
    'health.worker.terminal.lrq_legacy_delivery',
  );

  assert.equal(handled.length, 1);
  assert.equal(handled[0].topic, 'health.worker.terminal.lrq_legacy_delivery');
  assert.deepEqual(handled[0].event, { lrq: 'lrq_legacy_delivery', status: 'succeeded' });

  listener.dispose();
});
