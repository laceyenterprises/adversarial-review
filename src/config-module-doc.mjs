// ONS-07 — validation of one module config document (layer 2 of the cascade).
import { schemaV1 } from './config-schema.mjs';
import { TOKEN_POOL_DECLARATION_PATHS } from './config-token-pools.mjs';
import { AgentOSConfigError, TYPE_DICT, configDebugLog } from './config-base.mjs';
import { buildLineMap, jsTypeName, validateDictPresentKeysOnly } from './config-checks.mjs';
import { flatten, isValidSchemaPath, sameValue, schemaLeaf, setLeaf } from './config-paths.mjs';
import { validateOsgShape } from './config-policies.mjs';

export function validateModuleDoc(
  doc,
  source,
  rawText,
  {
    tolerateUnknown = false,
    preserveEmptyMaps = false,
    warnUnknownOnce = false,
    droppedUnknownKeys = null,
  } = {},
) {
  if (doc === null || doc === undefined) return { validated: {}, aliases: {} };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AgentOSConfigError(
      `${source}: top-level YAML must be a mapping, got ${jsTypeName(doc)}`,
      { source },
    );
  }
  if ('version' in doc) {
    throw new AgentOSConfigError(
      `${source}: module config.yaml must NOT declare \`version\` (top-level lock only)`,
      { key: 'version', source },
    );
  }
  const schema = schemaV1();
  const aliasesRaw = doc.__aliases || {};
  if (typeof aliasesRaw !== 'object' || Array.isArray(aliasesRaw)) {
    throw new AgentOSConfigError(
      `${source}: __aliases must be a mapping`,
      { key: '__aliases', expected: 'mapping', got: jsTypeName(aliasesRaw), source },
    );
  }
  const aliases = {};
  const unreadAliases = new Set();
  const schemaForAliasCheck = schemaV1();
  for (const [moduleKey, canonicalKey] of Object.entries(aliasesRaw)) {
    if (typeof moduleKey !== 'string' || typeof canonicalKey !== 'string') {
      throw new AgentOSConfigError(
        `${source}: __aliases entries must map string→string (${JSON.stringify(moduleKey)}→${JSON.stringify(canonicalKey)})`,
        { source },
      );
    }
    if (!isValidSchemaPath(schemaForAliasCheck, canonicalKey)) {
      const parts = canonicalKey.split('.');
      const consumedAtomicPath = [...TOKEN_POOL_DECLARATION_PATHS]
        .some(path => canonicalKey.startsWith(`${path}.`))
        || parts.some((_, index) =>
          schemaLeaf(schemaForAliasCheck, parts.slice(0, index + 1).join('.'))?.__strict_always);
      if (!consumedAtomicPath) {
        unreadAliases.add(moduleKey);
        configDebugLog(`ignoring alias ${JSON.stringify(moduleKey)} to unread key ${JSON.stringify(canonicalKey)}`);
        continue;
      }
      throw new AgentOSConfigError(
        `${source}: __aliases canonical key ${JSON.stringify(canonicalKey)} (target of ${JSON.stringify(moduleKey)}) is not in the schema`,
        {
          key: canonicalKey,
          expected: 'known canonical schema key',
          got: canonicalKey,
          source,
        },
      );
    }
    aliases[moduleKey] = canonicalKey;
  }

  const body = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== '__aliases') body[k] = v;
  }

  // Local overrides preserve accepted empty maps; unknown empty maps retain
  // their historical drop behavior, and module normalization stays unchanged.
  // Preserve the strict search subtree until schema validation, including
  // metadata-prefixed keys and empty maps that generic flattening drops.
  const atomicPaths = new Set([...TOKEN_POOL_DECLARATION_PATHS, 'services.hcp.search']);
  const rawFlat = flatten(body, '', (key) =>
    preserveEmptyMaps && isValidSchemaPath(schema, aliases[key] || key),
    new Set([
      ...atomicPaths,
      ...Object.entries(aliases).filter(([, canonical]) => atomicPaths.has(canonical)).map(([key]) => key),
    ]),
  );
  for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
    if (moduleKey in rawFlat && canonicalKey in rawFlat) {
      const mv = rawFlat[moduleKey];
      const cv = rawFlat[canonicalKey];
      if (!sameValue(mv, cv)) {
        if (TOKEN_POOL_DECLARATION_PATHS.has(canonicalKey)) {
          throw new AgentOSConfigError(
            `${source}: ${canonicalKey}: conflicting declarations; set one only`,
            { key: canonicalKey, expected: 'single declaration', source },
          );
        }
        throw new AgentOSConfigError(
          `${source}: same-file alias conflict — ${moduleKey}=${JSON.stringify(mv)} but ${canonicalKey}=${JSON.stringify(cv)}; set one only`,
          {
            key: canonicalKey,
            expected: 'single value or matching across aliased keys',
            got: `${moduleKey}=${JSON.stringify(mv)}, ${canonicalKey}=${JSON.stringify(cv)}`,
            source,
          },
        );
      }
    }
  }

  const canonicalFlat = {};
  for (const [key, value] of Object.entries(rawFlat)) {
    if ([...unreadAliases].some(alias => key === alias || key.startsWith(`${alias}.`))) continue;
    const canonical = aliases[key] || key;
    canonicalFlat[canonical] = value;
  }

  const canonicalBody = {};
  for (const [dotted, value] of Object.entries(canonicalFlat)) {
    setLeaf(canonicalBody, dotted, value);
  }

  if (Object.hasOwn(canonicalBody, 'osg')) validateOsgShape(canonicalBody.osg, source);
  const moduleSchema = {
    __type: TYPE_DICT,
    __strict: schema.__strict,
    __keys: {},
  };
  for (const [k, v] of Object.entries(schema.__keys)) {
    if (k !== 'version') moduleSchema.__keys[k] = v;
  }
  const lineMap = rawText ? buildLineMap(rawText, Object.keys(moduleSchema.__keys)) : null;
  const validated = validateDictPresentKeysOnly(
    canonicalBody,
    moduleSchema,
    '',
    source,
    lineMap,
    tolerateUnknown,
    {
      warnUnknownOnce,
      warningSource: source,
      droppedUnknownKeys,
    },
  );
  return { validated, aliases };
}
