function domainRequiresMcpOAuth(domainConfig = {}) {
  const candidates = [
    domainConfig.requiresMcpOAuth,
    domainConfig.requiredMcpOAuth,
    domainConfig.mcpOAuth,
    domainConfig.mcpServers,
    domainConfig.requiredMcpServers,
    domainConfig.codexMcpServers,
  ];
  const flattened = [];
  const collect = (value) => {
    if (value == null || value === false) return;
    if (value === true) {
      flattened.push('linear');
      return;
    }
    if (typeof value === 'string') {
      flattened.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        flattened.push(key);
        collect(item);
      }
    }
  };
  for (const value of candidates) collect(value);
  return flattened.some((value) => String(value || '').trim().length > 0);
}

export { domainRequiresMcpOAuth };
