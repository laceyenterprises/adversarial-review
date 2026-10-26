import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchReadTransport, readWorkerObservation} from '../src/dispatch-read-client.mjs';
import {readReviewerSessionUsageFromLedger} from '../src/session-ledger-read-adapter.mjs';
import {backfillReviewerPasses} from '../src/reviewer-pass-tokens.mjs';
import {openReviewStateDb} from '../src/review-state.mjs';

const page = items => ({schema_version:1, observation:'sessions', status:items.length?'found':'not_found',
  complete:true, next_offset:null, mutation_authority:false, scope_complete:false, items});

test('equivalent reordered connection options share one public SDK registration', async t => {
  let registrations = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/register')) {
      registrations++;
      return new Response(JSON.stringify({session_token:'ordered-session'}));
    }
    return new Response(JSON.stringify(page([{session_id:'session'}])));
  });
  const endpoint_url = 'https://synthetic.invalid/rescue-order', bootstrap_token = 'synthetic';
  for (const connectOptions of [{endpoint_url, bootstrap_token}, {bootstrap_token, endpoint_url}]) {
    const result = await readWorkerObservation({observation:'sessions', session_keys:['session']}, {
      env:{ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:'1'}, connectOptions,
    });
    assert.equal(result.ok, true);
  }
  assert.equal(registrations, 1);
});

test('an observed session outside the requested window differs from unavailable observations', () => {
  const options = {adapterSessionKey:'session', startedAt:'2026-01-02T00:00:00Z',
    workerObservationSyncImpl:() => page([{session_id:'session', started_at:'2026-01-01T00:00:00Z',
      ended_at:'2026-01-01T01:00:00Z'}])};
  assert.equal(readReviewerSessionUsageFromLedger(options).reason, 'no-session-in-window');
  assert.equal(readReviewerSessionUsageFromLedger({...options,
    workerObservationSyncImpl:() => page([])}).reason, 'worker-observation-inconclusive');
});

test('historical backfill uses explicit session linkage and skips workspace-only session lookup', t => {
  const root = mkdtempSync(join(tmpdir(), 'observation-rescue-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const dir = join(root, 'data/follow-up-jobs/completed');
  mkdirSync(dir, {recursive:true});
  for (const [prNumber, key] of [[61, null], [62, 'linked-session']]) {
    writeFileSync(join(dir, `${prNumber}.json`), JSON.stringify({repo:'example/repo', prNumber,
      jobId:`job-${prNumber}`, status:'completed', workspaceDir:'/synthetic',
      createdAt:'2026-01-01T00:00:00Z', completedAt:'2026-01-01T01:00:00Z',
      remediationWorker:{model:'codex', workspaceDir:'/synthetic', adapterSessionKey:key},
    }));
  }
  const reads = [];
  t.mock.method(dispatchReadTransport, 'observationSync', selector => {
    reads.push(selector);
    return page([{session_id:'linked-session', adapter_session_key:'linked-session',
      started_at:'2026-01-01T00:00:00Z', ended_at:'2026-01-01T01:00:00Z',
      total_input_tokens:22, total_output_tokens:4}]);
  });
  backfillReviewerPasses(root, {env:{AGENT_OS_CONFIG_PATH:'/dev/null'}});
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].session_keys, ['linked-session']);
  const db = openReviewStateDb(root);
  try {
    const rows = db.prepare('SELECT pr_number,token_input FROM reviewer_passes ORDER BY pr_number').all();
    assert.deepEqual(rows, [{pr_number:61, token_input:null}, {pr_number:62, token_input:22}]);
  } finally { db.close(); }
});
