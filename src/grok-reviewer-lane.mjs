import { loadConfigCached } from './config-loader.mjs';
import { grokLaneEnabled } from './config-grok.mjs';

// Fail closed for this lane only when CFG cannot be read.
export function grokReviewerLaneEnabled({ env = process.env, loaderImpl = loadConfigCached } = {}) {
  try {
    const cfg = loaderImpl({ env });
    return grokLaneEnabled({
      grok: {
        enabled: cfg.get('grok.enabled', false),
        reviewer: { enabled: cfg.get('grok.reviewer.enabled', false) },
      },
    }, 'reviewer');
  } catch {
    return false;
  }
}
