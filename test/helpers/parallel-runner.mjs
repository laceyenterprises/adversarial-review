import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import parallelReporter from './parallel-reporter.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const started = performance.now();
const reportPath = path.join(config.logDir, 'native-report.json');
const workerArgs = config.nodeArgs.slice(0, config.nodeArgs.indexOf('--test'));
const preloads = [], execArgv = [];
for (let i = 0; i < workerArgs.length; i++) {
  if (workerArgs[i] === '--import') preloads.push(workerArgs[++i]);
  else execArgv.push(workerArgs[i]);
}
const nativeConfig = path.join(config.logDir, 'native-config.json');
writeFileSync(nativeConfig, JSON.stringify({ paths: config.paths, reportPath, preloads }));
process.env.AR_TEST_SHARD_CONFIG = nativeConfig;
execArgv.push('--import', path.join(import.meta.dirname, 'worker-preloads.mjs'));
// Worker-root ranks encode measured priority. Sort explicitly because native
// discovery also sorts filenames. Each freed slot takes the next pending file.
let failed = false;
async function* phases() {
  const counts = {};
  let offset = 0;
  const groups = (config.serialFiles ?? []).map(file => ({ files: [config.paths[file]], concurrency: 1 }));
  const files = config.parallelFiles.map(file => config.paths[file]).sort();
  if (files.length) groups.push({ files, concurrency: config.concurrency });
  for (const group of groups) {
    const source = run({ ...group, isolation: 'process', execArgv });
    source.on('test:fail', () => { failed = true; });
    let summary;
    for await (const event of source) {
      const data = event.data;
      if (!data.file && event.type === 'test:summary') {
        summary = data;
        continue;
      }
      if (!data.file && data.nesting === 0 && (event.type === 'test:plan'
        || event.type === 'test:diagnostic'
          && /^(?:(?:tests|suites|pass|fail|cancelled|skipped|todo) \d+$|duration_ms )/.test(data.message))) {
        continue;
      }
      // Each native invocation numbers top-level tests from one. Expose one
      // continuous TAP document, preserving nested test numbers and diagnostics.
      if (data.nesting === 0 && Number.isInteger(data.testNumber)) {
        yield { ...event, data: { ...data, testNumber: data.testNumber + offset } };
      } else yield event;
    }
    if (!summary) { failed = true; continue; }
    for (const [name, count] of Object.entries(summary.counts)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
    offset += summary.counts.topLevel;
  }
  yield { type: 'test:plan', data: { nesting: 0, count: offset } };
  for (const [label, key] of [['tests', 'tests'], ['suites', 'suites'], ['pass', 'passed'],
    ['fail', 'failed'], ['cancelled', 'cancelled'], ['skipped', 'skipped'], ['todo', 'todo']]) {
    yield { type: 'test:diagnostic', data: { nesting: 0, message: `${label} ${counts[key] ?? 0}` } };
  }
  const duration_ms = performance.now() - started;
  yield { type: 'test:diagnostic', data: { nesting: 0, message: `duration_ms ${duration_ms}` } };
  yield { type: 'test:summary', data: { success: !failed, counts, duration_ms } };
}
await pipeline(phases(), parallelReporter, process.stdout);
let reported = [];
try { reported = JSON.parse(readFileSync(reportPath, 'utf8')).files; } catch { failed = true; }
const results = config.files.map(file => {
  const result = reported.find(entry => entry.file === file);
  return result && Number.isInteger(result.status) ? result
    : { file, status: 1, error: 'Missing file completion report' };
}).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
for (const result of results) {
  if (result.status !== 0) console.error(`Failed test file: ${result.file}${result.error ? ` (${result.error})` : ''}`);
}
const report = { wallMs: performance.now() - started, files: results };
if (config.reportPath) writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`Test suite: ${results.length} files, ${results.filter(r => r.status !== 0).length} failed, ${Math.round(report.wallMs)} ms, ${config.concurrency} workers`);
process.exitCode = failed || results.some(result => result.status !== 0) ? 1 : 0;
