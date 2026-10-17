// Offline, synthetic reproduction. No GitHub, ledger, host state or credentials.
// The legacy reader is retained for CLI compatibility, making the comparison
// reproducible without checking out old code. Scale: 120ms per child, 3 retries.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrBuilderProvenance, readPrBuilderProvenanceAsync } from '../src/session-ledger-read-adapter.mjs';
import { createReviewerPreflight } from '../src/reviewer-admission-lifecycle.mjs';
import { createWatcherLatencyMonitor } from '../src/watcher-latency.mjs';

const exec = promisify(execFile);
const fakeArgs = ['-e', 'setTimeout(() => {}, 120)'];
const failure = () => ({ error: { code: 'ETIMEDOUT' } });
for (const mode of ['legacy-sync', 'watcher-async']) {
  const monitor = createWatcherLatencyMonitor();
  try {
    await delay(30);
    const started = performance.now(), completed = {};
    const preflight = createReviewerPreflight();
    const steps = Promise.all(['ci', 'fatigue', 'hcp', 'drafts'].map(step => preflight.read(step, async () => {
      await delay(5); completed[step] = Math.round(performance.now() - started);
    })));
    const args = { repo: 'example/review-fixture', prNumber: 1,
      ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/synthetic' },
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      spawnSyncImpl() { spawnSync(process.execPath, fakeArgs); return failure(); },
      async spawnAsyncImpl() { await exec(process.execPath, fakeArgs); return failure(); },
    };
    const read = mode === 'legacy-sync' ? readPrBuilderProvenance : readPrBuilderProvenanceAsync;
    const pending = read(args);
    await steps;
    console.log(JSON.stringify({ mode, preflight_completed_ms: completed }));
    await pending;
    await delay(30);
    monitor.summary();
  } finally { monitor.stop(); }
}
