import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultBuilderClassFamily,
  roleReviewerClass,
  roleMayReviewSubject,
  selectEligibleReviewerRoles,
} from '../src/kernel/role-routing.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function role(id, { workerClass, persona, taskKind = 'review', priority } = {}) {
  return {
    id,
    promptSet: 'code-pr',
    ...(workerClass ? { workerClass } : {}),
    ...(persona ? { persona } : {}),
    taskKind,
    completionShape: taskKind === 'review' ? 'decision-only' : 'branch-push',
    ...(priority !== undefined ? { priority } : {}),
  };
}

const registry = {
  roles: {
    'code-quality-reviewer': role('code-quality-reviewer', { workerClass: 'gemini' }),
    'security-reviewer': role('security-reviewer', { workerClass: 'claude-code' }),
    'codex-reviewer': role('codex-reviewer', { workerClass: 'codex' }),
    remediator: role('remediator', { workerClass: 'codex', taskKind: 'remediation' }),
  },
  routing: { neverReviewOwnBuilderClass: true },
};

// clio-agent PRs are written by codex → a codex reviewer reviewing a clio-agent
// PR is self-review. The kernel stays free of that family table; the caller
// injects it.
const injectedFamily = (value) => {
  const token = String(value ?? '').trim().toLowerCase();
  if (token === '') return null;
  if (token === 'clio-agent') return 'codex';
  if (token === 'claude') return 'claude-code';
  return token;
};

// ---------------------------------------------------------------------------
// defaultBuilderClassFamily / roleReviewerClass
// ---------------------------------------------------------------------------

test('defaultBuilderClassFamily folds the claude alias and blanks empties', () => {
  assert.equal(defaultBuilderClassFamily('claude'), 'claude-code');
  assert.equal(defaultBuilderClassFamily('Claude-Code'), 'claude-code');
  assert.equal(defaultBuilderClassFamily('codex'), 'codex');
  assert.equal(defaultBuilderClassFamily('  '), null);
  assert.equal(defaultBuilderClassFamily(null), null);
});

test('roleReviewerClass returns the worker class, null for persona-backed roles', () => {
  assert.equal(roleReviewerClass(role('r', { workerClass: 'codex' })), 'codex');
  assert.equal(roleReviewerClass(role('r', { persona: 'sec-persona' })), null);
  assert.equal(roleReviewerClass(null), null);
});

// ---------------------------------------------------------------------------
// roleMayReviewSubject — the never-review-own-builder-class constraint
// ---------------------------------------------------------------------------

test('a role may not review a subject built by its own worker class', () => {
  const decision = roleMayReviewSubject({
    role: registry.roles['security-reviewer'],
    subjectBuilderClass: 'claude-code',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'own-builder-class');
});

test('the claude / claude-code alias is treated as the same builder class', () => {
  // A claude-code worker must not review a `claude`-tagged PR (and vice-versa).
  assert.equal(
    roleMayReviewSubject({ role: registry.roles['security-reviewer'], subjectBuilderClass: 'claude' }).allowed,
    false,
  );
});

test('a role may review a subject of a different builder class', () => {
  const decision = roleMayReviewSubject({
    role: registry.roles['security-reviewer'],
    subjectBuilderClass: 'codex',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'cross-class');
});

test('persona-backed roles are exempt from the builder-class identity constraint', () => {
  const decision = roleMayReviewSubject({
    role: role('sec', { persona: 'security-persona' }),
    subjectBuilderClass: 'claude-code',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'role-has-no-worker-class');
});

test('a subject with no builder class is never blocked (kernel never blocks on missing data)', () => {
  const decision = roleMayReviewSubject({
    role: registry.roles['codex-reviewer'],
    subjectBuilderClass: null,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'subject-has-no-builder-class');
});

test('disabling the constraint allows same-class review', () => {
  const decision = roleMayReviewSubject({
    role: registry.roles['codex-reviewer'],
    subjectBuilderClass: 'codex',
    neverReviewOwnBuilderClass: false,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'constraint-disabled');
});

test('an injected family map extends the constraint (clio-agent writer is codex)', () => {
  // Without the family map, codex ≠ clio-agent and review would be allowed.
  assert.equal(
    roleMayReviewSubject({ role: registry.roles['codex-reviewer'], subjectBuilderClass: 'clio-agent' }).allowed,
    true,
  );
  // With it, codex reviewing a clio-agent PR is self-review and refused.
  const decision = roleMayReviewSubject({
    role: registry.roles['codex-reviewer'],
    subjectBuilderClass: 'clio-agent',
    builderClassFamily: injectedFamily,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'own-builder-class');
});

// ---------------------------------------------------------------------------
// selectEligibleReviewerRoles
// ---------------------------------------------------------------------------

test('selectEligibleReviewerRoles drops the own-class reviewer and the remediator', () => {
  const eligible = selectEligibleReviewerRoles({
    registry,
    subject: { builderClass: 'claude-code' },
  }).map((entry) => entry.roleId);
  // security-reviewer (claude-code) excluded by own-class; remediator excluded
  // because it is not a review role.
  assert.deepEqual(eligible, ['code-quality-reviewer', 'codex-reviewer']);
});

test('selectEligibleReviewerRoles reads builderClass from a SubjectState or a raw string', () => {
  const fromState = selectEligibleReviewerRoles({
    registry,
    subject: { builderClass: 'codex' },
  }).map((e) => e.roleId);
  const fromString = selectEligibleReviewerRoles({ registry, subject: 'codex' }).map((e) => e.roleId);
  assert.deepEqual(fromState, fromString);
  assert.ok(!fromState.includes('codex-reviewer'), 'codex reviewer excluded on a codex PR');
});

test('selectEligibleReviewerRoles sorts by explicit priority with registry-order ties', () => {
  const priorityRegistry = {
    roles: {
      slow: role('slow', { workerClass: 'gemini', priority: 80 }),
      fast: role('fast', { workerClass: 'claude-code', priority: 10 }),
      tied: role('tied', { workerClass: 'codex', priority: 10 }),
      implicit: role('implicit', { workerClass: 'merge-agent' }),
    },
    routing: { neverReviewOwnBuilderClass: true },
  };

  const eligible = selectEligibleReviewerRoles({
    registry: priorityRegistry,
    subject: { builderClass: 'builder' },
  }).map((e) => e.roleId);

  assert.deepEqual(eligible, ['fast', 'tied', 'slow', 'implicit']);
});

test('selectEligibleReviewerRoles honors a disabled constraint on the registry', () => {
  const permissive = { roles: registry.roles, routing: { neverReviewOwnBuilderClass: false } };
  const eligible = selectEligibleReviewerRoles({
    registry: permissive,
    subject: { builderClass: 'codex' },
  }).map((e) => e.roleId);
  assert.ok(eligible.includes('codex-reviewer'), 'same-class review allowed when constraint disabled');
});

test('selectEligibleReviewerRoles returns [] for a malformed registry', () => {
  assert.deepEqual(selectEligibleReviewerRoles({ registry: null, subject: 'codex' }), []);
  assert.deepEqual(selectEligibleReviewerRoles({ registry: {}, subject: 'codex' }), []);
});
