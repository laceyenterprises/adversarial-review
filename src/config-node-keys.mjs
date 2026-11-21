// ONS-07 — the only hand-written schema left in the Node config reader.
//
// Everything else comes from the generated CFG JSON Schema
// (./config-schema.mjs). Entries here may only ADD paths CFG lacks; the
// builder throws at import if CFG starts declaring one, so a key moved into
// CFG must be deleted here in the same change.

// Annotations the ONS-02 projection (agent-os
// platform/contracts/src/agent_os_contracts/cfg_schema.py) drops. Python
// declares these; restoring them is not a Node-only key. Delete each one when
// the projection emits it.
// - `__strict_always` is folded into `additionalProperties: false`, so the
//   consumed atomic policies below lose their fail-closed marker.
// - A strict-always map with typed extra keys is projected as a closed empty
//   object, which would reject every search operation limit and every
//   public-hygiene identity.
const SEARCH_PROVIDERS = ['brave', 'exa', 'firecrawl', 'parallel', 'perplexity', 'tavily'];
const SEARCH_COUNT_LIMITS = ['max_results', 'max_pages', 'max_urls', 'max_input_tokens', 'max_output_tokens', 'max_duration_seconds'];
const searchLimit = () => ({
  __type: 'dict',
  __strict: true,
  __keys: {
    ...Object.fromEntries(SEARCH_COUNT_LIMITS.map(key => [key, {
      __type: 'int', __min: 1, __max: key === 'max_duration_seconds' ? 86400 : 1000000000,
    }])),
    max_charge_usd: { __type: 'string', __pattern: '^[0-9]{1,12}([.][0-9]{1,9})?$' },
    product_authorized: { __type: 'bool' },
    currency: { __type: 'string', __enum: ['USD'] },
    pricing_provenance: { __type: 'string', __pattern: String.raw`^\S[^\r\n]{0,511}$` },
    research_effort: { __type: 'string', __enum: ['low', 'medium', 'high'] },
    processor: { __type: 'string', __pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
});

export const PROJECTION_REPAIRS = {
  ...Object.fromEntries(SEARCH_PROVIDERS.map(provider => [
    `services.hcp.search.providers.${provider}.operation_limits.*`, searchLimit(),
  ])),
  'worker_pool.public_hygiene.identities.*': {
    __type: 'dict',
    __strict: true,
    __keys: {
      name: { __type: 'string', __required: true },
      email: { __type: 'string', __required: true },
    },
  },
};

export const STRICT_ALWAYS_PATHS = [
  'services.hcp.search',
  'services.hcp.search.providers',
  ...SEARCH_PROVIDERS.flatMap(provider => [
    `services.hcp.search.providers.${provider}`,
    `services.hcp.search.providers.${provider}.operation_limits`,
    `services.hcp.search.providers.${provider}.operation_limits.*`,
  ]),
  'services.hcp.google_tokens',
  'services.hcp.google_tokens.profiles.*',
  'services.hcp.google_tokens.profiles.*.task_grants[]',
  'worker_pool.public_hygiene',
  'worker_pool.public_hygiene.identities',
  'worker_pool.public_hygiene.identities.*',
];

// Node-only enum members this service dispatches on and CFG does not list
// yet (gemini remediation, the hammer-claude closer, the codex-corp fallback
// alias). Same rule as the keys below: move into CFG or delete.
export const NODE_ONLY_ENUM_MEMBERS = {
  'roles.remediator': { members: ['gemini'] },
  'roles.remediator_fallback[]': { members: ['codex-corp'], normalize: { 'codex-corp': 'remediator-codex-corp' } },
  'roles.merge_agent_worker_class': { members: ['hammer-claude'] },
};

// Node-only keys: read by this service, absent from CFG. Most are reached
// through env aliases or operator-local overlays, because the Python loader
// refuses them in checked-in YAML. Each one must move into CFG `schema_v1`
// (with config.yaml and shell parity) or be deleted; ONS-07 deleted the
// unread ones. Count: 32 paths.
const int = (defaultValue, min, extra = {}) => ({ __type: 'int', __default: defaultValue, ...(min === undefined ? {} : { __min: min }), ...extra });
const nullableInt = min => int(null, min, { __nullable: true });
const bool = defaultValue => ({ __type: 'bool', __default: defaultValue });

const gitIdentityField = () => ({
  __type: 'string',
  __pattern: '^(?=[^\\u0000\\r\\n<>]*\\S)[^\\u0000\\r\\n<>]+$',
  __pattern_description: 'non-blank text without NUL, CR, LF, "<" or ">"',
});

export const NODE_ONLY_KEYS = {
  review_cycle_cap: int(5, 1),
  review_cycle_window_hours: int(24, 1),
  remediation: {
    __type: 'dict',
    __strict: true,
    __keys: {
      max_concurrent_jobs: int(1, 1), max_concurrent_jobs_ceiling: int(8, 1),
      // RDXREMIDENTITY-02 landed after this generated-reader branch forked.
      // Retain its repository and worker keyed identity contract here until
      // the canonical CFG schema declares it.
      git_identity_repo_overrides: {
        __type: 'dict', __strict: false, __default: {},
        __extra_keys_schema: {
          __type: 'dict', __strict: false,
          __extra_keys_schema: {
            __type: 'dict', __strict: true,
            __keys: { name: gitIdentityField(), email: gitIdentityField() },
          },
        },
      },
    },
  },
  'adversarial.reviewer.load_aware': {
    __type: 'dict',
    __strict: true,
    __keys: {
      enabled: bool(true),
      max_multiplier: { __type: 'float', __default: 6, __min: 1, __max: 20 },
    },
  },
  'feature_flags.dismiss_stale_request_changes_on_resolved': bool(true),
  'roles.registry': {
    __type: 'dict',
    __strict: false,
    __keys: {},
    __extra_keys_schema: {
      __type: 'dict',
      __strict: true,
      __keys: {
        ...Object.fromEntries(['promptSet', 'workerClass', 'persona', 'taskKind', 'completionShape']
          .map(key => [key, { __type: 'string', __default: '' }])),
        priority: nullableInt(0),
      },
    },
  },
  'roles.routing': {
    __type: 'dict',
    __strict: true,
    __keys: { 'never-review-own-builder-class': bool(true) },
  },
  'roles.adversarial.operator_logins': { __type: 'list', __item: { __type: 'string' }, __default: [] },
  'roles.adversarial.operator_label_actor_enforcement': {
    __type: 'string', __default: 'observe', __enum: ['observe', 'enforce'],
  },
  'roles.adversarial.merge_authority.strict_non_blocking_remediation': bool(true),
  'roles.adversarial.merge_authority.cap_rehead_enabled': bool(true),
  'roles.adversarial.merge_authority.cap_rehead_lifetime_cap': int(2, 0),
  'roles.adversarial.merge_authority.hammer_lifetime_dispatch_ceiling': nullableInt(0),
  'roles.adversarial.merge_authority.dispatch_timeout_ms': int(600000),
  'roles.adversarial.merge_authority.closer_inconclusive_retry': {
    __type: 'dict',
    __strict: true,
    __keys: {
      surface_after_attempts: int(3, 1),
      backoff_base_ms: int(300000, 1000),
      backoff_max_ms: int(3600000, 1000),
    },
  },
  'reviewer.quota_check_enabled': bool(true),
  'reviewer.quota_status_dir': { __type: 'string', __default: null, __nullable: true },
  'reviewer.timeout_ms': int(1200000),
  'reviewer.first_output_timeout_ms': int(0, 0),
  'reviewer.no_progress_timeout_ms': int(900000, 1000),
  'reviewer.running_pass_timeout_seconds': int(3600, 1),
  'reviewer.idle_timeout_seconds': int(600, 1),
  'reviewer.ceiling_base_seconds': int(1800, 1),
  'reviewer.ceiling_max_seconds': int(10800, 1),
  'watcher.ama_closer_max_concurrent_launches': int(3, 1),
  'watcher.max_drain_wait_ms': int(3600000, 1000),
  'watcher.pending_draft_review_respawn_age_seconds': int(900, 60),
  'watcher.stuck_dispatch_alert_debounce_ms': int(21600000, 60000),
  'watcher.first_pass_reviewer_pool_max_concurrent_reviewers': nullableInt(1),
  'watcher.first_pass_review_queue_depth_failover_threshold': nullableInt(1),
  'watcher.rereview_queue_depth_failover_threshold': nullableInt(0),
  'watcher.ama_hammer_dispatch_mode': { __type: 'string', __default: 'inline', __enum: ['inline', 'background'] },
};
