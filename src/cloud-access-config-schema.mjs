// ZFA-01 parse-only mirror of agent-os schema_v1/cloud_access.py.
// No reviewer consumer or cloud authentication is introduced here.
export function cloudAccessConfigSchema() {
  const object = (__keys) => ({ __type: 'dict', __strict: true, __keys });
  const text = () => ({ __type: 'string' });
  return object({
    enabled: { __type: 'bool', __default: false },
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
