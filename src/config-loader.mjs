// agent-os-config — Node loader for the cross-language config surface (CFG).
//
// ONS-07: everything this reader knows about the config contract is generated
// from agent-os (ONS-02): the schema (./config-schema.mjs, from
// ./generated/config.schema.json) and the env alias table
// (./config-env-aliases.mjs, from ./generated/config.env.json). The reader
// declares no key, enum member or env name of its own. What remains is the
// cascade around the generated contract: code defaults -> module files ->
// top-level file -> profile overlay -> *.local.yaml -> env -> CLI, with
// validation that mirrors `agent_os_config.validation`, so both readers accept
// and reject the same documents (test/config-cfg-parity.test.mjs replays
// Python-recorded verdicts).
//
// Unknown keys fail `loadConfig` in checked-in files, as in Python. Local
// overlays and the runtime/cached loaders (`loadConfigRuntime`,
// `loadConfigCached`, `getConfig`, `loadConfigForIdentityTokenPool`) drop them,
// so a key from a newer schema cannot crash a lagging daemon;
// `__strict_always` policies never tolerate. Explicit `~` on a non-nullable key
// fails here as in Python. The Python merged-config checks for GCP profiles,
// legacy backup retention and retired Sentinel keys are not ported (this
// reader consumes none of them).
//
// This module is the public entry point. The reader is split by
// responsibility (config-base, -checks, -policies, -paths, -env-layer,
// -module-doc, -profile, -class, -cascade, -cache); importers keep using the
// names re-exported here.

import { schemaV1 } from './config-schema.mjs';
import { schemaLeaf } from './config-paths.mjs';

export { AgentOSConfigError, DEFAULT_TOP_LEVEL_PATH, SCHEMA_VERSION, resetRuntimeUnknownWarningCacheForTests } from './config-base.mjs';
export { configSignatureStatus, getConfig, loadConfigCached, loadGeminiReviewerConfigCached, resetConfigCache, resolutionTrace } from './config-cache.mjs';
export { loadConfig, loadConfigForIdentityTokenPool, loadConfigRuntime } from './config-cascade.mjs';
export { __testYamlHooks, validateSchema } from './config-checks.mjs';
export { AgentOSConfig } from './config-class.mjs';
export { ENV_ALIASES } from './config-env-aliases.mjs';
export { DEFAULT_PROFILE, OVERLAY_PROFILE, PROFILE_ENV } from './config-profile.mjs';

const schemaEnum = (dotted) => Object.freeze([...schemaLeaf(schemaV1(), dotted).__enum]);

export const ENUM_CODEX_WORKER_ACCOUNT_ORDER = schemaEnum('roles.codex_worker_account_order');
export const ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE = schemaEnum('roles.adversarial.orchestration_mode');
export const ENUM_ROLES_ADVERSARIAL_OPERATOR_LABEL_ACTOR_ENFORCEMENT = schemaEnum('roles.adversarial.operator_label_actor_enforcement');
export const ENUM_ROLES_ADVERSARIAL_MERGE_CAPABILITY_ENFORCEMENT = schemaEnum('roles.adversarial.merge_authority.merge_capability_enforcement');
