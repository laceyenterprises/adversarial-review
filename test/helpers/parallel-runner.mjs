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
const files = config.shards.flatMap(shard => shard.files).map(file => config.paths[file]).sort();
const source = run({ files, concurrency: Math.max(1, config.shards.length), isolation: 'process', execArgv });
let failed = false;
source.on('test:fail', () => { failed = true; });
await pipeline(source, parallelReporter, process.stdout);
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
console.error(`Test suite: ${results.length} files, ${results.filter(r => r.status !== 0).length} failed, ${Math.round(report.wallMs)} ms, ${config.shards.length} workers`);
process.exitCode = failed || results.some(result => result.status !== 0) ? 1 : 0;
