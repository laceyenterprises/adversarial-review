import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchReadTransport, prepareWorkerObservationSession} from '../src/dispatch-read-client.mjs';
import {readPrBuilderProvenanceAsync} from '../src/session-ledger-read-adapter.mjs';
import {resolveDaemonWorkerIdentityForPr} from '../src/daemon-worker-identity.mjs';
import {reconcileBuilderClass} from '../src/builder-provenance-routing.mjs';
import {main as reroute} from '../bin/reroute-builder-review.mjs';
import {main as backfill} from '../scripts/backfill-reviewer-passes.mjs';

const page = (items, rest = {}) => ({schema_version:1,observation:'provenance',
  status:items.length?'found':'not_found',complete:true,next_offset:null,
  mutation_authority:false,scope_complete:false,items,...rest});
const env = {ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:'1'};
const connectOptions = {endpoint_url:'https://synthetic.invalid/rollout',bootstrap_token:'synthetic'};
function installedSdk(t) {
  const sdk = dispatchReadTransport.sdk();
  t.mock.method(dispatchReadTransport,'sdk',() => ({...sdk,connect:config => sdk.connect({...config,...connectOptions})}));
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixturePath = new URL('./fixtures/producer-contracts/pr-opener-projection.json',import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath));

test('immutable producer capture distinguishes opener from later remediation; daemon retries preserve opener', async () => {
  const provenance = JSON.parse(readFileSync(new URL('./fixtures/producer-contracts/provenance.json',import.meta.url)));
  const pin = provenance.recorded.dispatchLookupSdk.openerProjection;
  const source = readFileSync(new URL(`../${pin.definition}`,import.meta.url));
  assert.equal(sha256(source),pin.definitionSha256);
  assert.equal(sha256(readFileSync(fixturePath)),pin.sha256);
  assert.equal(fixture.producerRevision,'f37c7489439a8b53eafecb38870f75fe9f07fa57');
  assert.equal(fixture.sourceSha256,pin.definitionSha256);
  assert.ok(source.includes(Buffer.from('"" if builder else " AND signal_kind=\'pr_opened\'"')));
  assert.equal(fixture.responses.opener.items[0].launch_request_id,'open-launch');
  assert.equal(fixture.responses.builder.items[0].launch_request_id,'repair-launch');
  assert.equal(fixture.buildCompletions.length,4);
  const selectors = [];
  const dispatchSession = {dispatchLookup:async selector => {
    selectors.push(selector);
    return selector.builder_identity ? fixture.responses.builder
      : selector.head_sha ? fixture.responses.currentHead : fixture.responses.opener;
  }};
  const identity = await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
    currentHeadSha:'current',currentBranch:'feature',env:{},dispatchSession});
  assert.equal(identity.ok,true);
  assert.equal(identity.launchRequestId,'open-launch');
  assert.equal(identity.workerClass,'codex');
  assert.equal(identity.resolvedBy,'pr-opened-head-moved');
  assert.equal(selectors.length,2);
  assert.ok(selectors.every(selector => selector.builder_identity === undefined));
  const builder = await readPrBuilderProvenanceAsync({repo:'example/repo',prNumber:42,dispatchSession});
  assert.equal(builder.actualHarness,'claude-code');
});

test('ambiguous PR provenance never selects the first of an opener and later remediation', async () => {
  const result = await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
    currentHeadSha:'current',env:{},dispatchSession:{dispatchLookup:async () => page([
      ...fixture.responses.opener.items,...fixture.responses.builder.items,
    ])}});
  assert.equal(result.ok,false);
  assert.equal(result.reason,'unconfirmed-pr-opener-provenance');
});

for (const [name, reply] of [['missing grants',page([])],['unsupported producer',{}],['outage',null]]) {
  test(`${name}: review title intake proceeds but daemon merge identity stays unknown`, async t => {
    installedSdk(t);
    t.mock.method(globalThis,'fetch',async url => {
      if (url.endsWith('/register')) return new Response(JSON.stringify({session_token:'synthetic'}));
      if (reply === null) throw new Error('synthetic outage');
      return new Response(JSON.stringify(reply));
    });
    const args = {repo:'example/repo',prNumber:42,env,connectOptions};
    const provenance = await readPrBuilderProvenanceAsync(args);
    assert.equal(provenance.ok,false);
    assert.equal(provenance.deferClaim,false);
    const route = reconcileBuilderClass({builderClass:'codex'},provenance);
    assert.equal(route.deferClaim,false);
    assert.equal(route.subject.builderClass,'codex');
    assert.equal(route.finding.name,'builder_class_inconclusive');
    // Same real transport/validator, using the process endpoint below.
    const identity = await resolveDaemonWorkerIdentityForPr({...args,
      currentHeadSha:'current',currentBranch:'feature'});
    assert.equal(identity.ok,false);
    assert.equal(identity.launchRequestId,undefined);
  });
}

test('observation rollout defaults off independently of the already enabled own-launch flag', async t => {
  t.mock.method(dispatchReadTransport,'sdk',() => assert.fail('disabled observations must not load SDK'));
  for (const flag of [undefined,'0','true']) {
    const options = {repo:'example/repo',prNumber:42,
      env:{ADVERSARIAL_DISPATCH_READS_ENABLED:'1',ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:flag}};
    const result = await readPrBuilderProvenanceAsync(options);
    assert.equal(result.deferClaim,false);
    assert.equal(result.detail,'worker observations disabled');
    assert.equal((await resolveDaemonWorkerIdentityForPr({...options,currentHeadSha:'current',currentBranch:'feature'})).ok,false);
    assert.equal((await prepareWorkerObservationSession(options)).ok,false);
  }
});

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(),'observation-cold-cli-'));
  t.after(() => rmSync(root,{force:true,recursive:true}));
  return root;
}
function flags(t) {
  const old = process.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED;
  process.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED = '1';
  t.after(() => { if (old === undefined) delete process.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED;
    else process.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED = old; });
}

test('cold reroute CLI uses async public registration and only previews a confirmed mismatch', async t => {
  flags(t);
  installedSdk(t);
  let registers = 0, reads = 0;
  t.mock.method(globalThis,'fetch',async (url,options) => {
    if (url.endsWith('/register')) { registers++; return new Response(JSON.stringify({session_token:'synthetic'})); }
    reads++;
    assert.equal(options.headers.Authorization,'Bearer synthetic');
    assert.equal(JSON.parse(options.body).builder_identity,true);
    return new Response(JSON.stringify(fixture.responses.builder));
  });
  // Explicit failed readiness evicts any session from a previous test.
  await prepareWorkerObservationSession({env:{}});
  let preview = '';
  assert.equal(await reroute(['--repo','example/repo','--pr','42'],{
    fetchPr:async () => ({state:'OPEN',headRefOid:'current',title:'[codex] fixture'}),
    retrigger:() => assert.fail('preview cannot retrigger'),stdout:{write:text => {preview += text;}},
  }),0);
  assert.equal(registers,1); assert.equal(reads,1);
  assert.equal(JSON.parse(preview).actualBuilderClass,'claude-code');
});

test('cold backfill CLI registers once before synchronous OS accounting; failed registration writes nothing', async t => {
  const root = tempRoot(t), failedRoot = tempRoot(t);
  const jobsDir = join(root,'data','follow-up-jobs','completed');
  mkdirSync(jobsDir,{recursive:true});
  for (const id of [1,2]) writeFileSync(join(jobsDir,`job-${id}.json`),JSON.stringify({
    repo:'example/repo',prNumber:id,jobId:`job-${id}`,status:'completed',workspaceDir:'/synthetic',
    completedAt:'2026-01-02T00:00:00Z',remediationWorker:{model:'codex',workerRunId:`run-${id}`,
      workspaceDir:'/synthetic',spawnedAt:'2026-01-01T00:00:00Z'},
  }));
  let registers = 0, reads = 0, fail = false;
  const sdk = dispatchReadTransport.sdk();
  t.mock.method(globalThis,'fetch',async url => {
    assert.ok(url.endsWith('/register'));
    registers++;
    if (fail) throw new Error('synthetic unavailable');
    return new Response(JSON.stringify({session_token:'cold-backfill'}));
  });
  t.mock.method(dispatchReadTransport,'sdk',() => ({...sdk,connect:config => sdk.connect({...config,...connectOptions}),readWorkerObservationsSync(selector,options) {
    assert.equal(options.session_token,'cold-backfill');
    reads++;
    return page([{run_id:selector.worker_run_id,launch_request_id:'launch',
      token_usage_input:12,token_usage_output:3,token_usage_source:'worker-run'}],{observation:'workers'});
  }}));
  await prepareWorkerObservationSession({env:{}});
  let output = '', error = '';
  const io = {env,stdout:{write:text => {output += text;}},stderr:{write:text => {error += text;}}};
  assert.equal(await backfill(['--root-dir',root,'--dry-run','--json'],io),0,error);
  assert.equal(registers,1); assert.equal(reads,2);
  assert.equal(JSON.parse(output).tokenMatched,2);
  await prepareWorkerObservationSession({env:{}});
  fail = true;
  assert.equal(await backfill(['--root-dir',failedRoot,'--json'],io),2);
  assert.match(error,/registration unavailable/);
  assert.equal(existsSync(join(failedRoot,'data')),false);
});


test('branch provenance cannot infer a merge owner from missing PR attribution or multiple matching launches', async () => {
  const row = {launch_request_id:'launch',worker_class:'codex',repo:'example/repo',branch:'feature',head_sha:'original'};
  for (const items of [[row],[{...row,pr_number:42}],[{...row,pr_number:42},{...row,pr_number:42,launch_request_id:'repair'}]]) {
    const identity = await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
      currentHeadSha:'current',currentBranch:'feature',env:{},dispatchSession:{dispatchLookup:async selector =>
        page(selector.branch ? items : [])}});
    assert.equal(identity.ok,false);
    assert.equal(identity.launchRequestId,undefined);
  }
});


test('partial grants hiding the opener cannot promote the visible remediation branch launch to merge identity', async () => {
  const repair = {...fixture.responses.builder.items[0],repo:'example/repo',pr_number:42,branch:'feature'};
  const selectors = [];
  const identity = await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
    currentHeadSha:'current',currentBranch:'feature',env:{},dispatchSession:{dispatchLookup:async selector => {
      selectors.push(selector);
      return page(selector.branch ? [repair] : []);
    }}});
  assert.ok(selectors.some(selector => selector.branch === 'feature'));
  assert.equal(identity.ok,false);
  assert.equal(identity.launchRequestId,undefined);
  assert.equal(identity.workerClass,undefined);
  assert.equal(identity.launchProvenanceReason,'branch-provenance-does-not-prove-pr-opener');
});
