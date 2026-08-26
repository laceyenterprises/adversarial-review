/** ASR-04 — where the Argus route sits inside the per-PR phase.
 *
 * The disposition itself is unit-tested (bot-pr-not-malformed, argus-security-
 * route). What those cannot see is ORDER, and order is where this fix is easiest
 * to silently undo: an enqueue placed after an early return is an enqueue that
 * never runs for the PRs that take it, and the failure is invisible -- the code
 * reads correct, the tests pass, and the PR is dropped exactly as before.
 *
 * `processReviewSubject` needs the whole watcher ctx (octokit, operator surface,
 * a live reviews.db handle) to drive end to end, so these read the phase source
 * directly. That is the established idiom in this repo for the same reason --
 * see watcher-pending-draft-reconciliation.test.mjs and the ARC-18 gates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PHASES_SOURCE = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');

function indexOfOrFail(needle, from = 0) {
  const index = PHASES_SOURCE.indexOf(needle, from);
  assert.ok(index > 0, `expected to find ${JSON.stringify(needle)} in pollonce-phases.mjs`);
  return index;
}

test('the Argus branch is reached BEFORE the terminal early-return', () => {
  // A legacy `unroutable-bot-author` row is listed in the terminal skip below.
  // If that check ran first, #909 and #910 would keep returning early forever and
  // the recovery would never fire -- the backfill would be the only path, and a
  // reopened PR could re-strand with nothing left to catch it.
  const argusBranch = indexOfOrFail('existing?.review_status === ARGUS_SECURITY_QUEUED_STATUS');
  const legacyRecovery = indexOfOrFail(
    'argusRouteEnabled && existing?.review_status === LEGACY_UNROUTABLE_BOT_STATUS',
    argusBranch,
  );
  const terminalSkip = indexOfOrFail("existing?.review_status === 'malformed' ||", argusBranch);

  assert.ok(legacyRecovery < terminalSkip, 'legacy recovery must precede the terminal skip');
});

test('the merged guard is reached before the Argus branch', () => {
  // Acting on an already-terminal PR is a failure mode this pipeline has been
  // burned by more than once; a merged PR must never be enqueued for review.
  const mergedGuard = indexOfOrFail("if (existing?.pr_state === 'merged') {");
  const argusBranch = indexOfOrFail('existing?.review_status === ARGUS_SECURITY_QUEUED_STATUS');

  assert.ok(mergedGuard < argusBranch);
});

test('the additive enqueue precedes routeSubject and every hop that can return early', () => {
  // The ADDITIVE half: a routable human PR that bumps a dependency must still get
  // its Argus job. Placed after the terminal guards and before the label-control,
  // posted-review, fast-merge and routing hops -- each of which returns early for
  // reasons that have nothing to do with the PR's security surface.
  const additiveCall = indexOfOrFail('const argusOutcome = await routeSecuritySurfaceSafe(existing);');
  const retriggerLabel = indexOfOrFail('prLabelNames.includes(RETRIGGER_REMEDIATION_LABEL)');
  const postedRow = indexOfOrFail("existing?.review_status === 'posted'");
  const routeSubjectCall = indexOfOrFail('const baseRoute = routeSubject(subject, {');

  assert.ok(additiveCall < retriggerLabel, 'must run before the retrigger-label hop');
  assert.ok(additiveCall < postedRow, 'must run before the posted-review hop');
  assert.ok(additiveCall < routeSubjectCall, 'must run before routing decides anything');
});

test('the terminal bot write survives only inside the kill switch', () => {
  // `stmtMarkUnroutableBot` is the write this ticket retires. Exactly two
  // mentions may remain in this module: the import, and the single guarded call
  // inside `markUnroutableTitleDisposition`'s `!argusRouteEnabled` branch. A
  // third would mean some path still terminates a bot PR while the route is on.
  const mentions = PHASES_SOURCE.split('stmtMarkUnroutableBot').length - 1;
  assert.equal(mentions, 2, 'stmtMarkUnroutableBot must appear only as an import and a default arg');

  const killSwitch = indexOfOrFail('if (!argusRouteEnabled) {');
  const terminalWrite = indexOfOrFail('markUnroutableBotStatement.run(', killSwitch);
  const branchEnd = indexOfOrFail('return LEGACY_UNROUTABLE_BOT_STATUS;', killSwitch);

  assert.ok(terminalWrite < branchEnd, 'the only terminal bot write lives in the kill-switch branch');
});

test('the malformed-title notice is suppressed for a routed bot PR', () => {
  // Telling Dependabot to fix a title it owns is the category error MAL-01 named,
  // and the MALFORMED_PR_TITLE signal behind the notice pages on a defect that
  // does not exist. With the route off it must still fire -- a rollback lever
  // whose stuck PRs are silent is not a lever.
  const guard = indexOfOrFail('if (!unroutableBot || !argusRouteEnabled) {');
  const notice = indexOfOrFail('await signalMalformedTitleFailure(octokit, {', guard);
  const disposition = indexOfOrFail('const disposition = markUnroutableTitleDisposition({', guard);

  assert.ok(notice > guard, 'the notice must sit inside the guard');
  assert.ok(notice < disposition);
  assert.equal(
    PHASES_SOURCE.split('await signalMalformedTitleFailure(').length - 1,
    1,
    'only one caller, so the guard cannot be bypassed by a second copy',
  );
});

test('the enqueue is gated on drain and on non-terminal subjects', () => {
  const helper = indexOfOrFail('async function routeSecuritySurfaceSafe(reviewRow) {');
  const body = PHASES_SOURCE.slice(helper, helper + 1200);

  assert.match(body, /if \(!argusRouteEnabled\) return null;/);
  assert.match(body, /subject\.terminal \|\| watcherDrain\.active/);
  assert.match(body, /pr_state === 'merged' \|\| reviewRow\?\.pr_state === 'closed'/);
});
