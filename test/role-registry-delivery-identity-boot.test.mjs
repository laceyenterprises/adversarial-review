import assert from 'node:assert/strict';
import test from 'node:test';

import { validateStartupDeliveryIdentity } from '../src/adapters/comms/github-pr-comments/delivery-identity.mjs';

// Review #631: validateStartupDeliveryIdentity must be wired at boot so a
// registry role with no comms delivery identity fails loud at startup, not
// after an expensive review runs and delivery crashes.

// A stub role-config loader: returns roles.registry and roles.delivery_identity
// from the provided maps; validates worker classes against an injected roster.
function stubLoader({ registry = {}, deliveryIdentity = {} } = {}) {
  return () => ({
    get(key, dflt) {
      if (key === 'roles.registry') return registry;
      if (key === 'roles.delivery_identity') return deliveryIdentity;
      if (key === 'roles.routing.never-review-own-builder-class') return true;
      return dflt;
    },
  });
}

const REGISTRY = {
  'code-quality-reviewer': {
    promptSet: 'code-pr',
    workerClass: 'gemini',
    taskKind: 'review',
    completionShape: 'decision-only',
  },
};

test('boot passes when every registered role has a delivery identity', () => {
  assert.doesNotThrow(() =>
    validateStartupDeliveryIdentity({
      loaderImpl: stubLoader({
        registry: REGISTRY,
        deliveryIdentity: { 'code-quality-reviewer': { botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' } },
      }),
      workerClasses: ['gemini'],
    }),
  );
});

test('boot fails loud when a registered role has no delivery identity', () => {
  assert.throws(
    () =>
      validateStartupDeliveryIdentity({
        loaderImpl: stubLoader({ registry: REGISTRY, deliveryIdentity: {} }),
        workerClasses: ['gemini'],
      }),
    /code-quality-reviewer.*no comms delivery identity|has no comms delivery identity binding/,
  );
});

test('boot is a no-op for an empty registry (no roles to bind)', () => {
  assert.doesNotThrow(() =>
    validateStartupDeliveryIdentity({
      loaderImpl: stubLoader({ registry: {}, deliveryIdentity: {} }),
      workerClasses: [],
    }),
  );
});
