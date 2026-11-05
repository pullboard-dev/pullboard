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
    const { openBoard: openNativeBoard } = await import('../apps/lib/index.js');
    const { LANDING_BOARD_BUSY_MS } = await import('../packages/landing/index.js');
    /** The lander waits out a seat's long write instead of ending a batch at the board's default 10 s [C7]. */
    const openBoard = (...args) => { const board = openNativeBoard(...args); board.db.exec(`PRAGMA busy_timeout = ${LANDING_BOARD_BUSY_MS}`); return board; };
    const { checkAtCommit } = await import('../apps/runner/index.js');
    const { badgeCounts, writeBadges } = await import('../apps/view/index.js');
    const { flakeLedger } = await import('../packages/flakes/index.js');
    const { flakeSource, observeNativeFailure } = await import('../packages/flakes/index.js');
    const { landingFlakeRatchet } = await import('../packages/flakes/index.js');
    const { quarantineWaivers, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns } = await import('../packages/flakes/index.js');
    const landingPorts = { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet };
    landingWorkerEntry({ checkAtCommit, landingPorts, parseProcessCensus, openBoard, workerFile: FILE,
      candidateWorkerFile: fileURLToPath(new URL('./landing-candidate.js', import.meta.url)) });
  }
}
