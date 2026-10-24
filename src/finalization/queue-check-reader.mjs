// Read-only exact-candidate observations. Transport and policy are composition
// ports; neither may infer requirements from the returned green subset.
import { createHash } from 'node:crypto';
import { resolveRequiredCheckContextsFromCfg } from '../ama/required-check-contexts.mjs';
import { checkItemState, classifyCheckRollup, latestCheckRollupItems } from '../checks-summary.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { readQueueEvidence } from './queue-read.mjs';

const text = x => typeof x === 'string' && x.trim().length > 0;
const same = (a, b) => text(a) && text(b) && a.toLowerCase() === b.toLowerCase();
const red = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE']);

export function resolveQueueRequiredSet({ cfg, rules }) {
  const configured = resolveRequiredCheckContextsFromCfg(cfg);
  // An unavailable protection/rules read is not evidence that no rules exist.
  if (rules?.complete !== true || !text(rules.sourceRef) || !text(rules.version)
    || !Array.isArray(rules.contexts) || rules.unresolved === true
    || [...configured, ...rules.contexts].some(x => !text(x))) throw new Error('required-set-unresolved');
  const contexts = [...new Set([...configured, ...rules.contexts].map(x => x.trim().toLowerCase()))].sort();
  const source = { configured: [...configured], rules: rules.sourceRef, rulesVersion: rules.version, contexts };
  return { contexts, source, version: 'sha256:' + createHash('sha256').update(JSON.stringify(source)).digest('hex') };
}

export function classifyQueueChecks(snapshot) {
  if (snapshot?.complete !== true || !snapshot.requiredSet?.version || !Array.isArray(snapshot.requiredSet.contexts)
    || !Array.isArray(snapshot.results) || snapshot.results.some(r => !same(r.head, snapshot.head))) {
    return { kind: 'wait', reason: 'checks-unreadable' };
  }
  const conclusion = classifyCheckRollup(snapshot.results, { requiredContexts: snapshot.requiredSet.contexts });
  if (red.has(conclusion)) return { kind: 'red', reason: 'checks-completed-red', conclusion };
  if (conclusion === 'SUCCESS') return { kind: 'green', reason: 'exact-candidate-checks-green', conclusion };
  if (!snapshot.results.length && !snapshot.requiredSet.contexts.length && snapshot.noCi?.ok === true
    && snapshot.noCi.configured === true && same(snapshot.noCi.head, snapshot.head) && text(snapshot.noCi.sourceRef)) {
    return { kind: 'green', reason: 'configured-no-ci-proof', conclusion: 'SUCCESS' };
  }
  const reported = new Set(snapshot.results.map(r => String(r.context ?? r.name ?? '').trim().toLowerCase()));
  const missing = snapshot.requiredSet.contexts.filter(name => !reported.has(name));
  return { kind: 'wait', reason: missing.length ? 'missing-required-check:' + missing.join(',')
    : conclusion === 'PENDING' ? 'checks-pending' : 'checks-inconclusive', conclusion };

}

/** request.read({path,timeoutMs,signal}) returns {body, nextPage, sourceRef}.
 * nextPage is the numeric next page or null, derived from the API Link header.
 * Explicit completeness, total count and duplicate detection reject truncated
 * pages, moving inventories and malformed results rather than certifying a prefix.
 */
export function createQueueCheckReader({ request, policyAdapter, cfg, noCiAdapter,
  now = () => new Date().toISOString(), load } = {}) {
  return { name: 'exact-candidate-check-reader-v1',
    async read({ entry, deadline = entry.patience.deadline, signal }) {
      const budget = () => queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: now(), load });
      const call = async (adapter, req) => {
        signal?.throwIfAborted();
        const timeoutMs = budget();
        if (!timeoutMs) throw new Error('checks-deadline-expired');
        return readQueueEvidence(adapter, req, timeoutMs);
      };
      const rules = await call(policyAdapter, { entry, deadline });
      const requiredSet = resolveQueueRequiredSet({ cfg, rules });
      const all = [], pages = [];
      for (const kind of ['check-runs', 'statuses']) {
        const seen = new Set();
        let page = 1, total = null, count = 0;
        while (page !== null) {
          const path = `/repos/${entry.lane.repository}/commits/${entry.candidate}/${kind}?per_page=100&page=${page}${kind === 'check-runs' ? '&filter=all' : ''}`;
          const response = await call(request, { path, deadline });
          if (!text(response?.sourceRef) || !(response.nextPage === null || response.nextPage === page + 1)) throw new Error('checks-partial-pages');
          const items = kind === 'check-runs' ? response.body?.check_runs : response.body;
          if (!Array.isArray(items) || items.length > 100 || (response.nextPage !== null && items.length !== 100)) throw new Error('checks-partial-pages');
          if (kind === 'check-runs') {
            const nextTotal = response.body.total_count;
            if (!Number.isSafeInteger(nextTotal) || nextTotal < 0 || (total !== null && total !== nextTotal)) throw new Error('checks-moving-pages');
            total = nextTotal;
          }
          for (const item of items) {
            if (!Number.isSafeInteger(item.id) || seen.has(item.id) || !text(item.name ?? item.context)
              || !Number.isFinite(Date.parse(item.created_at)) || !text(item.html_url ?? item.target_url ?? item.url)) throw new Error('checks-invalid-result');
            seen.add(item.id);
            // Legacy statuses are scoped to the immutable commit endpoint. A
            // check run additionally carries its own head_sha, which must match.
            if (kind === 'check-runs' && !same(item.head_sha, entry.candidate)) throw new Error('checks-stale-sha');
            all.push({ __typename: kind === 'check-runs' ? 'CheckRun' : 'StatusContext',
              id: item.id, name: item.name ?? null, context: item.context ?? null, head: entry.candidate,
              ...(kind === 'check-runs' && item.app ? { app: { id: item.app.id ?? null, slug: item.app.slug ?? null } } : {}),
              status: item.status ?? null, state: item.state ?? null, conclusion: item.conclusion ?? null,
              createdAt: item.created_at, startedAt: item.started_at ?? null, completedAt: item.completed_at ?? null,
              url: item.html_url ?? item.target_url ?? item.url, sourceRef: response.sourceRef });
          }
          count += items.length;
          pages.push(response.sourceRef);
          page = response.nextPage;
        }
        if (total !== null && count !== total) throw new Error('checks-partial-pages');
      }
      // Re-read policy after pagination: a moving required set is inconclusive.
      const after = resolveQueueRequiredSet({ cfg, rules: await call(policyAdapter, { entry, deadline }) });
      if (after.version !== requiredSet.version) throw new Error('required-set-changed');
      const results = latestCheckRollupItems(all).map(item => ({ ...item, result: checkItemState(item) }));
      let noCi = null;
      const noCiRepositories = cfg?.getMergeAuthorityConfig?.()?.noCiRepositories ?? cfg?.noCiRepositories ?? [];
      if (!results.length && !requiredSet.contexts.length && noCiAdapter
        && noCiRepositories.some(repository => same(repository, entry.lane.repository))) {
        noCi = await call(noCiAdapter, { entry, deadline }) ?? null;
      }
      return { head: entry.candidate, base: entry.exactBase, requiredSet, results, pages, noCi,
        complete: true, observedAt: now() };
    },
  };
}
