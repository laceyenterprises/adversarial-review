#!/usr/bin/env node
// Resolves OP_SERVICE_ACCOUNT_TOKEN via the canonical contract documented in
// tools/adversarial-review/DEPS.md and prints either the trimmed token to
// stdout (exit 0) or a single detailed diagnostic to stderr (exit 78,
// EX_CONFIG). Wrapper scripts call this to bootstrap the env before
// invoking node daemons.

import { formatResolveOpTokenDiagnostic, resolveOpToken } from './op.mjs';

const tag = process.env.ADV_OP_TOKEN_TAG || 'secret-source';
const result = resolveOpToken();
if (result.ok) {
  process.stdout.write(result.token);
  process.exit(0);
}
process.stderr.write(`${formatResolveOpTokenDiagnostic(result, { tag })}\n`);
process.exit(78);
