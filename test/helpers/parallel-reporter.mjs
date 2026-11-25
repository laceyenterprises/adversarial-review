import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tap } from 'node:test/reporters';

export function trackNativeFiles(names) {
  const workers = new Map();
  return ({ type, data }) => {
    if (type !== 'test:enqueue' && type !== 'test:dequeue' && type !== 'test:complete') return;
    // Node 26 tags forwarded events with entryFile. Node 22 forwards them
    // untagged, so a case declared at 1:1 can duplicate the file event schema.
    if (data.entryFile !== undefined || data.nesting !== 0 || data.name !== data.file
      || data.line !== 1 || data.column !== 1) return;
    const file = names.get(data.file);
    if (!file) return;

    const worker = workers.get(file);
    if (worker?.finished) return;
    if (type === 'test:enqueue') {
      // The coordinator enqueues the file before its process can emit events.
      if (!worker) workers.set(file, { started: false, finished: false, matchingCases: 0 });
      else worker.matchingCases += 1;
      return;
    }
    if (!worker) return;
    if (type === 'test:dequeue') {
      if (worker.started) return;
      worker.started = true;
      return file;
    }
    if (!worker.started) return;
    if (worker.matchingCases > 0 && Object.getPrototypeOf(data) !== null) {
      // On Node 22 a process can exit with an unfinished matching case.
      // In that ambiguity, preserve native completion for the current runtime.
      worker.matchingCases -= 1;
      return;
    }
    worker.finished = true;
    return file;
  };
}

// Only the native coordinator loads a reporter. Test-file workers retain the
// normal node:test process isolation and the runner's existing preloads.
export default async function* parallelReporter(source) {
  const config = JSON.parse(readFileSync(process.env.AR_TEST_SHARD_CONFIG, 'utf8'));
  const names = new Map(Object.entries(config.paths).map(([name, file]) => [file, name]));
  const nativeFileName = trackNativeFiles(names);
  const results = new Map();
  const started = performance.now();
  async function* measured() {
    for await (const event of source) {
      const data = event.data;
      const file = nativeFileName(event);
      if (event.type === 'test:summary') {
        const summarizedFile = names.get(data?.file);
        if (summarizedFile) results.set(summarizedFile, {
          ...results.get(summarizedFile), file: summarizedFile, counts: data.counts });
      } else if (event.type === 'test:complete' && file) {
        results.set(file, { ...results.get(file), file,
          status: data.details.passed ? 0 : 1, durationMs: data.details.duration_ms });
      }
      yield event;
    }
    writeFileSync(config.reportPath, JSON.stringify({ wallMs: performance.now() - started,
      files: [...results.values()] }));
  }
  const output = tap(measured());
  if (!config.compactPasses) { yield* output; return; }
  // Passing TAP diagnostics repeat four lines per case. Keep every assertion,
  // test identity, failure detail and summary, but avoid making slow CI log
  // consumers throttle the native event stream and its worker scheduling.
  let passed = false;
  for await (const chunk of output) {
    const text = String(chunk);
    if (/^\s*ok \d+/m.test(text)) passed = true;
    else if (/^\s*not ok \d+/m.test(text)) passed = false;
    if (passed && /^\s*---\n/.test(text)) continue;
    yield chunk;
  }
}
