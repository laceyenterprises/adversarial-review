# Data Model - OSG Remediator Route Observations

**Owner:** Remediator execution routing
**Store:** `<adversarial review state dir>/osg-remediator/<uuid>.json`
**Source of truth:** `src/osg-remediator.mjs`

The state directory defaults to `<rootDir>/data` and honors
`ADVERSARIAL_REVIEW_STATE_DIR` through the shared state-directory resolver.
Each active-mode attempt atomically writes an independent UUID-named JSON file.
Off mode performs no observation I/O. Failure to persist an applied arm retains
the default route. These observations grant no admission or merge authority.

| Field | Shape | Contract |
|---|---|---|
| `version` | number | `1`. |
| `repo`, `prNumber`, `kind` | string, number, string | PR subject and `hammer` or `remediator` execution kind. |
| `recordedAt` | ISO timestamp | Local observation time. |
| `reason` | string | Bounded route reason; errors use `error-remediator-route` without exception text. |
| `defaultWorkerClass` | optional string | Caller-owned default class; absent in error observations. |
| `assignment` | optional object | Ledger assignment when available, including assignment identity, mode and propensity. |
| `arm` | optional object | Applied catalog arm with role, harness, worker class, model, effort and account. |
| `accountProposal` | optional object | Applied account identity, tokenAccountId and evidenceGeneration when available. A proposal is not a lease. |

Follow-up worker and closer dispatch records retain the same observation as
`osgRemediator`; the closer AMA audit retains it under `harnessResolution` and
each attempt's harness resolution. Managed dispatch owns authoritative account
bindings. See [the execution contract](../OSG-remediator-execution.md).
