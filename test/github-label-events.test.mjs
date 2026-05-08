import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latestMatchingLabelEvent,
  latestMatchingScopedTimelineLabelEvent,
} from '../src/github-label-events.mjs';

test('latestMatchingLabelEvent returns the newest matching labeled event with actor', () => {
  const event = latestMatchingLabelEvent([
    {
      event: 'labeled',
      id: 1,
      label: { name: 'operator-approved' },
      actor: { login: 'OldOperator' },
      created_at: '2026-05-06T10:00:00.000Z',
    },
    {
      event: 'unlabeled',
      id: 2,
      label: { name: 'operator-approved' },
      actor: { login: 'Ignored' },
      created_at: '2026-05-06T10:30:00.000Z',
    },
    {
      event: 'labeled',
      id: 3,
      node_id: 'LE_3',
      label: { name: 'operator-approved' },
      actor: { login: 'VirtualPaul' },
      created_at: '2026-05-06T11:00:00.000Z',
    },
  ], 'operator-approved');

  assert.deepEqual(event, {
    id: '3',
    nodeId: 'LE_3',
    label: 'operator-approved',
    actor: 'VirtualPaul',
    createdAt: '2026-05-06T11:00:00.000Z',
    headSha: null,
    codeScopedAt: null,
  });
});

test('latestMatchingScopedTimelineLabelEvent only scopes labels applied after the current head', () => {
  const nodes = [
    {
      __typename: 'PullRequestCommit',
      id: 'commit-old',
      commit: {
        oid: 'oldsha',
        committedDate: '2026-05-06T10:00:00.000Z',
      },
    },
    {
      __typename: 'LabeledEvent',
      id: 'LE_stale',
      label: { name: 'operator-approved' },
      actor: { login: 'VirtualPaul' },
      createdAt: '2026-05-06T10:05:00.000Z',
    },
    {
      __typename: 'PullRequestCommit',
      id: 'commit-current',
      commit: {
        oid: 'abc123',
        committedDate: '2026-05-06T10:10:00.000Z',
      },
    },
  ];

  assert.equal(latestMatchingScopedTimelineLabelEvent(nodes, 'operator-approved', 'abc123'), null);

  const scoped = latestMatchingScopedTimelineLabelEvent([
    ...nodes,
    {
      __typename: 'LabeledEvent',
      id: 'LE_current',
      label: { name: 'operator-approved' },
      actor: { login: 'VirtualPaul' },
      createdAt: '2026-05-06T10:15:00.000Z',
    },
  ], 'operator-approved', 'abc123');

  assert.deepEqual(scoped, {
    id: 'LE_current',
    nodeId: 'LE_current',
    label: 'operator-approved',
    actor: 'VirtualPaul',
    createdAt: '2026-05-06T10:15:00.000Z',
    headSha: 'abc123',
    codeScopedAt: '2026-05-06T10:10:00.000Z',
    codeScopeEventId: 'commit-current',
    codeScopeEventKind: 'pull-request-commit',
  });
});
