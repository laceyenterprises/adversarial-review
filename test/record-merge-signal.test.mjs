import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('hammer merge capture forwards launch provenance through the SDK and honors HQ_BIN', t => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-signal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hq = join(dir, 'fake-hq');
  const capture = join(dir, 'capture.json');
  writeFileSync(hq, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({args:process.argv.slice(2),
  workerRunId:process.env.HQ_WORKER_RUN_ID}));
console.log(JSON.stringify({status:'recorded',event_id:'synthetic-event'}));
`, { mode: 0o755 });
  const env = { ...process.env, HQ_BIN:hq, CAPTURE_PATH:capture, WORKER_CLASS:'hammer-claude',
    HQ_TICKET_REF:'AMA-PR-42', HQ_WORKER_RUN_ID:'run_hammer' };
  for (const key of ['HQ_LAUNCH_REQUEST_ID', 'AGENT_OS_WORKER_LRQ_ID', 'LAUNCH_REQUEST_ID']) delete env[key];
  for (const launchKey of ['HQ_LAUNCH_REQUEST_ID', 'AGENT_OS_WORKER_LRQ_ID', 'LAUNCH_REQUEST_ID']) {
    const result = spawnSync(process.execPath, [new URL('../bin/record-merge-signal.mjs', import.meta.url).pathname,
      '/tmp/hq', '42', 'a'.repeat(40), 'squash'], {
      env:{...env,[launchKey]:'lrq_hammer'}, encoding:'utf8', timeout:5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(recorded, {args:['build-completions', 'record-merge', '--hq-root', '/tmp/hq',
      '--pr-number', '42', '--merge-commit-sha', 'a'.repeat(40), '--launch-request-id', 'lrq_hammer',
      '--ticket-ref', 'AMA-PR-42', '--merged-by', 'hammer-claude', '--mode', 'squash'], workerRunId:'run_hammer'});
  }
});
