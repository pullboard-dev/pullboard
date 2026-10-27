#!/usr/bin/env node
/** Verify an authenticated recorded receipt for the exact tagged commit before hosted npm OIDC publication [I15]. */
import { parseArgs } from 'node:util';
import { verifyHostedRelease } from '../src/release-hosted.js';

try {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, head: { type: 'string' }, run: { type: 'string' } }, allowPositionals: false });
  const result = await verifyHostedRelease(process.cwd(), { repository: values.repository, head: values.head, runId: values.run });
  console.log(`recorded release receipt verified for ${values.head}: ${result.receipt.participation.required.length} executors; GitHub run ${result.provenance.runId}, artifact ${result.provenance.artifactId}`);
} catch (error) {
  console.error(error?.message ?? 'release receipt verification failed');
  process.exitCode = error?.exitCode === 3 ? 3 : 1;
}
