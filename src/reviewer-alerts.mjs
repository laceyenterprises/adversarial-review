// Reviewer operator alerts.
//
// Extracted from reviewer.mjs under the ARC-10 decomposition gate, which caps
// that file's line count and ratchets down, never up. These two paths are
// self-contained -- their only dependency is the shared alert bus -- so they are
// a natural seam.
//
// Both used to POST a hardcoded http://127.0.0.1:8787/hooks/wake with no auth
// header. Nothing listens on 8787; the supported bus is DEFAULT_ALERT_BUS_URL
// (:18799) in alert-delivery.mjs, which is config-resolved and supplies the
// hooks token. Every page therefore failed silently -- 136 of them by
// 2026-08-11 -- while the gemini reviewer lane was dark. deliverAlert queues to
// the durable sink and schedules a drain, so a briefly unreachable bus no longer
// drops the page.

import { deliverAlert } from './alert-delivery.mjs';

/**
 * Alert the operator when OAuth credentials are unavailable.
 *
 * Routes through the shared alert-delivery bus (`deliverAlert`) rather than
 * curling a hook URL directly. This used to POST a hardcoded
 * `http://127.0.0.1:8787/hooks/wake` with no auth header. Nothing listens on
 * 8787 — the supported bus is `DEFAULT_ALERT_BUS_URL` (:18799) and is
 * config-resolved — so every one of these pages failed silently for weeks
 * (136 of them by 2026-08-11) while the gemini reviewer lane was down. The
 * reviewer-stopped page is the one signal that says "reviews are dark", so it
 * must not be best-effort fire-and-forget: deliverAlert queues to the durable
 * sink and schedules a drain, so it survives a bus that is briefly unreachable.
 */
async function alertClioOAuthFailure(model, repo, prNumber, reason, {
  deliverAlertImpl = deliverAlert,
} = {}) {
  const msg = `🔐 Adversarial reviewer STOPPED — ${model} OAuth credentials unavailable.\n\nRepo: ${repo} PR #${prNumber}\nReason: ${reason}\n\nAction needed: re-authenticate ${model} (run the CLI and log in). PR review is paused until credentials are restored.`;
  console.error(`[reviewer] ALERT: ${msg}`);
  try {
    const result = await deliverAlertImpl(msg, {
      event: 'reviewer.oauth_unavailable',
      payload: { model, repo, prNumber, reason },
    });
    console.log(`[reviewer] reviewer-stopped alert queued via alert bus (id=${result?.id ?? 'unknown'})`);
    return result;
  } catch (err) {
    console.error('[reviewer] Failed to queue reviewer-stopped alert:', err.message);
    return null;
  }
}

async function alertClioOversizedAgyFailure({
  repo,
  prNumber,
  promptBytes,
  maxBytes,
  reason,
}, {
  deliverAlertImpl = deliverAlert,
} = {}) {
  const msg = `Adversarial reviewer oversized agy prompt could not be reviewed.\n\nRepo: ${repo} PR #${prNumber}\nPrompt bytes: ${promptBytes ?? 'unknown'}\nAgy argv budget: ${maxBytes ?? 'unknown'}\nReason: ${reason}\n\nThis is the #3074/#3122/#3124 no-review prevention guard; operator action is required because both cross-model routing and chunk fallback were unavailable.`;
  console.error(`[reviewer] ALERT: ${msg}`);
  try {
    // Same dead-hook fix as alertClioOAuthFailure above: this posted to the
    // hardcoded :8787 hook. deliverAlert supplies the config-resolved bus URL
    // and hooks token, and its queue+drain replaces the local curl retry loop.
    const result = await deliverAlertImpl(msg, {
      event: 'reviewer.oversized_agy_prompt',
      payload: { repo, prNumber, promptBytes, maxBytes, reason },
    });
    console.log(`[reviewer] oversized agy prompt alert queued via alert bus (id=${result?.id ?? 'unknown'})`);
    return result;
  } catch (err) {
    console.error('[reviewer] Failed to queue oversized agy prompt alert:', err.message);
    return null;
  }
}

export {
  alertClioOAuthFailure,
  alertClioOversizedAgyFailure,
};
