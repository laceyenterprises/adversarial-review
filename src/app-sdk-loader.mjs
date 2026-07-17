// Lazy loader for @agent-os/app-sdk.
//
// The SDK is consumed as a `file:` tarball dependency (ARC-24). A daemon that
// only ever runs local-mode reviews (the OS-outage lifeline) must NOT depend
// on that package being installed in the deployed submodule's node_modules —
// but a top-level `import { connect } from '@agent-os/app-sdk'` executes at
// module load and takes the whole watcher/follow-up daemon down with an
// ERR_MODULE_NOT_FOUND when node_modules is unpopulated (2026-07-17 SEV:
// main-catchup deploys source but does not `npm ci` submodules).
//
// Resolving the SDK lazily means the daemon loads regardless; only the
// os-dispatch path — which the health router gates behind OS mode and which
// fails over to local on error — actually needs the package present.
let _connectPromise = null;

/**
 * Resolve the app-sdk `connect` function, importing the package on first use
 * and caching the result. Throws only if a caller actually invokes it while
 * the package is unavailable (that error is caught by the os-dispatch runtime,
 * which fails the router over to local mode).
 *
 * @returns {Promise<Function>}
 */
export async function loadAppSdkConnect() {
  if (!_connectPromise) {
    _connectPromise = import('@agent-os/app-sdk')
      .then((mod) => mod.connect)
      .catch((err) => {
        _connectPromise = null; // allow a later call to retry the import
        throw err;
      });
  }
  return _connectPromise;
}
