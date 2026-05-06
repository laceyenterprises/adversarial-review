import test from 'node:test';
import assert from 'node:assert/strict';

import { latestMatchingLabelEvent } from '../src/github-label-events.mjs';

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
  });
});
