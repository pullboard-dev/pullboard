#!/usr/bin/env node
/** Verify an authenticated recorded receipt for the exact tagged commit before hosted npm OIDC publication [I15]. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHostedRelease } from '../../../../sandbox/index.js';
import { releaseReceiptFields } from '../../../../gate/index.js';
import { releaseReceiptProblem } from '../../../../gate/index.js';
import { latestGitHubReleaseRun } from '../../../../gate/index.js';
import { readGitHubReleaseReceipt } from '../../../../gate/index.js';
import { ReleaseTransportError } from '../../../../gate/index.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, head: { type: 'string' }, run: { type: 'string' } }, allowPositionals: false });
  const result = await verifyHostedRelease(process.cwd(), { repository: values.repository, head: values.head, runId: values.run },
    { releaseReceiptFields, releaseReceiptProblem, latestGitHubReleaseRun, readGitHubReleaseReceipt, ReleaseTransportError });
  console.log(`recorded release receipt verified for ${values.head}: ${result.receipt.participation.required.length} executors; GitHub run ${result.provenance.runId}, artifact ${result.provenance.artifactId}`);
} catch (error) {
  console.error(error?.message ?? 'release receipt verification failed');
  process.exitCode = error?.exitCode === 3 ? 3 : 1;
}
