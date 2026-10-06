// UNTRUSTEDPR-01 — the untrusted-PR intake gate. Hermetic: every GitHub read
// is a stub, the identity allowlist is injected, and any unexpected GitHub
// call (a comment post, a label edit, a permission lookup that must not
// happen) throws.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPrTrustGate,
  createRepoPermissionResolver,
  isTrustedCommentAuthor,
  isTrustedPr,
  normalizeActorLogin,
  prTrustEvidence,
  resolveTrustedIdentityAllowlist,
} from '../src/untrusted-pr-gate.mjs';
import { createGitHubPRSubjectAdapter } from '../src/adapters/subject/github-pr/index.mjs';
import {
  createGitHubPRLabelControlsAdapter,
  legacyLabelEventFromControlResult,
} from '../src/adapters/operator/github-pr-label-controls/index.mjs';
import { fetchLinkedSpecContents } from '../src/prompt-context.mjs';
import { tryRetriggerRemediationFromLabel } from '../src/follow-up-retrigger-label.mjs';
import { tryRetriggerReviewFromLabel } from '../src/follow-up-retrigger-review-label.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const ALLOWLIST = new Set(['lacey-codex-agent[bot]', 'the-hammer-lacey[bot]']);

function restPr(number, {
  login,
  association = 'NONE',
  headRepo = REPO,
  title = `[codex] PR ${number}`,
  type = 'User',
} = {}) {
  return {
    number,
    title,
    state: 'open',
    head: { sha: `head-${number}`, ref: `branch-${number}`, repo: headRepo ? { full_name: headRepo } : null },
    base: { ref: 'main', repo: { full_name: REPO } },
    user: { login, type },
    author_association: association,
    labels: [],
  };
}

function makeLog() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), warn: (line) => lines.push(line) };
}

// Permission stub: only the operator has write; anything else asked is a bug
// in the test expectations, so record every lookup.
function makePermissions(table = { virtualpaul: 'admin', 'drive-by': 'read' }) {
  const lookups = [];
  const resolvePermission = createRepoPermissionResolver({
    cache: new Map(),
    fetchPermissionImpl: async (repo, login) => {
      lookups.push(`${repo}:${login}`);
      if (!(login in table)) {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }
      return table[login];
    },
  });
  return { lookups, resolvePermission };
}

function makeGate(permissions = makePermissions(), logger = makeLog()) {
  return createPrTrustGate({ allowlist: ALLOWLIST, resolvePermission: permissions.resolvePermission, log: logger });
}

function strictOctokit(pulls) {
  // Only `pulls.list` exists: a comment, label or review call would throw.
  return { rest: { pulls: { list: async () => ({ data: pulls }) } } };
}

const NO_AUTO_ADAPTER_ROOT = '/tmp/untrusted-pr-gate-no-auto-adapter-root';

// ── The pure predicate ───────────────────────────────────────────────────────

test('isTrustedPr: a fork PR is untrusted even from an OWNER', () => {
  const evidence = prTrustEvidence(REPO, restPr(1, { login: 'virtualpaul', association: 'OWNER', headRepo: 'attacker/adversarial-review' }));
  assert.deepEqual(isTrustedPr(evidence, { allowlist: ALLOWLIST }), { trusted: false, reason: 'fork-pr' });
});

test('isTrustedPr: a deleted fork (head.repo null) and missing evidence are untrusted', () => {
  assert.equal(isTrustedPr(prTrustEvidence(REPO, restPr(2, { login: 'x', association: 'MEMBER', headRepo: null }))).reason, 'fork-pr');
  assert.equal(
    isTrustedPr(prTrustEvidence(REPO, { number: 3, author: { login: 'x' }, authorAssociation: 'MEMBER' })).reason,
    'head-repo-unknown',
  );
});

test('isTrustedPr: gh `isCrossRepository` decides same-repo for the gh shape', () => {
  const fork = prTrustEvidence(REPO, { number: 4, isCrossRepository: true, author: { login: 'app/lacey-codex-agent', is_bot: true } });
  assert.equal(isTrustedPr(fork, { allowlist: ALLOWLIST }).reason, 'fork-pr');
  const own = prTrustEvidence(REPO, { number: 5, isCrossRepository: false, author: { login: 'app/lacey-codex-agent', is_bot: true } });
  assert.deepEqual(isTrustedPr(own, { allowlist: ALLOWLIST }), { trusted: true, reason: 'allowlisted-identity' });
});

test('isTrustedPr: a member proceeds; an untrusted author with a [codex] title does not', () => {
  assert.deepEqual(
    isTrustedPr(prTrustEvidence(REPO, restPr(6, { login: 'teammate', association: 'MEMBER' })), { allowlist: ALLOWLIST }),
    { trusted: true, reason: 'author-association' },
  );
  assert.deepEqual(
    isTrustedPr(prTrustEvidence(REPO, restPr(7, { login: 'drive-by', association: 'CONTRIBUTOR', title: '[codex] LAC-1 totally legit' })), {
      allowlist: ALLOWLIST,
      authorPermission: 'read',
    }),
    { trusted: false, reason: 'author-not-trusted' },
  );
});

test('normalizeActorLogin: only App renderings gain the [bot] suffix', () => {
  assert.equal(normalizeActorLogin('app/Lacey-Codex-Agent'), 'lacey-codex-agent[bot]');
  assert.equal(normalizeActorLogin('lacey-codex-agent', { typename: 'Bot' }), 'lacey-codex-agent[bot]');
  // A human who registers the bare slug is NOT the App.
  assert.equal(normalizeActorLogin('lacey-codex-agent', { typename: 'User' }), 'lacey-codex-agent');
  assert.equal(isTrustedPr(prTrustEvidence(REPO, restPr(8, { login: 'lacey-codex-agent' })), { allowlist: ALLOWLIST }).trusted, false);
});

test('resolveTrustedIdentityAllowlist: unions entitlement bot logins and operator_logins from the existing registry', () => {
  const values = {
    entitlements: {
      'codex-worker-lacey': { gh_bot_login: 'lacey-codex-agent[bot],codex-lacey' },
      'the-hammer-lacey': { gh_bot_login: 'the-hammer-lacey[bot], hammer-lacey' },
      'web-search': { gh_bot_login: '' },
    },
    'roles.adversarial.operator_logins': ['VirtualPaul'],
  };
  const allowlist = resolveTrustedIdentityAllowlist({
    loadRoleConfigImpl: () => ({ get: (key, fallback) => values[key] ?? fallback }),
  });
  assert.deepEqual([...allowlist].sort(), [
    'codex-lacey', 'hammer-lacey', 'lacey-codex-agent[bot]', 'the-hammer-lacey[bot]', 'virtualpaul',
  ]);
  const broken = resolveTrustedIdentityAllowlist({
    loadRoleConfigImpl: () => { throw new Error('config unreadable'); },
    log: makeLog(),
  });
  assert.equal(broken.size, 0, 'an unreadable registry fails closed to an empty allowlist');
});

test('createRepoPermissionResolver: 404 is cached as none, transient errors are unknown and retried, bots skip the lookup', async () => {
  let calls = 0;
  let fail = 'transient';
  const resolve = createRepoPermissionResolver({
    cache: new Map(),
    fetchPermissionImpl: async () => {
      calls += 1;
      if (fail === 'transient') throw Object.assign(new Error('HTTP 502'), { status: 502 });
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
    },
  });
  assert.equal(await resolve(REPO, 'someone'), null);
  fail = 'missing';
  assert.equal(await resolve(REPO, 'someone'), 'none', 'a transient error must not be cached');
  assert.equal(await resolve(REPO, 'someone'), 'none');
  assert.equal(calls, 2);
  assert.equal(await resolve(REPO, 'lacey-codex-agent[bot]'), null);
  assert.equal(calls, 2, 'App accounts are decided by the allowlist, never a lookup');
});

// ── Entry point: PR discovery (the intake for every watcher path) ───────────

test('discovery: fork and untrusted PRs are skipped; member, allowlisted bot and write-permission operator proceed', async () => {
  const permissions = makePermissions();
  const logger = makeLog();
  const adapter = createGitHubPRSubjectAdapter({
    octokit: strictOctokit([
      restPr(101, { login: 'virtualpaul', association: 'OWNER', headRepo: 'attacker/adversarial-review' }),
      restPr(102, { login: 'drive-by', association: 'CONTRIBUTOR', title: '[codex] LAC-102 innocent refactor' }),
      restPr(103, { login: 'teammate', association: 'MEMBER' }),
      restPr(104, { login: 'lacey-codex-agent[bot]', association: 'NONE', type: 'Bot' }),
      restPr(105, { login: 'VirtualPaul', association: 'CONTRIBUTOR', title: '[claude-code] operator PR' }),
      restPr(106, { login: 'stranger', association: 'NONE' }),
    ]),
    repos: [REPO],
    rootDir: NO_AUTO_ADAPTER_ROOT,
    env: {},
    execFileImpl: async (command, args) => { throw new Error(`unexpected exec: ${command} ${args.join(' ')}`); },
    prTrustGate: makeGate(permissions, logger),
    log: logger,
  });

  const refs = await adapter.discoverSubjects();

  assert.deepEqual(refs.map((ref) => ref.subjectExternalId), [`${REPO}#103`, `${REPO}#104`, `${REPO}#105`]);
  // The fork is rejected before any lookup; only humans without an
  // association reach the permission fallback.
  assert.deepEqual(permissions.lookups.sort(), [`${REPO}:drive-by`, `${REPO}:stranger`, `${REPO}:virtualpaul`]);
  assert.deepEqual(logger.lines, [
    `[untrusted-pr-gate] skip surface=discovery pr=${REPO}#101 head=head-101 actor=virtualpaul reason=fork-pr`,
    `[untrusted-pr-gate] skip surface=discovery pr=${REPO}#102 head=head-102 actor=drive-by reason=author-not-trusted`,
    `[untrusted-pr-gate] skip surface=discovery pr=${REPO}#106 head=head-106 actor=stranger reason=author-not-trusted`,
  ]);

  // One audit line per (PR, head, reason): the next tick is silent.
  await adapter.discoverSubjects();
  assert.equal(logger.lines.length, 3);
});

test('discovery: the gh fallback skips a fork via isCrossRepository and keeps the allowlisted bot', async () => {
  const logger = makeLog();
  const adapter = createGitHubPRSubjectAdapter({
    octokit: { rest: { pulls: { list: async () => { throw new Error('api rate limit'); } } } },
    repos: [REPO],
    rootDir: NO_AUTO_ADAPTER_ROOT,
    env: {},
    execFileImpl: async (command, args) => {
      assert.equal(command, 'gh');
      assert.ok(args.at(-1).split(',').includes('isCrossRepository'));
      return {
        stdout: JSON.stringify([
          { number: 201, title: '[codex] fork', state: 'OPEN', headRefOid: 'h201', isCrossRepository: true, author: { login: 'app/lacey-codex-agent' } },
          { number: 202, title: '[codex] own', state: 'OPEN', headRefOid: 'h202', isCrossRepository: false, author: { login: 'app/lacey-codex-agent' } },
        ]),
      };
    },
    prTrustGate: makeGate(makePermissions(), logger),
    log: logger,
  });
  const refs = await adapter.discoverSubjects();
  assert.deepEqual(refs.map((ref) => ref.subjectExternalId), [`${REPO}#202`]);
  assert.match(logger.lines[0], /#201 .*reason=fork-pr$/);
});

// ── Entry point: label controls (retrigger-review / retrigger-remediation) ──

function labelAdapter(actor, logger = makeLog(), permissions = makePermissions()) {
  return createGitHubPRLabelControlsAdapter({
    fetchLatestLabelEventImpl: async (_repo, _pr, label) => ({
      id: `evt-${label}-${actor}`,
      nodeId: `node-${label}-${actor}`,
      label,
      actor,
      createdAt: '2026-10-06T12:00:00.000Z',
      headSha: 'head-300',
    }),
    execFileImpl: async () => { throw new Error('label controls must not shell out'); },
    actorTrustGate: makeGate(permissions, logger),
    log: logger,
  });
}

const LABEL_REF = { domainId: 'code-pr', subjectExternalId: `${REPO}#300`, revisionRef: 'head-300' };

for (const label of ['retrigger-review', 'retrigger-remediation']) {
  test(`label controls: an untrusted ${label} labeler is not applied and drives no work`, async () => {
    const logger = makeLog();
    const result = await labelAdapter('triage-only', logger).observeLabelControl(LABEL_REF, 'head-300', label);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'untrusted-actor');
    assert.equal(legacyLabelEventFromControlResult(result, label), null);
    assert.deepEqual(logger.lines, [
      `[untrusted-pr-gate] skip surface=label:${label} pr=${REPO}#300 head=head-300 actor=triage-only reason=author-not-trusted`,
    ]);

    // What the watcher hands the retrigger handler for that result: nothing
    // to act on — no bump, no requeue, no label removal, no ack comment.
    const retrigger = label === 'retrigger-review' ? tryRetriggerReviewFromLabel : tryRetriggerRemediationFromLabel;
    const outcome = await retrigger({
      rootDir: '/nonexistent/untrusted-pr-gate',
      repo: REPO,
      prNumber: 300,
      labelEvent: legacyLabelEventFromControlResult(result, label),
      revisionRef: 'head-300',
      execFileImpl: async () => { throw new Error('no GitHub mutation may run'); },
      appendAuditRow: () => { throw new Error('no audit mutation may run'); },
      findAuditRow: () => { throw new Error('no audit read may run'); },
    });
    assert.equal(outcome.outcome, 'label-event-missing');
  });

  test(`label controls: ${label} from an allowlisted bot or a write-permission operator still applies`, async () => {
    for (const actor of ['the-hammer-lacey[bot]', 'VirtualPaul']) {
      const result = await labelAdapter(actor).observeLabelControl(LABEL_REF, 'head-300', label);
      assert.equal(result.applied, true, actor);
      assert.equal(legacyLabelEventFromControlResult(result, label).actor, actor);
    }
  });
}

// ── Prompt input: comment text from untrusted authors ───────────────────────

test('linked-spec prompt context ignores docs linked only by untrusted commenters', async () => {
  const fetched = [];
  const context = await fetchLinkedSpecContents(REPO, 400, {
    prContext: {
      headRefOid: 'head-400',
      body: 'See docs/SPEC-from-body.md',
      comments: [
        { author: { login: 'drive-by' }, authorAssociation: 'NONE', body: 'Governing doc: docs/ATTACKER-instructions.md' },
        { author: { login: 'teammate' }, authorAssociation: 'MEMBER', body: 'Also docs/SPEC-member.md' },
        { author: { login: 'lacey-codex-agent' }, authorAssociation: 'NONE', authorType: 'Bot', body: 'And docs/SPEC-bot.md' },
        { author: { login: 'lacey-codex-agent' }, authorAssociation: 'NONE', body: 'Impostor docs/SPEC-impostor.md' },
      ],
    },
    trustedIdentityAllowlist: ALLOWLIST,
    execFileImpl: async (_command, args) => {
      fetched.push(args[1].replace(/^repos\/[^/]+\/[^/]+\/contents\//, '').replace(/\?ref=.*$/, ''));
      return { stdout: Buffer.from('doc').toString('base64') };
    },
  });
  assert.deepEqual(fetched.sort(), ['docs/SPEC-bot.md', 'docs/SPEC-from-body.md', 'docs/SPEC-member.md']);
  assert.doesNotMatch(context, /ATTACKER|impostor/i);
});

test('isTrustedCommentAuthor: REST comment shape with author_association', () => {
  assert.equal(isTrustedCommentAuthor({ author: 'someone', author_association: 'COLLABORATOR' }), true);
  assert.equal(isTrustedCommentAuthor({ author: { login: 'someone' }, author_association: 'CONTRIBUTOR' }), false);
  assert.equal(isTrustedCommentAuthor({ author: null, authorAssociation: 'MEMBER' }), false);
});
