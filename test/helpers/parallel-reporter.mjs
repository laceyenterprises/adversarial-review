import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tap } from 'node:test/reporters';

export function nativeFileName(data, names) {
  // Node 22 and 26 create the coordinator's file events with null-prototype
  // data. Deserialized worker events are plain objects, including when a
  // case uses the absolute entrypoint as its own test name.
  if (data?.name != null && data.name === data.file && Object.getPrototypeOf(data) === null) {
    return names.get(data.file);
  }
}

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
      if (event.type === 'test:summary') {
        const file = names.get(data?.file);
        if (file) results.set(file, { ...results.get(file), file, counts: data.counts });
      } else if (event.type === 'test:complete') {
        const file = nativeFileName(data, names);
        if (file) results.set(file, { ...results.get(file), file,
          status: data.details.passed ? 0 : 1, durationMs: data.details.duration_ms });
      }
      yield event;
    }
    writeFileSync(config.reportPath, JSON.stringify({ wallMs: performance.now() - started,
      files: [...results.values()] }));
  }
  yield* tap(measured());
}
