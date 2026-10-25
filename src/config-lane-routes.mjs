// The one execution selector. Pure validation/resolution shared by loader and
// finalization boundaries; repository case folds, branch-ref case does not.
export function normalizeLaneRoutes(routes) {
  if (!Array.isArray(routes)) throw new TypeError('lane_routes requires a list');
  const seen = new Set();
  return routes.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'base,executor,repository'
      || typeof record.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository)
      || !['legacy', 'queue-v2'].includes(record.executor)) throw new TypeError('invalid lane_routes record');
    const { base } = record;
    if (typeof base !== 'string' || !base || base.startsWith('refs/') || base.startsWith('/')
      || base.endsWith('/') || base.endsWith('.') || base.includes('..') || base.includes('@{') || base === '@'
      || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(base)
      || base.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) throw new TypeError('invalid lane_routes base');
    const repository = record.repository.toLowerCase();
    const key = JSON.stringify([repository, base]);
    if (seen.has(key)) throw new TypeError('duplicate lane_routes lane');
    seen.add(key);
    return { repository, base, executor: record.executor };
  });
}

export function resolveLaneExecutor(routes, { repository, base }) {
  // Validate the requested lane with the same rules, including on legacy default.
  const lane = normalizeLaneRoutes([{ repository, base, executor: 'legacy' }])[0];
  return normalizeLaneRoutes(routes).find(r => r.repository === lane.repository && r.base === lane.base)?.executor ?? 'legacy';
}
