// Explicit registry producer for older offline routing/worker fixtures. Registry
// outage/cache tests install their own transport and never import this helper.
import { beforeEach } from 'node:test';
import { dispatchReadTransport } from '../../src/dispatch-read-client.mjs';
import { prefetchWorkerRegistry } from '../../src/adapters/agent-runtime/local/remediation.mjs';

import { registryProducerSdk } from './registry-classes-fixture.mjs';

beforeEach(async t => {
  const sdk = registryProducerSdk(dispatchReadTransport.sdk());
  t.mock.method(dispatchReadTransport, 'sdk', () => sdk);
  await prefetchWorkerRegistry();
  await prefetchWorkerRegistry({env: {}});
});
