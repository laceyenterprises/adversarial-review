export function resolveRequiredCheckContextsFromCfg(cfg) {
  const contexts = cfg?.getMergeAuthorityConfig?.()?.requiredCheckContexts ?? cfg?.requiredCheckContexts;
  return Array.isArray(contexts) ? contexts : [];
}
