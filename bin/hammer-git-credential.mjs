#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hammerTokenSession, GIT_CREDENTIAL_REFRESH_FAILED } from '../src/hammer-token.mjs';

// Git invokes get/store/erase. Never persist credentials, and never echo input
// or refresh diagnostics. The password travels only over Git's credential pipe.
if (process.argv[2] === 'get') {
  const fields = Object.fromEntries(readFileSync(0, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (fields.protocol === 'https' && fields.host === 'github.com') {
    try {
      const token = hammerTokenSession({ hammerToken: true }).gitCredential();
      process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
    } catch {
      process.stderr.write(`${GIT_CREDENTIAL_REFRESH_FAILED}\n`);
      process.exitCode = 1;
    }
  }
}
