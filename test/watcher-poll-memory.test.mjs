import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { sep } from 'node:path';
import perfHooks from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { omitWatcherDiagnosticFlushes } from './helpers/watcher-diagnostic-flush-fixture.mjs';

const commands = ['gh', 'git', 'hq', 'psql', 'node'];

test('watcher diagnostic flush patch requires cleanup and rejects nested use', (t) => {
  const root = process.env.ADVERSARIAL_REVIEW_TEST_CWD;
  const original = fs.openSync;
  assert.throws(() => omitWatcherDiagnosticFlushes(root, () => { throw new Error('registration failed'); }),
    /registration failed/);
  assert.equal(fs.openSync, original);
  let restore;
  omitWatcherDiagnosticFlushes(root, cleanup => {
    restore = cleanup;
    t.after(cleanup);
  });
  assert.notEqual(fs.openSync, original);
  assert.throws(() => omitWatcherDiagnosticFlushes(root, cleanup => t.after(cleanup)), /already active/);
  restore();
  assert.equal(fs.openSync, original);
  omitWatcherDiagnosticFlushes(root, cleanup => t.after(cleanup));
  restore();
  assert.notEqual(fs.openSync, original, 'stale cleanup cannot restore over a later registration');
});

test('watcher polls reuse child histograms across passes', async t => {
  const sandbox = process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT;
  assert.ok(sandbox && fileURLToPath(import.meta.url).startsWith(sandbox + sep),
    'run through test/run-tests.mjs for an isolated watcher database');
  t.mock.method(console, 'log', () => {});
  const warn = console.warn;
  t.mock.method(console, 'warn', (line, ...args) => {
    if (!String(line).startsWith('[watcher] Zero watched repositories')) warn(line, ...args);
  });

  let allocations = 0;
  const createHistogram = perfHooks.createHistogram;
  perfHooks.createHistogram = (...args) => {
    allocations++;
    return createHistogram(...args);
  };
  syncBuiltinESMExports();
  try {
    omitWatcherDiagnosticFlushes(process.env.ADVERSARIAL_REVIEW_TEST_CWD, restore => t.after(restore));
    const { pollOnce } = await import('../src/watcher.mjs');
    const octokit = { rest: { repos: { listForOrg() {} } }, paginate: async () => [] };
    const options = {
      ensureWorkerRegistryReadyImpl: async () => {
        for (const spawnfile of commands) {
          const child = new EventEmitter();
          channel('child_process').publish({ process: child });
          child.spawnfile = spawnfile;
          child.emit('spawn');
          child.emit('close');
        }
      },
      healthProbe: null,
    };
    const samples = [];
    for (let pass = 1; pass <= 180; pass++) {
      await pollOnce(octokit, options);
      const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
      samples.push({ pass, allocations, rss, heapUsed, external, arrayBuffers });
    }
    for (const sample of samples.filter(({ pass }) => pass === 1 || pass % 30 === 0)) {
      t.diagnostic(JSON.stringify(sample));
    }
    // Allocation count is the regression guard: native histogram RSS growth
    // does not appear in external or arrayBuffers.
    assert.ok(samples.every(sample => sample.allocations === 2 * commands.length),
      'each command keeps one spawn and one wall histogram across all passes');
    // This bound is only a sanity check. external already includes arrayBuffers.
    // Bound the combined indicator after warmup and keep RSS for diagnosis.
    const externalTotals = samples.slice(30).map(({ external, arrayBuffers }) => external + arrayBuffers);
    assert.ok(Math.max(...externalTotals) - Math.min(...externalTotals) < 16 * 1024 * 1024,
      'post-warmup external + arrayBuffers spread must stay below 16 MiB');
  } finally {
    perfHooks.createHistogram = createHistogram;
  }
});
