#!/usr/bin/env node
/** Compose the trusted private checker in each actual landing guardian/worker process [B3,V4,Q1,Q3]. */
import { fileURLToPath } from 'node:url';
import { landingWorkerEntry } from '../src/landing-worker.js';
import { parseProcessCensus } from '../src/process-census.js';
const FILE = fileURLToPath(import.meta.url);
if (process.argv[1] === FILE && process.send) {
  // The guardian installs its original watchdog without loading the private-check executor.
  if (process.argv[2] === 'guardian') landingWorkerEntry({ workerFile: FILE, parseProcessCensus });
  else if (process.argv[2] === 'worker') {
    const { checkAtCommit } = await import('../src/runner-private-check.js');
    const { badgeCounts, writeBadges } = await import('../src/badge.js');
    const { flakeSource, observeNativeFailure } = await import('../src/native-flakes.js');
    const { quarantineWaivers } = await import('../src/quarantine.js');
    const landingPorts = { badgeCounts, writeBadges, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus };
    landingWorkerEntry({ checkAtCommit, landingPorts, parseProcessCensus, workerFile: FILE,
      candidateWorkerFile: fileURLToPath(new URL('./landing-candidate.js', import.meta.url)) });
  }
}
