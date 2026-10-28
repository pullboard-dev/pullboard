#!/usr/bin/env node
/** Compose the trusted private checker in each actual landing guardian/worker process [B3,V4,Q1,Q3]. */
import { fileURLToPath } from 'node:url';
import { landingWorkerEntry } from '../src/landing-worker.js';
const FILE = fileURLToPath(import.meta.url);
if (process.argv[1] === FILE && process.send) {
  // The guardian installs its original watchdog without loading the private-check executor.
  if (process.argv[2] === 'guardian') landingWorkerEntry({ workerFile: FILE });
  else if (process.argv[2] === 'worker') {
    const { checkAtCommit } = await import('../src/runner-private-check.js');
    landingWorkerEntry({ checkAtCommit, workerFile: FILE,
      candidateWorkerFile: fileURLToPath(new URL('./landing-candidate.js', import.meta.url)) });
  }
}
