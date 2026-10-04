import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfigCached } from '../config-loader.mjs';
import { loadDomainConfig } from '../domain-config.mjs';
import { resolveMergeAuthorityConfigFromDomain } from '../domain-policy.mjs';

// Use the same module and domain precedence as AMA closure orchestration.
export function loadEffectiveMergeAuthorityConfig({
  rootDir = fileURLToPath(new URL('../../', import.meta.url)),
  domainId = 'code-pr',
  loadConfigImpl = loadConfigCached,
} = {}) {
  const loaded = loadConfigImpl({ modulePaths: [join(rootDir, 'config.yaml')] });
  return resolveMergeAuthorityConfigFromDomain(loadDomainConfig(rootDir, domainId),
    loaded.getMergeAuthorityConfig(), { fallbackSources: loaded.sources || {} });
}
