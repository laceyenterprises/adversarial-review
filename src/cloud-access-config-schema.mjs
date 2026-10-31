// ZFA-01 parse-only mirror of agent-os schema_v1/cloud_access.py.
// No reviewer consumer or cloud authentication is introduced here.
export function cloudAccessConfigSchema() {
  const object = (__keys) => ({ __type: 'dict', __strict: true, __keys });
  const text = () => ({ __type: 'string' });
  return object({
    enabled: { __type: 'bool', __default: false },
    aws: object({
      enabled: { __type: 'bool', __default: false },
      region: { __type: 'string', __enum: ['us-east-2'], __default: 'us-east-2' },
      project_ref: text(),
      role_arn: text(),
      default_profile_arn: text(),
      trust_anchor_arn: text(),
      helper_path: text(),
      signed_helper_sha256: text(),
      materialization_directory: text(),
      client_ref: text(),
      host_uri: text(),
      ca_fingerprint: text(),
      budget_topic_arn: text(),
      budget_name: text(),
      activation_receipt_path: text(),
      activation_public_key_path: text(),
    }),
    azure: object({
      enabled: { __type: 'bool', __default: false },
      tenant_id: text(),
      subscription_id: text(),
      region: { __type: 'string', __enum: ['eastus2'], __default: 'eastus2' },
      infrastructure: object({
        operator_object_id: text(),
        audit_storage_account_name: text(),
        default_certificate_path: text(),
        deploy_certificate_path: text(),
        budget_email: text(),
        budget_start_date: text(),
        budget_amount: { __type: 'float', __min: 0.01 },
        workspace_daily_quota_gb: { __type: 'float', __min: 0.01 },
        workload_storage_accounts: {
          __type: 'list', __default: [],
          __item: object({
            resource_id: { __type: 'string', __required: true },
            review_ref: { __type: 'string', __required: true },
          }),
        },
      }),
    }),
  });
}
