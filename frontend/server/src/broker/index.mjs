/**
 * The ARF token/identity-broker seam, as one import (ARF-07).
 *
 * ARF-05 (identity standup) and ARF-06 (harness standup) need exactly two
 * things from this subsystem — a broker, and the error class that means "this
 * role has no mapping" so a wizard step can render the refusal properly:
 *
 * ```js
 * import { openTokenBroker, UnmappedRoleError } from './broker/index.mjs';
 *
 * const broker = openTokenBroker(loadConfig());
 * const grant = await broker.resolveToken('the-hammer');   // throws if unmapped
 * await postAsBot(grant.token.use((token) => token));
 * ```
 *
 * Everything else — bundled vs external, JWT minting, PAT fallback, caching,
 * single-flight, secret resolution — is below this line and neither wizard has
 * to know about it.
 */

export {
  ArfBrokerError,
  AmbientIdentityRefusedError,
  BrokerConfigError,
  BrokerPermanentError,
  BrokerTransientError,
  SecretRefError,
  UnmappedRoleError,
} from './errors.mjs';

export {
  BROKER_MODES,
  BROKER_MODE_BUNDLED,
  BROKER_MODE_EXTERNAL,
  normalizeBrokerConfig,
} from './manifest.mjs';

export {
  SECRET_REF_SCHEMES,
  SecretRef,
  SecretValue,
  createSecretResolver,
  parseSecretRef,
} from './secrets.mjs';

export { createTokenBroker } from './token-broker.mjs';

import { createTokenBroker } from './token-broker.mjs';

/**
 * Build the broker for a loaded ARF config.
 *
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @param {object} [options] injection points (`resolveSecret`, `fetchImpl`,
 *   `now`, `logger`) — the same ones `createTokenBroker` takes
 */
export function openTokenBroker(config, options = {}) {
  return createTokenBroker({ config: config.broker, ...options });
}
