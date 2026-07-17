// Fallback canary (ARC-09, SPEC §3 ARC-09 / Win 1). A fallback that only runs
// during a real OS outage rots silently — the day it is finally needed is the
// worst day to discover the local lifeline broke months ago. The canary drives
// a synthetic review through the `local` AgentRuntime on a fixture domain on a
// schedule, asserts it produced a well-formed verdict, records the run, writes a
// status file the `runtime status` CLI surfaces, and ALERTS on failure.
//
// The canary exercises the SAME `local` runtime the router fails over to — its
// admission layer, spawn path, RunResult mapping — not a bypass. In production
// the operator wires a real `createLocalAgentRuntime` (real reviewer CLI on a
// fixture subject). In CI the canary is driven with an injected fixture inner so
// it runs hermetically (no CLI spawn, no network) while still proving the canary
// orchestration + pass/fail + alert-on-failure logic end to end.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../atomic-write.mjs';
import { deliverAlert } from '../../alert-delivery.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from '../../kernel/verdict.mjs';
import { assertCanonicalOwner } from './append-only-owner.mjs';
import { recordRuntimeRun } from './run-ledger.mjs';

const CANARY_STATUS_SCHEMA_VERSION = 1;
const CANARY_STATUS_FILE = ['data', 'runtime-canary-status.json'];
const DEFAULT_CANARY_DOMAIN_ID = 'research-finding';
const DEFAULT_CANARY_TIMEOUT_MS = 5 * 60 * 1000;

// A canned, well-formed review body the fixture reviewer returns. It parses to a
// `comment-only` verdict, so the canary asserts the whole verdict path, not just
// "some string came back".
const FIXTURE_CANARY_REVIEW_BODY = [
  '## Summary',
  'Runtime fallback canary synthetic review — the local lifeline is healthy.',
  '',
  '## Blocking issues',
  '- None.',
  '',
  '## Non-blocking issues',
  '- None.',
  '',
  '## Suggested fixes',
  '- None.',
  '',
  '## Verdict',
  'Comment only',
].join('\n');

function canaryStatusPath(rootDir) {
  return join(rootDir, ...CANARY_STATUS_FILE);
}

function readCanaryStatus(rootDir) {
  try {
    const parsed = JSON.parse(readFileSync(canaryStatusPath(rootDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
}

function writeCanaryStatus(rootDir, status, { ownerGuardOptions } = {}) {
  assertCanonicalOwner(rootDir, canaryStatusPath(rootDir), ownerGuardOptions);
  writeFileAtomic(
    canaryStatusPath(rootDir),
    `${JSON.stringify(status, null, 2)}\n`,
    { overwrite: true },
  );
  return status;
}

// A synthetic reviewer run request on a fixture domain. Deterministic so repeat
// canary runs share an idempotency key namespace (the timestamp disambiguates).
function buildCanaryRequest({
  domainId = DEFAULT_CANARY_DOMAIN_ID,
  now = () => new Date(),
  model = 'canary-fixture',
} = {}) {
  const at = now().toISOString();
  return {
    role: { id: 'reviewer:fallback-canary', kind: 'reviewer', model },
    promptSet: domainId,
    promptStage: 'first',
    subjectContent: {
      ref: {
        domainId,
        subjectExternalId: 'fallback-canary-fixture',
        revisionRef: `canary-${at}`,
      },
      representation: [
        '# Fallback canary fixture subject',
        '',
        'A synthetic subject the local-runtime canary reviews on a schedule so',
        'the outage lifeline is proven healthy before it is ever needed.',
      ].join('\n'),
      observedAt: at,
    },
    idempotencyKey: `fallback-canary:${domainId}:${at}`,
    budget: { maxTokens: 200_000, maxWallMs: DEFAULT_CANARY_TIMEOUT_MS },
    timeoutMs: DEFAULT_CANARY_TIMEOUT_MS,
  };
}

// A cli-direct-shaped inner that returns a canned reviewer result without
// spawning a CLI. Injected into `createLocalAgentRuntime({ cliDirect })` so the
// canary drives the REAL local runtime (admission, RunResult mapping) against a
// deterministic reviewer. Production omits this and spawns for real.
function createFixtureReviewerInner({
  reviewBody = FIXTURE_CANARY_REVIEW_BODY,
  now = () => new Date(),
} = {}) {
  function result(overrides = {}) {
    return {
      ok: true,
      reviewBody,
      remediationBody: null,
      failureClass: null,
      stderrTail: null,
      stdoutTail: null,
      exitCode: 0,
      signal: null,
      pgid: null,
      spawnedAt: now().toISOString(),
      reattachToken: null,
      tokenUsage: { input: 1, output: 1, total: 2, source: 'canary-fixture' },
      ...overrides,
    };
  }
  return {
    async spawnReviewer() { return result(); },
    async spawnRemediator() { return result({ reviewBody: null, remediationBody: 'ok' }); },
    async reattach() { return result(); },
    async cancel() {},
    describe() {
      return { capabilities: { processGroupIsolation: true, oauthStripEnforced: true } };
    },
  };
}

function verdictKindOf(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;
  try {
    return normalizeReviewVerdict(extractReviewVerdict(body));
  } catch {
    return null;
  }
}

// Run one canary cycle. Returns a structured result and (as a side effect)
// writes the status file, records a ledger run, and — on failure — pages.
async function runFallbackCanary({
  rootDir,
  localRuntime,
  domainId = DEFAULT_CANARY_DOMAIN_ID,
  now = () => new Date(),
  nowMs = () => Date.now(),
  deliverAlertFn = deliverAlert,
  recordRunImpl = recordRuntimeRun,
  buildRequest = buildCanaryRequest,
  logger = console,
} = {}) {
  if (!rootDir) throw new TypeError('runFallbackCanary requires rootDir');
  if (!localRuntime || typeof localRuntime.run !== 'function') {
    throw new TypeError('runFallbackCanary requires a local AgentRuntime');
  }

  const request = buildRequest({ domainId, now });
  const startedMs = nowMs();
  const at = now().toISOString();

  let result = null;
  let failure = null;
  try {
    const handle = await localRuntime.run(request);
    result = await handle.await();
  } catch (err) {
    failure = err?.message || String(err);
  }
  const durationMs = Math.max(0, nowMs() - startedMs);

  const mode = result?.runtimeMode || 'local';
  const verdictKind = result ? verdictKindOf(result?.artifact?.body) : null;

  let pass = false;
  let detail;
  if (failure) {
    detail = `local runtime threw: ${failure}`;
  } else if (result?.status !== 'completed') {
    detail = `local runtime did not complete: status=${result?.status ?? 'none'}`
      + (result?.detail ? ` (${result.detail})` : '');
  } else if (!verdictKind || verdictKind === 'unknown') {
    detail = 'local runtime completed but produced no parseable verdict';
  } else {
    pass = true;
    detail = `local fixture review, verdict=${verdictKind}`;
  }

  const status = {
    schema_version: CANARY_STATUS_SCHEMA_VERSION,
    status: pass ? 'pass' : 'fail',
    at,
    durationMs,
    domainId,
    mode,
    verdictKind: verdictKind ?? null,
    detail,
  };

  // Best-effort persistence — a status-write failure must not mask the canary
  // outcome (which still pages below), but is logged.
  try {
    writeCanaryStatus(rootDir, status);
  } catch (err) {
    logger?.error?.('[fallback-canary] failed to write canary status file', {
      error: err?.message || String(err),
    });
  }
  try {
    recordRunImpl(rootDir, {
      at,
      mode,
      status: pass ? 'completed' : (result?.status ?? 'failed'),
      domainId,
      kind: 'reviewer',
      idempotencyKey: request.idempotencyKey,
      canary: true,
    }, { now });
  } catch (err) {
    logger?.warn?.('[fallback-canary] failed to record canary run in ledger', {
      error: err?.message || String(err),
    });
  }

  if (!pass) {
    const text = [
      'Adversarial runtime fallback canary FAILED.',
      `Domain: ${domainId}`,
      `Detail: ${detail}`,
      `Duration: ${Math.round(durationMs / 1000)}s`,
      `At: ${at}`,
      '',
      'The local outage-lifeline runtime did not produce a healthy synthetic',
      'review. Fix the local runtime before the next OS outage forces failover.',
    ].join('\n');
    try {
      await deliverAlertFn(text, {
        event: 'runtime.canary.failed',
        payload: status,
      });
    } catch (err) {
      logger?.error?.('[fallback-canary] alert delivery failed', {
        error: err?.message || String(err),
      });
    }
  }

  return { ok: pass, status, result, durationMs, request };
}

export {
  CANARY_STATUS_SCHEMA_VERSION,
  DEFAULT_CANARY_DOMAIN_ID,
  FIXTURE_CANARY_REVIEW_BODY,
  buildCanaryRequest,
  canaryStatusPath,
  createFixtureReviewerInner,
  readCanaryStatus,
  runFallbackCanary,
  writeCanaryStatus,
};
