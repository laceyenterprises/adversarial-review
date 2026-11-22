const sameRepository = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.trim() !== '' && left.trim().toLowerCase() === right.trim().toLowerCase();

// MRQ-20: `required_check_contexts` applies to every repository.
// `required_check_contexts_by_repository` binds contexts to one repository, so
// a check that only one repository runs never reads as missing in another.
// Callers without a repository keep the global list only (pre-MRQ-20 shape).
export function resolveRequiredCheckContextsFromCfg(cfg, { repository } = {}) {
  const contexts = cfg?.getMergeAuthorityConfig?.()?.requiredCheckContexts ?? cfg?.requiredCheckContexts;
  const global = Array.isArray(contexts) ? contexts : [];
  if (repository == null) return global;
  return [...new Set([...global, ...resolveRepositoryRequiredCheckContexts(cfg, repository)])];
}

// The repository-scoped half alone. Empty when nothing is declared for it.
export function resolveRepositoryRequiredCheckContexts(cfg, repository) {
  const entries = cfg?.getMergeAuthorityConfig?.()?.requiredCheckContextsByRepository
    ?? cfg?.requiredCheckContextsByRepository;
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries
    .filter(entry => sameRepository(entry?.repository, repository) && Array.isArray(entry.contexts))
    .flatMap(entry => entry.contexts)
    .filter(context => typeof context === 'string' && context.trim() !== '')
    .map(context => context.trim()))];
}
