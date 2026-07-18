// Reviewer-runtime adapter lifecycle, extracted from watcher.mjs (ARC-18).
//
// Owns the process-wide reviewer-runtime adapter singleton, its orchestration-mode
// refresh cache, per-domain isolated adapters, and the config/adapter
// failure-signal counters. All of that mutable state lives here (private to this
// module, except the `reviewerRuntimeState` object, which the watcher imports to
// read the current `.adapter`).
//
// Lazy init: the primary domain id is derived in watcher bootstrap (from the
// enabled-domain registry) AFTER this module loads, so the adapter starts null
// and the watcher calls initReviewerRuntime({ rootDir, primaryDomainId }) once,
// immediately after deriving WATCHER_PRIMARY_DOMAIN_ID and before the poll loop.
// Nothing may call the reader/refresh functions before init runs.
//
// Behavior is preserved exactly; parity is verified by
// reviewer-runtime-adapter.test.mjs, reviewer-fence.test.mjs, and
// watcher-fast-merge.test.mjs (via pollOnce), which reach these through the
// re-exports from watcher.mjs.

import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReviewerRuntimeAdapterByName,
  createReviewerRuntimeAdapterForDomain,
} from './adapters/reviewer-runtime/index.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { loadDomainConfig } from './domain-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Set by initReviewerRuntime() from the watcher's bootstrap-derived primary
// domain id. Used as the default domain for every reviewer-runtime lookup.
let primaryDomainId = null;

export const reviewerRuntimeState = {
  adapter: null,
  adapterCache: null,
  configFailureSignal: { key: null, count: 0 },
  adapterFailureSignal: { key: null, count: 0 },
};
const secondaryReviewerRuntimeAdapterCache = new Map();
let lastKnownReviewerOrchestrationMode = 'native';
let activeReviewerRuntimeOrchestrationMode = 'native';
const reviewerRuntimeAdapterByNameCache = new Map();

// One-time bootstrap wiring, called by the watcher after it derives the primary
// domain id. Populates the process-wide adapter for that domain.
export function initReviewerRuntime({ rootDir = ROOT, primaryDomainId: pdi } = {}) {
  primaryDomainId = pdi;
  reviewerRuntimeState.adapter = createReviewerRuntimeAdapterForDomain({
    rootDir,
    domainId: pdi,
    logger: console,
  });
  return reviewerRuntimeState.adapter;
}

function reviewerRuntimeDomainMtimeMs(rootDir = ROOT, domainId = primaryDomainId) {
  return statSync(join(rootDir, 'domains', `${domainId}.json`)).mtimeMs;
}

function shouldEmitReviewerRuntimeFailureSignal(count) {
  return count <= 2 || count === 5 || count % 10 === 0;
}

function recordReviewerRuntimeFailureSignal({ kind, key, message, logger }) {
  const state = kind === 'config'
    ? reviewerRuntimeState.configFailureSignal
    : reviewerRuntimeState.adapterFailureSignal;
  if (state.key === key) {
    state.count += 1;
  } else {
    state.key = key;
    state.count = 1;
  }
  if (shouldEmitReviewerRuntimeFailureSignal(state.count)) {
    logger?.error?.(
      `[watcher] ALERT reviewer runtime ${kind} degraded consecutive=${state.count}: ${message}`
    );
  }
}

function clearReviewerRuntimeFailureSignal(kind) {
  if (kind === 'config') {
    reviewerRuntimeState.configFailureSignal = { key: null, count: 0 };
  } else {
    reviewerRuntimeState.adapterFailureSignal = { key: null, count: 0 };
  }
}

function reviewerRuntimeAdapterId(adapter = reviewerRuntimeState.adapter) {
  try {
    return adapter?.describe?.()?.id || null;
  } catch {
    return null;
  }
}

function signalReviewerRuntimeDomainConfigFailure({
  rootDir = ROOT,
  domainId = primaryDomainId,
  err,
  phase,
  logger = console,
} = {}) {
  const errorMessage = String(err?.message || err);
  recordReviewerRuntimeFailureSignal({
    kind: 'adapter',
    key: `domain-config:${rootDir}:${domainId}:${phase}:${errorMessage}`,
    logger,
    message:
      `domain=${domainId} reviewer runtime config unavailable during ${phase}; ` +
      `per-record recovery/cancel will isolate affected records until the shared config is readable: ` +
      errorMessage
  });
}

export function reviewerRuntimeAdapterForRunRecord(record = null, {
  rootDir = ROOT,
  logger = console,
  resolveDomainAdapterImpl = resolveReviewerRuntimeAdapterForDomainId,
} = {}) {
  const runtime = String(record?.runtime || '').trim();
  if (!runtime) return reviewerRuntimeState.adapter;
  if (runtime === reviewerRuntimeAdapterId(reviewerRuntimeState.adapter)) {
    return reviewerRuntimeState.adapter;
  }
  const domainId = record?.domain || primaryDomainId;
  if (domainId !== primaryDomainId) {
    const domainAdapter = resolveDomainAdapterImpl(domainId, { rootDir, logger });
    if (runtime === reviewerRuntimeAdapterId(domainAdapter)) return domainAdapter;
  }
  let domainMtimeMs = null;
  try {
    domainMtimeMs = reviewerRuntimeDomainMtimeMs(rootDir, domainId);
  } catch (err) {
    signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'mtime', logger });
    throw err;
  }

  const domainCacheKey = `${rootDir}\0${domainId}`;
  let domainCache = reviewerRuntimeAdapterByNameCache.get(domainCacheKey);
  if (!domainCache || domainCache.domainMtimeMs !== domainMtimeMs) {
    domainCache = { domainMtimeMs, adaptersByRuntime: new Map() };
    reviewerRuntimeAdapterByNameCache.set(domainCacheKey, domainCache);
  }
  if (!domainCache.adaptersByRuntime.has(runtime)) {
    let domainConfig = null;
    try {
      domainConfig = loadDomainConfig(rootDir, domainId);
    } catch (err) {
      signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'load', logger });
      throw err;
    }
    domainCache.adaptersByRuntime.set(runtime, createReviewerRuntimeAdapterByName(runtime, {
      rootDir,
      domainConfig,
      logger,
    }));
  }
  return domainCache.adaptersByRuntime.get(runtime);
}

// ARC-03: resolve the reviewer-runtime adapter for a specific enabled domain.
// The primary (github-pr) domain reuses the refreshed process-wide singleton;
// any other enabled domain gets its own isolated, mtime-refreshed cached adapter,
// so per-domain runtime selection never bleeds across domains and poll ticks do
// not discard adapter-owned pools, caches, or leases.
export function resolveReviewerRuntimeAdapterForDomainId(domainId, {
  rootDir = ROOT,
  logger = console,
  loadDomainConfigImpl = loadDomainConfig,
  createAdapterImpl = createReviewerRuntimeAdapterForDomain,
  domainMtimeImpl = reviewerRuntimeDomainMtimeMs,
} = {}) {
  if (!domainId || domainId === primaryDomainId) {
    return reviewerRuntimeState.adapter;
  }
  const cacheKey = `${rootDir}\0${domainId}`;
  const cached = secondaryReviewerRuntimeAdapterCache.get(cacheKey);
  // A broken or mid-swap secondary domain config must never abort the whole
  // poll tick (review finding on #615): keep serving the cached adapter and
  // signal the failure instead. Only an uncached domain with a broken config
  // yields null, and callers skip that domain for the tick.
  let domainMtimeMs;
  try {
    domainMtimeMs = domainMtimeImpl(rootDir, domainId);
  } catch (err) {
    signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'mtime', logger });
    return cached ? cached.adapter : null;
  }
  if (
    cached?.domainMtimeMs === domainMtimeMs &&
    cached?.orchestrationMode === activeReviewerRuntimeOrchestrationMode
  ) return cached.adapter;

  let adapter;
  try {
    const domainConfig = loadDomainConfigImpl(rootDir, domainId);
    adapter = createAdapterImpl({
      rootDir,
      domainId,
      domainConfig,
      logger,
      orchestrationMode: activeReviewerRuntimeOrchestrationMode,
    });
  } catch (err) {
    signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'load', logger });
    return cached ? cached.adapter : null;
  }
  secondaryReviewerRuntimeAdapterCache.set(cacheKey, {
    domainMtimeMs,
    orchestrationMode: activeReviewerRuntimeOrchestrationMode,
    adapter,
  });
  return adapter;
}

export function refreshReviewerRuntimeAdapter({
  rootDir = ROOT,
  logger = console,
  loadConfigImpl = loadConfigCached,
  createAdapterImpl = createReviewerRuntimeAdapterForDomain,
  domainMtimeImpl = reviewerRuntimeDomainMtimeMs,
} = {}) {
  let orchestrationMode = lastKnownReviewerOrchestrationMode || 'native';
  try {
    orchestrationMode = loadConfigImpl().getOrchestrationMode();
    clearReviewerRuntimeFailureSignal('config');
  } catch (err) {
    const errorMessage = String(err?.message || err);
    recordReviewerRuntimeFailureSignal({
      kind: 'config',
      key: errorMessage,
      logger,
      message:
        `config key=roles.adversarial.orchestration_mode failed (${errorMessage}); ` +
        `keeping reviewer runtime orchestration_mode=${orchestrationMode}; ` +
        `broker token refresh still runs, but later strict config reads may stall review work`
    });
  }

  let domainMtimeMs = null;
  try {
    domainMtimeMs = domainMtimeImpl(rootDir, primaryDomainId);
    if (
      reviewerRuntimeState.adapterCache?.adapter &&
      reviewerRuntimeState.adapterCache.orchestrationMode === orchestrationMode &&
      reviewerRuntimeState.adapterCache.domainMtimeMs === domainMtimeMs
    ) {
      lastKnownReviewerOrchestrationMode = orchestrationMode;
      activeReviewerRuntimeOrchestrationMode = orchestrationMode;
      reviewerRuntimeState.adapter = reviewerRuntimeState.adapterCache.adapter;
      clearReviewerRuntimeFailureSignal('adapter');
      return reviewerRuntimeState.adapter;
    }

    reviewerRuntimeState.adapter = createAdapterImpl({
      rootDir,
      domainId: primaryDomainId,
      logger,
      orchestrationMode,
    });
    reviewerRuntimeState.adapterCache = {
      adapter: reviewerRuntimeState.adapter,
      domainMtimeMs,
      orchestrationMode,
    };
    lastKnownReviewerOrchestrationMode = orchestrationMode;
    activeReviewerRuntimeOrchestrationMode = orchestrationMode;
    clearReviewerRuntimeFailureSignal('adapter');
  } catch (err) {
    const errorMessage = String(err?.message || err);
    if (orchestrationMode !== activeReviewerRuntimeOrchestrationMode) {
      recordReviewerRuntimeFailureSignal({
        kind: 'adapter',
        key: `${orchestrationMode}->${activeReviewerRuntimeOrchestrationMode}:${errorMessage}`,
        logger,
        message:
          `requested orchestration_mode=${orchestrationMode} but active adapter remains ` +
          `${activeReviewerRuntimeOrchestrationMode}; first-pass reviews continue through the ` +
          `active adapter until refresh succeeds: ${errorMessage}`
      });
    } else {
      recordReviewerRuntimeFailureSignal({
        kind: 'adapter',
        key: `${orchestrationMode}->${activeReviewerRuntimeOrchestrationMode}:${errorMessage}`,
        logger,
        message:
          `orchestration_mode=${orchestrationMode} adapter refresh failed; keeping existing adapter: ` +
          errorMessage
      });
    }
  }
  return reviewerRuntimeState.adapter;
}
