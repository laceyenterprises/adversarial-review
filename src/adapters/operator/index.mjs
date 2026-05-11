/**
 * Composite operator surface adapter.
 *
 * @typedef {import('../../kernel/contracts.d.ts').OperatorSurfaceAdapter} OperatorSurfaceAdapter
 */

import { createGitHubPRLabelControlsAdapter } from './github-pr-label-controls/index.mjs';
import { createLinearTriageAdapter } from './linear-triage/index.mjs';

function createCompositeOperatorSurface({
  controls = {},
  triage = {},
  ...shared
} = {}) {
  const controlsAdapter = createGitHubPRLabelControlsAdapter({
    ...shared,
    ...controls,
  });
  const triageAdapter = createLinearTriageAdapter({
    ...shared,
    ...triage,
  });
  return {
    ...controlsAdapter,
    ...triageAdapter,
  };
}

export {
  createCompositeOperatorSurface,
  createGitHubPRLabelControlsAdapter,
  createLinearTriageAdapter,
};
