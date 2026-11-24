import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { deliverAlert } from '../alert-delivery.mjs';
import { resolveHqRoot } from '../hq-root.mjs';
import { isMergeDisabledForRepository } from '../merge-disabled-repositories.mjs';
import { createGithubAdapterMergeSurface, parseCodePrSubject } from './execution-surfaces.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { resolveCleanReviewStore } from './queue-clean-review.mjs';
import { createEntitledQueueCheckRequest } from './queue-check-transport.mjs';
import { createQueueCheckReader } from './queue-check-reader.mjs';
import { createQueueInfrastructurePageAdapter } from './queue-checks.mjs';
import { createQueueConsumer } from './queue-consumer.mjs';
import { createQueueClosureAuditDelivery, createQueueMergeActionDelivery } from './queue-delivery.mjs';
import { createQueueGitHub } from './queue-github.mjs';
import { resolveQueueGitAdapter, runQueueGit } from './queue-git.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';
import { createQueueLiveReads } from './queue-live.mjs';
import { observeQueueMergeOperation } from './queue-merge.mjs';
import { createQueueProductionEvidence, validateHammerQueueRequest } from './queue-production-admission.mjs';
import { resolveLaneRoute, resolveQueueRoutingStore } from './queue-routing.mjs';
import { routeFinalizationWriter } from './queue-routing-boundary.mjs';
import { openFinalizationQueueStore } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';

const unavailable = reason => ({ ok: false, taken: false, dispatched: false, skipMergeAgent: true, reason });
const latestAdmission = (store, lane, prNumber, head) => store.entries(lane)
  .filter(entry => entry.prNumber === prNumber && entry.head === head)
  .reduce((prior, entry) => !prior || entry.admissionGeneration > prior.admissionGeneration ? entry : prior, null);
const expiredAdmission = entry => entry?.phase === 'returned-to-closer' && entry.reason === 'admission-deadline-expired';

/** Normal service composition. Constructing it is inert. Only the configured
 * selector AND a durably transferred lane can run the admission or pump. */
export function createProductionQueue({ rootDir, env = process.env, hqRoot = resolveHqRoot(env),
  readConfig = loadEffectiveMergeAuthorityConfig, openStore = openFinalizationQueueStore,
  github = createQueueGitHub({ env }), live = createQueueLiveReads({ rootDir, github, env }),
  now = () => new Date().toISOString(), logger = console, alert = deliverAlert, stallWarningMs,
  observe = createQueueProductionEvidence({ rootDir, hqRoot, env, live, now }) } = {}) {
  const consumer = createQueueConsumer({ rootDir, readConfig, openStore, now, logger, stallWarningMs, compose({ cfg, store, ownerId }) {
    const liveAdapter = live.liveAdapter(cfg, resolveQueueAdmissionAdapters(store).receipt);
    const gitAdapter = resolveQueueGitAdapter({ rootDir, now, env,
      resolveRemote: repository => `https://github.com/${repository}.git`,
      async networkRunner(args, options) {
        const start = performance.now();
        let token, remaining;
        try {
          ({ token } = await github.credential(options.repository, options.timeoutMs));
          remaining = Math.floor(options.timeoutMs - (performance.now() - start));
          if (remaining <= 0) throw new Error('queue-git-credential-deadline');
        } catch { throw Object.assign(new Error('queue-git-credential-unavailable'), { publicationNotStarted: true }); }
        return runQueueGit(args, { ...options, timeoutMs: remaining,
          env: github.childEnv(token), githubToken: token });
      },
    });
    const request = { async read({ path, deadline, timeoutMs, signal }) {
      const repo = /^\/repos\/([\w.-]+\/[\w.-]+)\//.exec(path)?.[1];
      if (!repo) throw new Error('invalid-queue-check-subject');
      const { token, expiresAtMs } = await github.credential(repo, timeoutMs, signal);
      const credentialEnv = { ...github.childEnv(token), MERGE_AGENT_GH_TOKEN: token,
        MERGE_AGENT_GH_TOKEN_EXPIRES_AT: new Date(expiresAtMs).toISOString() };
      return createEntitledQueueCheckRequest({ credentialEnv, now }).read({ path, deadline, timeoutMs, signal });
    } };
    const checkReader = createQueueCheckReader({ request, policyAdapter: live.policyAdapter, cfg, now });
    const identitySurface = { async check({ subjectKey, timeoutMs, signal }) {
      const target = parseCodePrSubject(subjectKey.subjectExternalId);
      if (!target) return { ok: false };
      return await github.identity(target.repo, { timeoutMs, signal }) ?? { ok: false };
    } };
    const mergeSurface = { name: 'entitled-github-adapter', async merge({ subjectExternalId, timeoutMs, ...intent }) {
      const target = parseCodePrSubject(subjectExternalId);
      if (!target) return { ok: false, reason: 'unsupported-subject' };
      const start = performance.now();
      const budget = () => Math.floor(timeoutMs - (performance.now() - start));
      const cfg = readConfig({ rootDir });
      if (cfg.enabled !== true || isMergeDisabledForRepository(cfg, target.repo)) return { ok: false, reason: 'adapter-unavailable' };
      let token;
      try { ({ token } = await github.credential(target.repo, budget())); }
      catch { return { ok: false, reason: 'adapter-unavailable' }; }
      const current = readConfig({ rootDir });
      if (current.enabled !== true || current.autonomousMergeExecutionEnabled === false
        || isMergeDisabledForRepository(current, target.repo)) return { ok: false, reason: 'adapter-unavailable' };
      if (budget() <= 0) return { ok: false, reason: 'adapter-unavailable' };
      return createGithubAdapterMergeSurface({ rootDir, recordReceipt: false, disabledRepositories: cfg.disabledRepositories,
        env: { ...env, ...github.childEnv(token), GH_TOKEN: token }, envTokenSelector: github.role, deleteBranch: false,
      }).merge({ subjectExternalId, ...intent, timeoutMs: budget() });
    } };
    const recoveryAdapter = { stopDrainAndReconcile: args => reconcileProductionOperations({
      ...args, store, live, liveAdapter, ownerId,
    }) };
    return { liveAdapter, gitAdapter, checkReader, identitySurface, mergeSurface, recoveryAdapter,
      pageAdapter: createQueueInfrastructurePageAdapter({ deliverAlert: alert, env }),
      deliveryAdapters: { 'merge-action-receipt': createQueueMergeActionDelivery({ hqRoot }),
        'closure-audit': createQueueClosureAuditDelivery({ hqRoot }) },
      returnSubject: entry => returnMovedSubject({ rootDir, store, live, entry, now }),
    };
  } });

  function checkAdmission(store, route) {
    const cfg = readConfig({ rootDir });
    const fresh = resolveLaneRoute(cfg, route.lane);
    const { route: durable, legacyWriters } = resolveQueueRoutingStore(store).read(route.lane);
    if (cfg.enabled !== true || fresh.executor !== 'queue-v2' || !fresh.autonomousExecutionEnabled || isMergeDisabledForRepository(cfg, route.lane.repository)
      || store.executionHold()) throw new Error('queue-admission-paused');
    if (durable?.executor !== 'queue-v2' || durable.transition || durable.route_generation !== route.routeGeneration
      || legacyWriters.length || store.operations(route.lane).length) throw new Error('queue-admission-fence-unavailable');
    return cfg;
  }

  return { tick: consumer.tick,
    // The legacy clean-merge call already holds the existing routing boundary.
    async admitClean({ route, prNumber, head }) {
      const store = openStore({ rootDir });
      try {
        const cfg = checkAdmission(store, route);
        const receipts = resolveCleanReviewStore(store);
        const latest = latestAdmission(store, route.lane, prNumber, head);
        const prior = latest && receipts.read(latest.entryId);
        let admissionGeneration = 1;
        if (prior) {
          if (prior.entry.phase !== 'returned-to-closer') return prior.entry;
          if (!expiredAdmission(latest)) return unavailable('queue-admission-returned');
          admissionGeneration = prior.entry.admissionGeneration + 1;
        } else if (latest) {
          if (!expiredAdmission(latest)) {
            return unavailable('queue-admission-conflict-or-returned');
          }
          admissionGeneration = latest.admissionGeneration + 1;
        }
        const deadline = new Date(Date.parse(now()) + queueWaitMs(15_000, { ceilingMs: 60_000 })).toISOString();
        const proof = await observe({ lane: route.lane, prNumber, head, cfg, deadline, admissionGeneration });
        return store.tx(() => {
          checkAdmission(store, route);
          const at = now();
          if (Date.parse(at) >= Date.parse(deadline)) throw new Error('queue-admission-deadline-expired');
          return receipts.commit(proof.input, proof.evidence, { at });
        });
      } finally { store.close(); }
    },
    async admitHammer(input) {
      const request = validateHammerQueueRequest(input);
      const { lane, prNumber, head, deadline, routeGeneration } = request;
      if (!queueWaitMs(15_000, { ceilingMs: 60_000, deadline, now: now() })) return unavailable('queue-handoff-deadline-expired');
      const cfg = readConfig({ rootDir });
      if (resolveLaneRoute(cfg, lane).executor !== 'queue-v2') return unavailable('queue-route-not-owned');
      return routeFinalizationWriter({ rootDir, cfg, lane, kind: 'closer', subject: { prNumber, head },
        legacy: () => unavailable('queue-route-not-owned'), now, async queue(route) {
          if (route.routeGeneration !== routeGeneration) return unavailable('route-generation-mismatch');
          const store = openStore({ rootDir });
          try {
            checkAdmission(store, route);
            const receipts = resolveQueueHandoffStore(store);
            const latest = latestAdmission(store, lane, prNumber, head);
            const existing = latest && receipts.read({ ...request, admissionGeneration: latest.admissionGeneration });
            let generation = request.admissionGeneration;
            if (existing) {
              const sameLaunch = existing.handoff.closer.launchRequestId === request.closer.launchRequestId;
              const same = sameLaunch && existing.handoff.closer.workerId === request.closer.workerId
                && existing.handoff.closer.workerClass === request.closer.workerClass
                && existing.handoff.reviewProof?.digest === request.reviewProof.digest;
              if (same && latest.phase !== 'returned-to-closer') return existing.ack;
              if (sameLaunch || !expiredAdmission(latest)) return unavailable('queue-handoff-conflict-or-returned');
            }
            if (latest && !expiredAdmission(latest)) return unavailable('queue-handoff-conflict-or-returned');
            if (latest) generation = latest.admissionGeneration + 1;
            const proof = await observe({ lane, prNumber, head, request, cfg, deadline });
            const input = generation === request.admissionGeneration ? proof.input : {
              ...proof.input, admissionGeneration: generation,
              handoffId: `${request.handoffId}-${generation}`,
            };
            return store.tx(() => {
              checkAdmission(store, route);
              return receipts.commit(input, proof.evidence, { deadline, now });
            });
          } finally { store.close(); }
        } });
    },
  };
}

export async function reconcileProductionOperations({ prior, operations, timeoutMs, lane, store, live, liveAdapter, ownerId }) {
  const results = Object.create(null);
  const stopAt = performance.now() + timeoutMs;
  for (const operation of operations) {
    const { intent } = operation;
    const entry = store.readEntry(intent.entryId);
    if (!entry || !isDeepStrictEqual(entry.lane, lane) || entry.candidate !== intent.candidate) return null;
    // Only this running watcher can confirm that its own issuance callback
    // settled. Even then, absence of a visible change cannot settle a lost
    // remote response: accept positive publication or terminal PR evidence.
    if (prior.owner_id === ownerId && intent.fence?.ownerId === ownerId) {
      for (let attempt = 0; attempt < 3 && performance.now() < stopAt; attempt++) {
        if (attempt) await delay(Math.min(250 * 2 ** (attempt - 1), Math.max(0, stopAt - performance.now())));
        const remaining = Math.floor(stopAt - performance.now());
        if (remaining <= 0) break;
        const budget = Math.min(10_000, remaining);
        try {
          if (intent.kind === 'merge') {
            const result = await observeQueueMergeOperation({ store, liveAdapter, operation, timeoutMs: budget, drained: false });
            if (result?.outcome === 'succeeded' || result?.disposition?.phase === 'closed-observed') {
              results[operation.operation_id] = result;
            }
          } else if (intent.kind === 'push') {
            const { subject } = await live.snapshot(lane, entry.prNumber, { timeoutMs: budget, signal: AbortSignal.timeout(budget) });
            if (subject.sourceRef && isDeepStrictEqual(subject.lane, lane) && subject.prNumber === entry.prNumber
              && subject.head === intent.candidate && subject.headRepository === entry.rebase?.headRepository
              && subject.headRef === entry.rebase?.headRef) {
              results[operation.operation_id] = { outcome: 'succeeded', sourceRef: subject.sourceRef, observation: { subject } };
            }
          }
        } catch { /* A failed read is inconclusive within the bounded retry window. */ }
        if (results[operation.operation_id]) break;
      }
    }
    if (!results[operation.operation_id]) {
      const reason = 'prior-operation-quiescence-unproven';
      const causeKey = handoffDigest([operation.operation_id, reason]);
      const payload = { causeKey, dependency: intent.kind, reason, repo: lane.repository,
        pr: entry.prNumber, head: intent.candidate, deadline: intent.deadline };
      store.tx(() => store.db.prepare('INSERT INTO finalization_queue_check_page VALUES (?,?,?,NULL) ON CONFLICT DO NOTHING')
        .run(causeKey, entry.entryId, JSON.stringify(payload)));
      return null;
    }
  }
  return { quiescent: true, sourceRef: 'queue:watcher-issuance-callback-drained', results };
}

async function returnMovedSubject({ rootDir, store, live, entry, now }) {
  if (entry.reason !== 'external-head-change' || store.executionHold()) return;
  const timeoutMs = queueWaitMs(5_000, { ceilingMs: 30_000 });
  const { subject } = await live.snapshot(entry.lane, entry.prNumber, { timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  if (subject.state !== 'open' || [entry.head, entry.candidate, entry.expectedOldHead].includes(subject.head)) return;
  const state = await import('../review-state.mjs');
  store.tx(() => {
    const review = state.getReviewRow(store.db, { repo: entry.lane.repository, prNumber: entry.prNumber });
    if (!review || ['merged', 'closed'].includes(review.pr_state) || review.reviewer_head_sha === subject.head) return;
    state.requestReviewRereview({ db: store.db, rootDir, repo: entry.lane.repository, prNumber: entry.prNumber,
      inTransaction: true, preserveBudgets: true, requestedAt: now(), targetRevisionRef: subject.head,
      reason: 'retrigger-review: queue handoff head moved',
      explicitReviewRequest: { requestId: `queue-head-moved:${subject.head}`, actor: 'finalization-v2' } });
  });
}
