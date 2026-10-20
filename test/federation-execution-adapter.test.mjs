import test from 'node:test';
import assert from 'node:assert/strict';
import { createFederationExecutionAdapter } from '../src/adapters/reviewer-runtime/federation-execution/index.mjs';
import { readReviewOrder, MAX_ORDER_BYTES, sha256 } from '../src/adapters/reviewer-runtime/federation-execution/review-order.mjs';
import { fixtureService, orderFixture, setup, signatureFor, usage, verifies } from './fixtures/federation-execution.mjs';

test('frozen execution returns signed head/round/epoch, artifacts and uncombined usage', async () => {
  const fixture = setup();
  const result = await fixture.execute();
  assert.equal(result.status, 'completed');
  assert.equal(result.review.verdict, 'approved');
  assert.deepEqual(result.binding, fixture.binding);
  assert.equal(result.binding.orderHash, sha256(fixture.request.orderBytes));
  assert.deepEqual(result.usage, usage);
  assert.equal(result.usageComplete, true);
  assert.equal(result.artifacts[0].sha256, sha256(result.artifacts[0].content));
  assert.equal(result.seatRetained, false);
  assert.equal(fixture.service.active.size, 0);
  assert.deepEqual(Object.keys(fixture.adapter), ['execute']);
  // Independently exercise signed-byte tampering with the same valid fixture.
  const valid = setup();
  const signed = await valid.adapter.execute(valid.request);
  assert.equal(verifies(signed.payloadBytes + ' ', signed.signature), false);
});

test('wire validation refuses hashes, versions, widened effects, paths and missing budgets', () => {
  const mutations = [
    (o) => { o.version = 2; }, (o) => { o.runtime = 'other-runtime'; },
    (o) => { o.prompt.text += 'changed'; }, (o) => { o.diff.sha256 = '0'.repeat(64); },
    (o) => { o.context.text += 'changed'; }, (o) => { o.effectPolicy = 'merge'; },
    (o) => { o.env = { GH_TOKEN: 'synthetic-canary' }; },
    (o) => { o.prompt = { path: '/fixture/prompt' }; }, (o) => { delete o.budget; },
    (o) => { o.budget.timeoutMs = 1_200_001; }, (o) => { o.credential.refreshToken = 'synthetic-canary'; },
    (o) => { o.headSha = ''; }, (o) => { o.epoch = 0; }, (o) => { o.round = -1; },
    (o) => { o.budget.maxOutputBytes = 0; }, (o) => { o.budget.maxArtifactBytes = -1; },
    (o) => { delete o.workOrderHash; }, (o) => { o.budget.maxTokens = 0; },
    (o) => { delete o.budget.maxCostMicrousd; },
  ];
  for (const mutate of mutations) {
    const order = orderFixture();
    mutate(order);
    assert.throws(() => readReviewOrder(JSON.stringify(order)));
  }
  assert.throws(() => readReviewOrder(' '.repeat(MAX_ORDER_BYTES + 1)), /wire budget/);
});

test('signature failure, absent dependencies and cancelled requests never start a child', async () => {
  assert.throws(() => createFederationExecutionAdapter(), /Missing/);
  const fixture = setup();
  fixture.request.signature = signatureFor(fixture.request.orderBytes + ' ');
  await assert.rejects(fixture.execute, /Unauthenticated/);
  fixture.request.signature = signatureFor(fixture.request.orderBytes);
  fixture.request.signal = AbortSignal.abort();
  await assert.rejects(fixture.execute, /cancelled/);
  assert.equal(fixture.service.starts, 0);
});

test('stale preflight refuses start; stale results on head, round, epoch or order retain spend', async () => {
  for (const field of ['headSha', 'round', 'epoch', 'orderHash', 'workOrderHash', 'originInstallId', 'executorInstallId', 'hostId', 'repo', 'prNumber']) {
    let calls = 0;
    let binding;
    const fixture = setup({ readCurrent: async () => {
      calls += 1;
      return calls === 1 ? binding : { ...binding, [field]: 'changed' };
    } });
    binding = fixture.binding;
    const result = await fixture.execute();
    assert.equal(result.status, 'stale', field);
    assert.equal(result.review, null);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.seatRetained, false);
  }
  const early = setup({ readCurrent: async () => null });
  assert.equal((await early.execute()).status, 'stale');
  assert.equal(early.service.starts, 0);
});

test('restart attaches to surviving start permit and never creates another child', async () => {
  const service = fixtureService();
  const original = setup({ service, supervisor: service.supervisor({ crash: true }) });
  const interrupted = await original.execute();
  assert.equal(interrupted.status, 'execution-unknown');
  assert.equal(interrupted.seatRetained, true);
  assert.deepEqual(interrupted.usage, usage);
  const competing = setup({ service, order: orderFixture({ executorInstallId: 'install-c' }) });
  await assert.rejects(competing.execute, /Host occupied/);
  const restarted = setup({ service });
  const attaching = restarted.adapter.execute(original.request);
  // Complete the surviving child; restart consumed the original start identity.
  const startId = service.grants.get(original.request.grantId).startId;
  service.stop(startId);
  const response = await attaching;
  assert.equal(JSON.parse(response.payloadBytes).status, 'completed');
  assert.equal(service.starts, 1);
  assert.equal(service.active.size, 0);
});

test('execution timeout is bounded and retains seat while child survives; late spend remains available', async () => {
  const service = fixtureService();
  const order = orderFixture();
  order.budget.timeoutMs = 50;
  const fixture = setup({ service, order, supervisor: service.supervisor({ hold: true }) });
  const result = await fixture.execute();
  assert.equal(result.status, 'execution-unknown');
  assert.equal(result.seatRetained, true);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.usageComplete, false);
  const startId = service.grants.get(fixture.request.grantId).startId;
  service.stop(startId, { usage: [...usage, { eventId: 'late-1', source: 'provider', quality: 'measured', outputTokens: 25 }] });
  const resumed = await fixture.execute();
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.usage.length, 3);
  assert.equal(service.starts, 1);
});

test('concurrent same-grant retry attaches by start identity and release is idempotent', async () => {
  const fixture = setup();
  const results = await Promise.all([fixture.execute(), fixture.execute()]);
  assert.ok(results.every((result) => result.status === 'completed'));
  assert.equal(fixture.service.starts, 1);
  assert.equal(fixture.service.active.size, 0);
});

test('permit expiry during evidence collection rejects the verdict and retains spend', async () => {
  const service = fixtureService();
  const supervisor = service.supervisor();
  const fixture = setup({ service, supervisor: { ...supervisor, async snapshot(args) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return supervisor.snapshot(args);
  } }, seatTransport: { ...service.transport, async consume(args) {
    return { ...await service.transport.consume(args), validForMs: 25 };
  } } });
  const result = await fixture.execute();
  assert.equal(result.status, 'stale');
  assert.equal(result.review, null);
  assert.deepEqual(result.usage, usage);
});

test('origin or supervisor outages cannot return applicable verdicts or lose known usage', async () => {
  let reads = 0;
  const fixture = setup({ readCurrent: async (binding) => {
    if (++reads > 1) throw new Error('Origin unavailable');
    return binding;
  } });
  const result = await fixture.execute();
  assert.equal(result.status, 'execution-unknown');
  assert.equal(result.review, null);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.seatRetained, true);
  const missing = setup({ supervisor: { run: async () => {}, snapshot: async () => { throw new Error('Unavailable'); } } });
  const unknown = await missing.execute();
  assert.equal(unknown.usageComplete, false);
  assert.equal(unknown.status, 'execution-unknown');
});

test('control calls and signing have deadlines; unavailable preflight never spawns', async () => {
  const never = () => new Promise(() => {});
  for (const dependency of ['verifyOrder', 'readCurrent', 'signResult']) {
    const fixture = setup({ [dependency]: never, controlTimeoutMs: 10 });
    await assert.rejects(fixture.execute, /timed out/);
    assert.equal(fixture.service.starts, dependency === 'signResult' ? 1 : 0);
  }
});

test('quota and 429 pressure applies across hosts sharing the credential and preserves native/estimated usage', async () => {
  for (const diagnostic of ['Quota reached. Resets in 2h', 'Quota reached. Resets at 2025-01-01T00:00:00Z',
    'HTTP 429 too many requests', 'provider overloaded']) {
    const service = fixtureService();
    const fixture = setup({ service, supervisor: service.supervisor({ report: { exitCode: 1, diagnostic } }) });
    const result = await fixture.execute();
    assert.equal(result.status, 'failed');
    assert.ok(Date.parse(result.retryAt) > service.now);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.seatRetained, false);
    if (diagnostic.includes('Resets in')) assert.equal(Date.parse(result.retryAt) - service.now, 2 * 60 * 60 * 1000);
    const otherHost = setup({ service, order: orderFixture({ hostId: 'host-b' }) });
    await assert.rejects(otherHost.execute, /Account throttled/);
    const ownAccount = setup({ service, order: orderFixture({ hostId: 'host-b', credential: { ownerInstallId: 'install-c', id: 'credential-a', generation: 1 } }) });
    assert.equal((await ownAccount.execute()).status, 'completed');
    service.now = Date.parse(result.retryAt);
    // Issue a fresh seat grant after the pressure window (old grant expired).
    assert.equal((await setup({ service, order: orderFixture({ hostId: 'host-b' }) }).execute()).status, 'completed');
  }
});

test('pressure write or seat release failure retains the seat and refuses completion', async () => {
  for (const method of ['defer', 'finish']) {
    const service = fixtureService();
    const fixture = setup({ service,
      supervisor: service.supervisor({ report: method === 'defer' ? { exitCode: 1, diagnostic: 'HTTP 429' } : {} }),
      seatTransport: { ...service.transport, [method]: async () => { throw new Error('Unavailable'); } },
    });
    const result = await fixture.execute();
    assert.equal(result.status, 'execution-unknown');
    assert.equal(result.review, null);
    assert.equal(result.seatRetained, true);
    assert.deepEqual(result.usage, usage);
  }
});

test('invalid verdicts, oversized output and unsafe/oversized artifacts preserve usage without authorizing result', async () => {
  for (const report of [
    { output: 'Narration without verdict.' }, { output: 'x'.repeat(4097) },
    { artifacts: [{ name: '../escape', content: 'fixture' }] },
    { artifacts: [{ name: 'artifact', content: 'x'.repeat(4097) }] },
    { artifacts: [{ name: 'same', content: 'a' }, { name: 'same', content: 'b' }] },
    { terminationProof: 'forged' },
  ]) {
    const service = fixtureService();
    const fixture = setup({ service, supervisor: service.supervisor({ report }) });
    const result = await fixture.execute();
    assert.equal(result.status, 'execution-unknown');
    assert.equal(result.review, null);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.seatRetained, true);
  }
});

test('mismatched supervisor target cannot authorize review or release a seat', async () => {
  const service = fixtureService();
  const fixture = setup({ service, supervisor: service.supervisor({ report: { binding: { headSha: 'b'.repeat(40) } } }) });
  const result = await fixture.execute();
  assert.equal(result.status, 'execution-unknown');
  assert.equal(result.review, null);
  assert.equal(result.seatRetained, true);
  assert.equal(result.usageComplete, false);
  assert.deepEqual(result.usage, usage);
});

test('structured blockers override permissive prose through the shared kernel classifier', async () => {
  const service = fixtureService();
  const fixture = setup({ service, supervisor: service.supervisor({ report: {
    output: '## Summary\nIssue found.\n\n## Blocking issues\n- [P1] fixture.mjs:1 — reject invalid input.\n\n## Verdict\nApprove',
  } }) });
  assert.equal((await fixture.execute()).review.verdict, 'request-changes');
});
