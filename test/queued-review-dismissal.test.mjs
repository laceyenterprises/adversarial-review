import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { recordExplicitReviewIntent, consumeExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { dismissSupersededReviewsForQueuedRereview } from '../src/queued-review-dismissal.mjs';
import { dismissStandingChangesRequestedReviewsForHead } from '../src/github-api.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';

const repo = 'example/review-fixture', prNumber = 71;
const headSha = 'b'.repeat(40), oldHead = 'a'.repeat(40);
const requestedAt = '2026-01-01T00:00:00Z';

for (const running of [false, true]) test(`REREVIEWDEFER-01: queued/running (${running}) clears only superseded bot reviews, once`, async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,
    reviewer_head_sha,reviewer_session_uuid) VALUES (?, ?, ?, 'fixture', 'reviewing', ?, 'session')`)
    .run(repo, prNumber, requestedAt, headSha);
  const intent = recordExplicitReviewIntent(db, { repo, prNumber, headSha, requestId: 'synthetic', actor: 'fixture', requestedAt });
  if (running) assert.equal(consumeExplicitReviewIntent(db, intent, { headSha, sessionUuid: 'session' }), true);
  const bots = amaAllAuthoritativeReviewerLogins();
  const review = (id, login, commit_id) => ({ id, user: { login }, commit_id,
    submitted_at: requestedAt, state: 'CHANGES_REQUESTED', body: 'Synthetic finding.' });
  const reviews = [review(1, bots[0], oldHead), review(2, bots[1], headSha),
    review(3, 'fixture-human', oldHead), review(4, bots[2], null)];
  const puts = [];
  const execFileImpl = async (_cmd, args) => {
    if (args.includes('PUT')) {
      const endpoint = args.find(arg => arg.includes('/dismissals'));
      puts.push(args);
      reviews.find(row => endpoint.endsWith(`/${row.id}/dismissals`)).state = 'DISMISSED';
      return { stdout: '{}' };
    }
    return { stdout: JSON.stringify(reviews) };
  };
  const run = overrides => dismissSupersededReviewsForQueuedRereview(db, { repo, prNumber, headSha,
    fetchHeadImpl: async () => ({ state: 'open', headRefOid: headSha }),
    execFileImpl, dismissImpl: (...args) => dismissStandingChangesRequestedReviewsForHead(
      ...args.slice(0, 4), { ...args[4], recordApiCallImpl() {} }), ...overrides });
  assert.equal((await run({ terminal: true })).skipped, 'no-open-head');
  assert.equal((await run({ fetchHeadImpl: async () => ({
    state: 'open', headRefOid: 'c'.repeat(40),
  }) })).skipped, 'no-queued-rereview');
  assert.equal((await run({ fetchHeadImpl: async () => ({
    state: 'closed', headRefOid: headSha,
  }) })).skipped, 'pr-terminal');
  assert.equal((await run({ fetchHeadImpl: async () => {
    throw new Error('synthetic read outage');
  }, logger: { warn() {} } })).deferred, true);
  assert.equal(puts.length, 0, 'moved/closed/unreadable live heads cannot dismiss a review');
  assert.equal((await run({ logger: { warn() {} },
    dismissImpl: async () => { throw new Error('synthetic API outage'); },
  })).deferred, true);
  await run({ headSha: oldHead });
  await run();
  assert.equal(puts.length, 1);
  assert.match(puts[0].find(arg => arg.startsWith('message=')), new RegExp(`${oldHead}.*${headSha}.*queued or running`));
  assert.deepEqual(reviews.map(row => row.state), ['DISMISSED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED']);
  assert.equal(db.prepare('SELECT state FROM explicit_review_intents').get().state, running ? 'consumed' : 'pending');
});
