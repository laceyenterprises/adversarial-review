import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_APP_CONTRACT_MODE,
  DEFAULT_APP_CONTRACT_SUBSCRIPTIONS,
  DEFAULT_APP_CONTRACT_VERSION,
  resolveAppContractRegistration,
} from '../src/app-registration.mjs';

test('resolveAppContractRegistration fallback preserves the requested app id', () => {
  const registration = resolveAppContractRegistration({
    appId: 'fixture-app',
    loadConfigImpl: () => ({
      get() {
        return null;
      },
      sources: {},
    }),
  });

  assert.deepEqual(registration, {
    app_id: 'fixture-app',
    mode: DEFAULT_APP_CONTRACT_MODE,
    subscribes: [...DEFAULT_APP_CONTRACT_SUBSCRIPTIONS],
    contract_version: DEFAULT_APP_CONTRACT_VERSION,
    registered: false,
    source: 'default',
  });
});

test('resolveAppContractRegistration non-authoritative fallback preserves the requested app id', () => {
  const registration = resolveAppContractRegistration({
    appId: 'fixture-app',
    loadConfigImpl: () => ({
      get(key, defaultValue = null) {
        return key === 'apps.fixture-app'
          ? {
              mode: 'standalone',
              subscribes: ['fixture.topic'],
              contract_version: '9.9',
            }
          : defaultValue;
      },
      sources: {},
    }),
  });

  assert.equal(registration.app_id, 'fixture-app');
  assert.equal(registration.mode, DEFAULT_APP_CONTRACT_MODE);
  assert.deepEqual(registration.subscribes, [...DEFAULT_APP_CONTRACT_SUBSCRIPTIONS]);
  assert.equal(registration.contract_version, DEFAULT_APP_CONTRACT_VERSION);
  assert.equal(registration.registered, false);
});
