#!/usr/bin/env node
/** Compose the trusted private checker in each actual landing guardian/worker process [B3,V4,Q1,Q3]. */
import { fileURLToPath } from 'node:url';
import { landingWorkerEntry } from '../packages/landing/index.js';
import { parseProcessCensus } from '../packages/kernel/src/core/process-census.js';
const FILE = fileURLToPath(import.meta.url);
if (process.argv[1] === FILE && process.send) {
  // The guardian installs its original watchdog without loading the private-check executor.
  if (process.argv[2] === 'guardian') landingWorkerEntry({ workerFile: FILE, parseProcessCensus });
  else if (process.argv[2] === 'worker') {
    const { openBoard } = await import('../src/native-board.js');
    const { checkAtCommit } = await import('../src/runner-private-check.js');
    const { badgeCounts, writeBadges } = await import('../src/badge.js');
    const { flakeLedger } = await import('../packages/flakes/index.js');
    const { flakeSource, observeNativeFailure } = await import('../packages/flakes/index.js');
    const { landingFlakeRatchet } = await import('../packages/flakes/index.js');
    const { quarantineWaivers, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns } = await import('../packages/flakes/index.js');
    const landingPorts = { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet };
    landingWorkerEntry({ checkAtCommit, landingPorts, parseProcessCensus, openBoard, workerFile: FILE,
      candidateWorkerFile: fileURLToPath(new URL('./landing-candidate.js', import.meta.url)) });
  }
}
