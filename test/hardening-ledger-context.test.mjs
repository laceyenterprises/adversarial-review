import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHardeningReviewContext,
  changedPathsFromDiff,
  isLowExposureRollup,
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
      getExposureRollup: async () => null,
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
    getExposureRollup: async () => null,
    logger: null,
  });

  assert.equal(context, '');
  assert.equal(recordReads, 0);
});

test('low or missing exposure flags a contract for harsher review', async () => {
  assert.equal(isLowOrNoExposure({ level: 'low' }), true);
  assert.equal(isLowOrNoExposure({ samples: 0 }), true);
  assert.equal(isLowOrNoExposure({ level: 'normal', samples: 2 }), false);
  assert.equal(isLowExposureRollup({ exposure_score: 0 }), true);
  assert.equal(isLowExposureRollup({ exposure_score: 80 }), false);

  const context = await buildHardeningReviewContext(diffFor('RUNBOOK-deploy-checkout.md'), {
    loadContracts: async () => CONTRACTS,
    getExposureRollup: async () => null,
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

test('live low exposure rollup raises review tier for touched contracts', async () => {
  const context = await buildHardeningReviewContext(diffFor('RUNBOOK-deploy-checkout.md'), {
    loadContracts: async () => CONTRACTS,
    getExposureRollup: async () => ({
      contract_id: 'worker-pool.deploy-checkout-tripwire',
      stood_up: false,
      smoked: false,
      hammered: false,
      operated_count: 0,
      last_exercised_at: null,
      exposure_score: 0,
    }),
    listRecords: async () => [
      {
        incident_ref: 'POSTMORTEM-2026-05-30',
        failure_mode: 'Deploy checkout tripwire missed one mutation path.',
        regression_test_ref: 'RUNBOOK-deploy-checkout.md',
        exposure: { level: 'normal', samples: 5 },
      },
    ],
    logger: null,
  });

  assert.match(context, /live exposure_score=0/);
  assert.match(context, /apply harsher review/);
});

test('live well-exposed rollup leaves review tier unchanged', async () => {
  const context = await buildHardeningReviewContext(diffFor('RUNBOOK-deploy-checkout.md'), {
    loadContracts: async () => CONTRACTS,
    getExposureRollup: async () => ({
      contract_id: 'worker-pool.deploy-checkout-tripwire',
      stood_up: true,
      smoked: true,
      hammered: true,
      operated_count: 8,
      last_exercised_at: '2026-07-24T18:00:00.000000Z',
      exposure_score: 85,
    }),
    listRecords: async () => [
      {
        incident_ref: 'POSTMORTEM-2026-05-30',
        failure_mode: 'Deploy checkout tripwire missed one mutation path.',
        regression_test_ref: 'RUNBOOK-deploy-checkout.md',
        exposure: { level: 'low' },
      },
    ],
    logger: null,
  });

  assert.match(context, /live exposure_score=85\./);
  assert.doesNotMatch(context, /apply harsher review/);
});
