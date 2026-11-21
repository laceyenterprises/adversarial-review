import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import {
  closerQuotaSnapshotPath,
  resolveHarnessAfterResolverError,
} from '../src/ama/harness-fallback.mjs';
import { resolveMergeAgentDispatchHarness } from '../src/merge-agent-harness.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';

// CLOSERFALLBACKFAILOPEN-01: a closer harness-resolver error must never fall
// open to a primary whose provider the persisted quota snapshot says is
// hard-stopped. Synthetic state only; every call goes through the real
// maybeDispatchAmaCloser / resolver-error helper.

const NOW = Date.parse('2026-11-21T15:00:00Z');
const HEAD = 'b'.repeat(40);
const GATE = 'agent-os/adversarial-gate';
const USER = userInfo().username || process.env.USER || 'unknown';
const FALLBACKS = ['hammer-claude-corp', 'hammer'];
const TRANSIENT = Object.assign(new Error('dispatch-read-unavailable: transient dispatch lookup failure'), {});

function row(provider, authPath, state, extra = {}) {
  return { provider, authPath, state, lastProbeAt: '2026-11-21T14:59:00Z', ...extra };
}

function scratch(t, { ageMs = 60_000, rows, at = NOW } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-failopen-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  if (rows) {
    const file = closerQuotaSnapshotPath(rootDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ readAt: at - ageMs, payload: { providerStatuses: rows } }));
  }
  return rootDir;
}

const EXHAUSTED_PRIMARY = [
  row('openai', 'oauth-corp', 'exhausted', { source: 'operator' }),
  row('anthropic', 'oauth-corp', 'ok'),
  row('openai', 'oauth', 'ok'),
];

function decide(rootDir, overrides = {}) {
  return resolveHarnessAfterResolverError({ workerClass: 'hammer-corp', fallbackWorkerClasses: FALLBACKS,
    rootDir, error: TRANSIENT, nowMs: () => NOW, ...overrides });
}

test('resolver error + primary exhausted in the persisted snapshot selects the configured fallback', t => {
  const result = decide(scratch(t, { rows: EXHAUSTED_PRIMARY }));
  assert.equal(result.fellBack, true);
  assert.equal(result.workerClass, 'hammer-claude-corp');
  assert.equal(result.from, 'hammer-corp');
  assert.equal(result.primaryState, 'exhausted');
  assert.equal(result.groundedBy, 'hard');
  assert.equal(result.evidenceSource, 'last-good-snapshot');
  assert.match(result.error, /dispatch-read-unavailable/);
  assert.equal(result.resolverErrorDecision, 'fallback:hammer-claude-corp');
});

test('resolver error + fallback also grounded skips it, and defers when none is left', t => {
  const skipped = decide(scratch(t, { rows: [EXHAUSTED_PRIMARY[0], row('anthropic', 'oauth-corp', 'exhausted'),
    row('openai', 'oauth', 'ok')] }));
  assert.equal(skipped.workerClass, 'hammer');
  assert.equal(skipped.fellBack, true);
  const none = decide(scratch(t, { rows: [EXHAUSTED_PRIMARY[0], row('anthropic', 'oauth-corp', 'exhausted'),
    row('openai', 'oauth', 'exhausted')] }));
  assert.equal(none.hold, true);
  assert.equal(none.fellBack, false);
  assert.equal(none.reason, 'all-fallbacks-grounded');
  assert.equal(none.resolverErrorDecision, 'defer:all-fallbacks-grounded');
});

test('resolver error + unknown primary state defers instead of dispatching the primary', t => {
  for (const rootDir of [scratch(t), scratch(t, { rows: EXHAUSTED_PRIMARY, ageMs: 11 * 60_000 }), null]) {
    const result = decide(rootDir);
    assert.equal(result.hold, true);
    assert.equal(result.fellBack, false);
    assert.equal(result.reason, 'harness-fallback-resolver-error');
    assert.equal(result.resolverErrorDecision, 'defer:primary-state-unknown');
    assert.match(result.error, /transient dispatch lookup failure/);
  }
});

test('resolver error + primary known healthy keeps the pre-existing fail-open', t => {
  const result = decide(scratch(t, { rows: [row('openai', 'oauth-corp', 'ok'), row('anthropic', 'oauth-corp', 'ok')] }));
  assert.equal(result.hold, undefined);
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer-corp');
  assert.equal(result.resolverErrorDecision, 'keep-primary:primary-not-grounded');
});

function dispatchHarness(rootDir) {
  const calls = [];
  const events = [];
  const base = {
    reviewState: { verdict: 'request changes', headSha: HEAD, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 1, nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0, operatorApprovedEvidence: null, prAuthor: 'builder', reviewCycleExhausted: true },
    prMetadata: { prNumber: 404, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], statusCheckRollup: [{ __typename: 'CheckRun', name: GATE, conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [GATE] }, author: 'builder' },
    cfg: { enabled: true, workerClass: 'hammer-corp', workerClassFallback: FALLBACKS, mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: true } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: GATE } },
    dispatchContext: { rootDir, repo: 'acme/repo', prUrl: 'https://github.com/acme/repo/pull/404', reviewedSha: HEAD,
      riskClass: 'low', requiredGateContext: GATE, reviewedBy: 'codex-reviewer-lacey', reviewer: 'codex',
      parentSession: 'session:test:watcher', hqPath: '/bin/hq-test', hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: USER, currentUser: USER, closerTokenRollupPollDelaysMs: [], dispatchedAt: '2026-11-21T15:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/live' }) },
  };
  const deps = {
    deliverAlertImpl: async () => {},
    readPullRequestStateImpl: () => null,
    processExecFileImpl: async () => ({ stdout: 'Thu Nov 21 15:00:00 2026\n' }),
    execFileImpl: async (cmd, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ ticketRef: 'AMA-PR-404', dispatchId: 'lrq_synthetic', launchRequestId: 'lrq_synthetic' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveOsgRemediatorRouteImpl: async ({ current }) => current,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info: e => events.push(e), warn: e => events.push(e), error() {} },
  };
  return { ...base, ...deps, calls, events };
}

function resolverErrorEvent(events) {
  return events.flatMap(e => { try { return [JSON.parse(e)]; } catch { return []; } })
    .find(e => e.event === 'ama_closer.harness_fallback_resolver_error');
}

const throwingResolver = async () => { throw TRANSIENT; };
const workerClassOf = args => args[args.indexOf('--worker-class') + 1];

test('maybeDispatchAmaCloser: resolver throws + primary exhausted dispatches the fallback and logs the error', async t => {
  const input = dispatchHarness(scratch(t, { rows: EXHAUSTED_PRIMARY, at: Date.now() }));
  const result = await maybeDispatchAmaCloser({ ...input, resolveCloserDispatchHarnessImpl: throwingResolver });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const dispatch = input.calls.find(args => args[0] === 'dispatch');
  assert.equal(workerClassOf(dispatch), 'hammer-claude-corp');
  const logged = resolverErrorEvent(input.events);
  assert.ok(logged, 'resolver error is logged');
  assert.match(logged.error, /dispatch-read-unavailable/);
  assert.equal(logged.decision, 'fallback:hammer-claude-corp');
  assert.ok(input.events.some(e => String(e).includes('ama_closer.harness_fallback"')));
});

test('maybeDispatchAmaCloser: resolver throws + unknown primary state defers, never dispatches the primary', async t => {
  const rootDir = scratch(t);
  const input = dispatchHarness(rootDir);
  const result = await maybeDispatchAmaCloser({ ...input, resolveCloserDispatchHarnessImpl: throwingResolver });
  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'harness-hold:harness-fallback-resolver-error');
  assert.equal(input.calls.length, 0, 'no hq dispatch call');
  const audit = readAmaAuditEntry(input.dispatchContext.hqRoot, 'acme/repo', 404, HEAD);
  assert.equal(audit.status, 'deferred');
  const logged = resolverErrorEvent(input.events);
  assert.equal(logged.decision, 'defer:primary-state-unknown');
});

test('maybeDispatchAmaCloser: a resolver that succeeds is unchanged', async t => {
  const input = dispatchHarness(scratch(t));
  const result = await maybeDispatchAmaCloser({ ...input,
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }) });
  assert.equal(result.dispatched, true);
  assert.equal(workerClassOf(input.calls.find(args => args[0] === 'dispatch')), 'hammer-corp');
  assert.equal(input.events.some(e => String(e).includes('harness_fallback_resolver_error')), false);
});

test('merge-agent: a resolver error with a grounded persisted primary takes the fallback or defers; unknown state still fails open', async t => {
  const warnings = [];
  const common = { workerClass: 'hammer-corp', fallbackWorkerClasses: FALLBACKS, logger: { warn: message => warnings.push(message) },
    resolveHarnessImpl: throwingResolver };
  const at = Date.now();
  const unknown = await resolveMergeAgentDispatchHarness({ ...common, rootDir: scratch(t) });
  assert.equal(unknown.workerClass, 'hammer-corp');
  assert.equal(unknown.deferred, false);
  assert.match(warnings[0], /harness_fallback_resolver_error defer:primary-state-unknown:/);
  const fellBack = await resolveMergeAgentDispatchHarness({ ...common,
    rootDir: scratch(t, { rows: EXHAUSTED_PRIMARY, at }) });
  assert.equal(fellBack.workerClass, 'hammer-claude-corp');
  assert.equal(fellBack.fellBack, true);
  assert.equal(fellBack.deferred, false);
  const deferred = await resolveMergeAgentDispatchHarness({ ...common, rootDir: scratch(t, { at, rows: [
    EXHAUSTED_PRIMARY[0], row('anthropic', 'oauth-corp', 'exhausted'), row('openai', 'oauth', 'exhausted')] }) });
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.reason, 'merge-agent-harness-grounded');
});

test('merge-agent: the normal resolver receives the quota snapshot root', async t => {
  const rootDir = scratch(t);
  const result = await resolveMergeAgentDispatchHarness({
    workerClass: 'hammer-corp',
    fallbackWorkerClasses: FALLBACKS,
    rootDir,
    async resolveHarnessImpl({ workerClass, rootDir: resolverRoot }) {
      assert.equal(resolverRoot, rootDir);
      return { workerClass, fellBack: false };
    },
  });
  assert.equal(result.reason, undefined);
  assert.equal(result.deferred, false);
});
