export const fixtureWorkerClasses = Object.fromEntries([
  'codex-reviewer', 'claude-reviewer', 'gemini-reviewer',
  'remediator-codex', 'remediator-codex-corp', 'remediator-claude', 'remediator-gemini',
  'hammer', 'hammer-corp', 'hammer-claude', 'hammer-claude-corp', 'gemini',
].map(name => [name, {defaultModel: name.includes('claude') ? 'claude-opus-5-5'
  : name.includes('gemini') ? 'gemini-2.5-pro' : 'gpt-5.5',
  defaultReasoningLevel: 'high', allowedModels: name.includes('claude') ? ['claude-opus-5-5']
    : name.includes('gemini') ? ['gemini-2.5-pro', 'gemini-2.5-flash'] : ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'synthetic-model']} ]));

export function registryProducerSdk(sdk) {
  return {...sdk,
    async connect(config) { return {sessionToken: 'offline-registry-session', endpoint_url: config.endpoint_url}; },
    async readSessionHostServices(request) {
      if (request.action !== 'worker_registry') throw new Error('unexpected offline registry request');
      return {schema_version: 1, status: 'found', data: {classes: fixtureWorkerClasses}};
    },
    readHostServicesSync() { throw new Error('registry fixture requires async prefetch'); },
  };
}
