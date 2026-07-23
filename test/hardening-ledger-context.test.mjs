import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHardeningReviewContext,
  changedPathsFromDiff,
  isLowOrNoExposure,
  touchedContractsForPaths,
} from '../src/hardening-ledger-context.mjs';

const CONTRACTS = [
  {
    contract_id: 'session-ledger.dual-write-refused-under-test',
    summary: 'Session-ledger test mode refuses production dual-write DSNs.',
    locations: [
      { path: 'platform/session-ledger/src/session_ledger/db_dual_write.py' },
      { path: 'platform/session-ledger/tests/test_dual_write.py' },
    ],
  },
  {
    contract_id: 'worker-pool.deploy-checkout-tripwire',
    summary: 'Worker commits to the deploy checkout are blocked by the F2 tripwire.',
    locations: [
      { path: 'RUNBOOK-deploy-checkout.md' },
    ],
  },
];

function diffFor(path) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

test('changedPathsFromDiff extracts touched paths from a PR diff', () => {
  assert.deepEqual(changedPathsFromDiff(diffFor('platform/session-ledger/src/session_ledger/db_dual_write.py')), [
    'platform/session-ledger/src/session_ledger/db_dual_write.py',
  ]);
});

test('touchedContractsForPaths maps changed files to registered contract identities', () => {
  const touched = touchedContractsForPaths(
    ['platform/session-ledger/src/session_ledger/db_dual_write.py'],
    CONTRACTS,
  );
  assert.deepEqual(touched.map((contract) => contract.contract_id), [
    'session-ledger.dual-write-refused-under-test',
  ]);
  assert.deepEqual(touched[0].matchedPaths, [
    'platform/session-ledger/src/session_ledger/db_dual_write.py',
  ]);
});

test('diff touching a registered contract pulls that contract failure modes into review input', async () => {
  const context = await buildHardeningReviewContext(
    diffFor('platform/session-ledger/src/session_ledger/db_dual_write.py'),
    {
      loadContracts: async () => CONTRACTS,
      listRecords: async (contractId) => {
        assert.equal(contractId, 'session-ledger.dual-write-refused-under-test');
        return [
          {
            incident_ref: 'INCIDENT-2026-07-22-dual-write',
            failure_mode: 'Test-mode dual-write silently accepted a production DSN and wrote outside isolation.',
            regression_test_ref: 'platform/session-ledger/tests/test_dual_write.py::test_refuses_prod_dsn_under_test',
            exposure: { level: 'normal', samples: 3 },
          },
        ];
      },
      logger: null,
    },
  );

  assert.match(context, /Hardening Ledger contract context/);
  assert.match(context, /session-ledger\.dual-write-refused-under-test/);
  assert.match(context, /silently accepted a production DSN/);
  assert.match(context, /test_refuses_prod_dsn_under_test/);
});

test('diff touching no registered contract leaves review input unchanged', async () => {
  let recordReads = 0;
  const context = await buildHardeningReviewContext(diffFor('docs/unrelated.md'), {
    loadContracts: async () => CONTRACTS,
    listRecords: async () => {
      recordReads += 1;
      return [];
    },
    logger: null,
  });

  assert.equal(context, '');
  assert.equal(recordReads, 0);
});

test('low or missing exposure flags a contract for harsher review', async () => {
  assert.equal(isLowOrNoExposure({ level: 'low' }), true);
  assert.equal(isLowOrNoExposure({ samples: 0 }), true);
  assert.equal(isLowOrNoExposure({ level: 'normal', samples: 2 }), false);

  const context = await buildHardeningReviewContext(diffFor('RUNBOOK-deploy-checkout.md'), {
    loadContracts: async () => CONTRACTS,
    listRecords: async () => [
      {
        incident_ref: 'POSTMORTEM-2026-05-30',
        failure_mode: 'Worker commit protections only covered commit and missed push or branch-switch paths.',
        regression_test_ref: 'projects/deploy-checkout-boundary-hardening/harness/reproduce-deploy-checkout-wedge.sh',
        exposure: { level: 'low' },
      },
    ],
    logger: null,
  });

  assert.match(context, /apply harsher review/);
  assert.match(context, /under-exercised/);
  assert.match(context, /missed push or branch-switch paths/);
});
