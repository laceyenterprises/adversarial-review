// GitHub returns these collections without a semantic ordering. Keep other
// arrays ordered, and retain every field so real gate changes still invalidate.
const UNORDERED_FIELDS = new Set(['labels', 'rollup', 'statusCheckRollup', 'requiredContexts', 'reasons']);

function stable(value, field) {
  if (Array.isArray(value)) {
    const items = value.map(item => stable(item));
    return UNORDERED_FIELDS.has(field)
      ? items.sort((left, right) => {
        const a = JSON.stringify(left), b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }) : items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], key)]));
}

export const closureGateFactsKey = value => JSON.stringify(stable(value));
