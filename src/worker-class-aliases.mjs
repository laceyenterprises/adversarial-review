// Published compatibility vocabulary owned by agent_os_core.worker_class_aliases.
// This reads spelling only; it grants no capability, account lease or authority.
import { readFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync(new URL('./worker-class-aliases.v1.json', import.meta.url)));
if (contract.version !== 1) throw new Error('unsupported worker class alias vocabulary');
export const CLASS_ALIASES = Object.freeze(Object.fromEntries(Object.entries(contract.aliases)
  .map(([name, pair]) => [name, Object.freeze(pair)])));
export const canonicalWorkerClass = name => Object.hasOwn(CLASS_ALIASES, name) ? CLASS_ALIASES[name][0] : name;
export function expandClassAliases(names) {
  return names.flatMap(role => [role, ...Object.entries(CLASS_ALIASES)
    .filter(([, [canonical]]) => canonical === role).map(([name]) => name)]);
}

export function expandClassAliasRecord(record) {
  return Object.fromEntries(Object.entries(record).flatMap(([role, value]) =>
    expandClassAliases([role]).map(name => [name, value])));
}
