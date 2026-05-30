// CFG-09 test helper — opt-in per-test reset for the role-config
// cascade cache.
//
// Tests that mutate `process.env` (or otherwise need pristine
// resolution state) between cases should call `installCacheResetHooks`
// at the top of the file or call `resetRoleConfigCache` from a
// per-test cleanup. The cache is keyed by call shape, not env content,
// so an env mutation without a reset returns the previously cached
// value — this is the documented CFG-09 contract, not a regression.
//
// Tests that already inject a custom `loaderImpl` (e.g. via a stub
// loader) bypass the cache entirely and do not need this helper.

import { afterEach, beforeEach } from 'node:test';

import { resetRoleConfigCache } from '../../src/role-config.mjs';

export { resetRoleConfigCache };

// installCacheResetHooks — wires `resetRoleConfigCache` into both
// `beforeEach` and `afterEach` for the current test file so the cache
// is empty when each test starts AND cannot leak into the next file
// that runs in the same node process.
export function installCacheResetHooks() {
  beforeEach(resetRoleConfigCache);
  afterEach(resetRoleConfigCache);
}
