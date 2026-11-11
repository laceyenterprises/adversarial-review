import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tap } from 'node:test/reporters';

// Only the native coordinator loads a reporter. Test-file workers retain the
// normal node:test process isolation and the runner's existing preloads.
export default async function* parallelReporter(source) {
  const config = JSON.parse(readFileSync(process.env.AR_TEST_SHARD_CONFIG, 'utf8'));
  const names = new Map(Object.entries(config.paths).map(([name, file]) => [file, name]));
  const results = new Map();
  const started = performance.now();
  async function* measured() {
    for await (const event of source) {
      const data = event.data;
      const file = names.get(data?.file);
      if (file && event.type === 'test:summary') {
        results.set(file, { ...results.get(file), file, counts: data.counts });
      }
      // Native file-completion events use the absolute entrypoint as their
      // name. Individual tests use their declared names, including tests
      // imported from another file. These events include process wall time.
      if (file && event.type === 'test:complete' && data.name === data.file) {
        results.set(file, { ...results.get(file), file,
          status: data.details.passed ? 0 : 1, durationMs: data.details.duration_ms });
      }
      yield event;
    }
    writeFileSync(config.reportPath, JSON.stringify({ wallMs: performance.now() - started,
      files: [...results.values()] }));
  }
  yield* tap(measured());
}
