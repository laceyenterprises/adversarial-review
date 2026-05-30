// CFG-09 test helper — per-test reset for the role-config cascade cache.
//
// **Default behavior: importing this module installs `beforeEach` +
// `afterEach` hooks for the importing test file** so the cache is
// empty when each test starts AND cannot leak into the next file that
// runs in the same node process. Test files that mutate
// `process.env` (or otherwise need pristine resolution state) between
// cases should add a single side-effect import at the top:
//
//     import '../helpers/role-config-cache-reset.mjs';
//
// That's it — no function call required. This is the suite-wide
// safety net the CFG-09 round-2 reviewer flagged: future test
// authors only need to remember a one-line import, not a multi-line
// `beforeEach` block, and the import location is the natural place to
// notice the contract exists.
//
// Why this isn't truly suite-wide. `node:test` `beforeEach` only
// applies to the test-context it's registered in; the per-worker
// isolation that node uses for `--test` means a hook registered in
// a preload module via `--import` does NOT propagate to the test
// file's own root suite. The per-file side-effect import is the
// closest robust pattern node:test supports today.
//
// Tests that ALREADY inject a custom `loaderImpl` (e.g. via a stub
// loader) bypass the cache entirely and do not need this helper.
//
// Tests that need to ASSERT the documented stale-cache contract (the
// "env mutation without reset returns stale cached value" test in
// `test/role-config-cache.test.mjs`) reset the cache themselves
// inside the test body. The `beforeEach` reset here is harmless for
// those — it runs BEFORE the test body, which then exercises whatever
// cache state the test wants.

import { afterEach, beforeEach } from 'node:test';

import { resetRoleConfigCache } from '../../src/role-config.mjs';

export { resetRoleConfigCache };

// Auto-install on import. The reviewer's round-2 finding #6 was that
// the per-file opt-in via explicit `installCacheResetHooks()` call (or
// inline `beforeEach(resetRoleConfigCache)`) is easy for a future test
// author to forget. Auto-install on import keeps the opt-in to a
// single discoverable line at the top of the file.
beforeEach(resetRoleConfigCache);
afterEach(resetRoleConfigCache);

// installCacheResetHooks — legacy entry kept for back-compat with the
// CFG-09 round-1 callers. Hooks are already installed by the
// module-import side effect above; this function is a no-op so existing
// callsites continue to compile without behavior change.
export function installCacheResetHooks() {
  // intentional no-op; auto-installed on module import.
}
