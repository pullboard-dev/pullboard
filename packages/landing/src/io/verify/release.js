#!/usr/bin/env node
/** Verify an authenticated recorded receipt for the exact tagged commit before hosted npm OIDC publication [I15]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHostedRelease } from '../../../../sandbox/index.js';
import { runAccept } from '../../../../gate/heavy.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAccept(process.cwd(), process.argv.slice(2), { services: { verifyHostedRelease } });
}
