import { renderHammerBootstrap } from '../../src/hammer-procedure.mjs';

// Downstream phase fixtures own their synthetic head and do not need live
// bootstrap reads. Use the inputs body from the same renderer as dispatch.
export function hammerBootstrapInputs(values) {
  return renderHammerBootstrap(values).match(/<<'HAM_INPUTS'[^\n]*\n([\s\S]*?\n)HAM_INPUTS/)[1];
}
