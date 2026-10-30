// GTMGAWIRE-01: mirror agent_os_config.schema_v1.google_tokens.
// This reader accepts non-secret host metadata only; it never mints a token.
export const GOOGLE_TOKEN_SCOPES = [
  'tagmanager.readonly', 'tagmanager.edit.containers',
  'tagmanager.edit.containerversions', 'tagmanager.publish',
  'analytics.readonly', 'analytics.edit',
];

export function googleTokensSchema() {
  const record = keys => ({ __type: 'dict', __strict: true, __strict_always: true, __keys: keys });
  const text = pattern => ({ __type: 'string', __nullable: false, ...(pattern ? { __pattern: pattern } : {}) });
  const scopes = () => ({ __type: 'list', __item: { __type: 'string', __enum: GOOGLE_TOKEN_SCOPES }, __default: [] });
  const profile = record({
    enabled: { __type: 'bool', __default: false },
    document_ref: text(String.raw`^op-document://[^/\s?#%]+/[^/\r\n?#%]+$`),
    service_account_email: text('^[a-z0-9-]+@lacey-web[.]iam[.]gserviceaccount[.]com$'),
    project_id: { __type: 'string', __enum: ['lacey-web'] },
    allowed_scopes: scopes(),
    read_worker_classes: { __type: 'list', __item: text(), __default: [] },
    task_grants: {
      __type: 'list', __default: [],
      __item: record({
        lrq: text('^lrq[_-][A-Za-z0-9_-]+$'),
        worker_class: text(),
        scopes: scopes(),
      }),
    },
  });
  return record({
    profiles: { __type: 'dict', __strict: false, __keys: {}, __extra_keys_schema: profile, __default: {} },
  });
}
