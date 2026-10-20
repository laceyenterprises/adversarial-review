import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostSeatClient } from '../src/adapters/reviewer-runtime/federation-execution/host-seat-client.mjs';
import { fixtureService, orderFixture, setup } from './fixtures/federation-execution.mjs';

test('one host admits one seat across installs/users; distinct hosts admit independently', async () => {
  const service = fixtureService();
  const contenders = ['install-b', 'install-c'].map((executorInstallId) => setup({ service, order: orderFixture({ executorInstallId }) }));
  const client = createHostSeatClient(service.transport);
  const outcomes = await Promise.allSettled(contenders.map(({ request, binding }, index) =>
    createHostSeatClient(service.forUser(`user-${index}`)).consume({ grantId: request.grantId, binding })));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(service.active.size, 1);
  assert.deepEqual(service.callers.map((caller) => caller.user), ['user-0', 'user-1']);
  const independent = setup({ service, order: orderFixture({ hostId: 'host-b' }) });
  await client.consume({ grantId: independent.request.grantId, binding: independent.binding });
  assert.equal(service.active.size, 2);
});

test('unknown, expired and differently bound grants fail before start', async () => {
  for (const kind of ['unknown', 'expired', 'binding']) {
    const fixture = setup();
    if (kind === 'unknown') fixture.request.grantId = 'missing-grant';
    if (kind === 'expired') fixture.service.now += 60_000;
    if (kind === 'binding') fixture.service.grants.get(fixture.request.grantId).binding = { ...fixture.binding, epoch: 99 };
    await assert.rejects(fixture.execute, /Invalid grant/);
    assert.equal(fixture.service.starts, 0);
  }
});

test('client refuses malformed or mismatched authenticated service permits', async () => {
  for (const mutation of [
    (p) => { p.version = 2; }, (p) => { p.binding.headSha = 'b'.repeat(40); },
    (p) => { p.binding.credential.generation = 4; }, (p) => { p.validForMs = 0; },
    (p) => { p.validForMs = 1_200_001; }, (p) => { p.startId = ''; },
    (p) => { p.extra = true; }, (p) => { p.grantId = 'wrong-grant'; },
  ]) {
    const fixture = setup();
    const transport = { ...fixture.service.transport, async consume(args) {
      const permit = structuredClone(await fixture.service.transport.consume(args));
      mutation(permit);
      return permit;
    } };
    const client = createHostSeatClient(transport);
    await assert.rejects(client.consume({ grantId: fixture.request.grantId, binding: fixture.binding }));
  }
});

test('seat release requires service-verified child termination; expiry alone cannot release', async () => {
  const service = fixtureService();
  const fixture = setup({ service, supervisor: service.supervisor({ crash: true }) });
  const result = await fixture.execute();
  const client = createHostSeatClient(service.transport);
  const permit = await client.consume({ grantId: fixture.request.grantId, binding: fixture.binding });
  assert.equal(result.seatRetained, true);
  await assert.rejects(client.finish({ permit, terminationProof: `stopped-${permit.startId}` }), /death unproven/);
  await assert.rejects(client.finish({ permit, terminationProof: true }), /Missing termination proof/);
  service.now += 60_000;
  const sibling = setup({ service, order: orderFixture({ orderId: 'order-b', executorInstallId: 'install-c' }) });
  await assert.rejects(sibling.execute, /Host occupied/);
  service.stop(permit.startId);
  await client.finish({ permit, terminationProof: `stopped-${permit.startId}` });
  await client.finish({ permit, terminationProof: `stopped-${permit.startId}` });
  assert.equal(service.active.size, 0);
});

test('missing client methods and unacknowledged control writes fail closed', async () => {
  assert.throws(() => createHostSeatClient({}), /Missing/);
  const fixture = setup();
  const client = createHostSeatClient({ ...fixture.service.transport, finish: async () => ({}), defer: async () => ({}) });
  const permit = await client.consume({ grantId: fixture.request.grantId, binding: fixture.binding });
  await assert.rejects(client.finish({ permit, terminationProof: 'proof' }), /not released/);
  await assert.rejects(client.defer({ permit, retryAt: 'invalid' }), /Invalid pressure/);
  await assert.rejects(client.defer({ permit, retryAt: new Date().toISOString(), failureClass: 'cascade' }), /not recorded/);
});
