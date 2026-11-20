// Fixture homes have no global Git config. Replace inherited command config
// so neither host settings nor stale indexed entries affect offline Git.
export function fixtureGitEnv(env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) =>
      key !== 'GIT_CONFIG_PARAMETERS' && !/^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/.test(key))),
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
    GIT_CONFIG_KEY_2: 'gc.autoDetach', GIT_CONFIG_VALUE_2: 'false',
  };
}
