import test from 'node:test';
import assert from 'node:assert/strict';
import {readActiveDagRunsForPlanAsync} from '../src/session-ledger-read-adapter.mjs';
import { checkLivePackMerge } from '../src/live-pack-merge-check.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function fixture(slug = 'sample-pack', labels = []) {
  const pr = { state: 'open', head: { sha: head, ref: `post-merge-actions/${slug}-official-record-abcdef123456` },
    base: { sha: base }, title: `Bump ${slug} spec lock ref`, labels,
    user: { login: 'automation[bot]', type: 'Bot' } };
  return { repo: 'sample/repo', prNumber: 1, headSha: head,
    readPrImpl: async () => pr,
    listFilesImpl: async () => [`projects/${slug}/plan.json`, `projects/${slug}/prompts/sample.md`],
    fetchFileAtRefImpl: async (_repo, _path, ref) => {
      assert.equal(ref, base);
      return JSON.stringify({ planId: `${slug}-plan`, tickets: [{ id: 'SAMPLE-01' }] });
    },
    readActiveDagRunsImpl: async () => ({ ok: true, runs: [{ run_id: 'run_sample', state: 'running' }] }) };
}

for (const slug of ['sample-pack', 'second-pack']) {
  test(`REMLABEL-01: identical official-record bumps are both gated while live (${slug})`, async () => {
    const result = await checkLivePackMerge(fixture(slug));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'operator-label-required:live-pack-edit-approved');
    assert.equal(result.findings[0].pack, slug);
  });
}

test('REMLABEL-01: merge preflight observes an existing waiver without applying a label', async () => {
  const result = await checkLivePackMerge(fixture('sample-pack', [{ name: 'live-pack-edit-approved' }]));
  assert.equal(result.ok, true);
  assert.equal(result.waived, true);
});

test('REMLABEL-01: merge preflight fails closed on unreadable ledger or PR files', async () => {
  const args = fixture();
  assert.equal((await checkLivePackMerge({ ...args, readActiveDagRunsImpl: async () => ({ ok: false, reason: 'ledger-read-failed' }) })).ok, false);
  assert.equal((await checkLivePackMerge({ ...args, listFilesImpl: async () => { throw new Error('unavailable'); } })).reason, 'live-pack-check-unreadable');
});

test('REMLABEL-01: head movement or waiver removal during the check refuses merge', async () => {
  for (const change of [pr => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } }), pr => ({ ...pr, labels: [] })]) {
    const args = fixture('sample-pack', [{ name: 'live-pack-edit-approved' }]);
    const pr = await args.readPrImpl();
    let reads = 0;
    const result = await checkLivePackMerge({ ...args, readPrImpl: async () => ++reads === 1 ? pr : change(pr) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'live-pack-inputs-changed');
  }
});

test('REMLABEL-01: finished packs continue through the merge preflight', async () => {
  assert.equal((await checkLivePackMerge({ ...fixture(), readActiveDagRunsImpl: async () => ({ ok: true, runs: [] }) })).ok, true);
});


for (const status of ['not_live','scope_denied','unavailable','found','unknown_future_outcome']) {
  test(`SDK ${status} holds only the PR touching the affected plan`, async () => {
    const args = fixture();
    args.readActiveDagRunsImpl = query => readActiveDagRunsForPlanAsync({...query,
      dispatchSession:{dispatchLookup:async selector => {
        assert.equal(selector.plan_id, 'sample-pack-plan');
        return {schema_version:1,observation:'dag_runs',status,complete:true,next_offset:null,
          scope_complete:false,mutation_authority:false,
          items:status === 'found' ? [{run_id:'synthetic-run',state:'running'}] : []};
      }}});
    const result = await checkLivePackMerge(args);
    assert.equal(result.ok, status === 'not_live');
    if (['scope_denied','unavailable','unknown_future_outcome'].includes(status)) {
      assert.equal(result.reason, `live-pack-read-${status === 'scope_denied' ? 'scope-denied' : 'unavailable'}:sample-pack-plan`);
      assert.match(result.findings[0].reason, /plan sample-pack-plan/);
      assert.match(result.findings[0].reason, status === 'scope_denied'
        ? /live-pack-read-scope-denied/ : /live-pack-read-unavailable/);
    }
    const unrelated = await checkLivePackMerge({...args,prNumber:2,
      listFilesImpl:async () => ['src/synthetic.mjs'],
      readActiveDagRunsImpl:() => assert.fail('unrelated PR must not read any plan')});
    assert.equal(unrelated.ok, true, 'no global refusal survives a plan read');
  });
}
